// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HederaScheduleService} from "@hiero-ledger/hiero-contracts/schedule-service/HederaScheduleService.sol";
import {IAtsCollateralToken} from "./interfaces/IAtsCollateralToken.sol";
import {IHbarUsdOracle} from "./interfaces/IPyth.sol";
import {ReentrancyLock} from "./utils/ReentrancyLock.sol";

/// @title AtsCollateralRail
/// @notice A bilateral HBAR financing rail secured by one ATS partition hold.
/// @dev Native amounts are named tinybar because Hedera exposes HBAR to the EVM
/// in tinybar units. The configured oracle converts the HBAR cash leg only.
/// ATS nominal value is an underwriting input, not a secondary-market price.
contract AtsCollateralRail is HederaScheduleService, ReentrancyLock {
    enum PositionState {
        NONE,
        OPEN,
        REPAID,
        DEFAULTED
    }

    enum AutomationState {
        NONE,
        PENDING,
        COMPLETED,
        UNAVAILABLE
    }

    struct OfferTerms {
        address borrower;
        uint128 collateralAmount;
        uint128 principalUsdE8;
        uint16 annualRateBps;
        uint64 termSeconds;
        uint64 offerExpiresAt;
    }

    struct RailPolicy {
        uint16 maximumAdvanceBps;
        uint16 maximumAnnualRateBps;
        uint16 maximumQuoteMovementBps;
        uint64 minimumTermSeconds;
        uint64 maximumTermSeconds;
        uint64 maximumOfferLifetimeSeconds;
    }

    struct Position {
        address lender;
        address borrower;
        uint256 collateralAmount;
        uint256 holdId;
        uint256 principalTinybar;
        uint256 repaymentTinybar;
        uint64 openedAt;
        uint64 maturity;
        address scheduleAddress;
        PositionState state;
        AutomationState automation;
    }

    struct FundedOffer {
        address lender;
        OfferTerms terms;
        uint256 principalTinybar;
        uint256 quotePriceUsdE8;
        uint64 quotePublishTime;
        bool exists;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant TINYBAR_PER_HBAR = 100_000_000;
    // These constants are the kernel safety envelope. A deployed policy may be
    // stricter, but never more permissive.
    uint16 public constant MAX_ADVANCE_BPS = 7_000;
    uint16 public constant MAX_RATE_BPS = 10_000;
    uint16 public constant MAX_QUOTE_MOVEMENT_BPS = 100;
    uint64 public constant MIN_TERM = 2 minutes;
    uint64 public constant MAX_TERM = 365 days;
    uint64 public constant MAX_OFFER_LIFETIME = 24 hours;
    uint256 public constant HSS_GAS_LIMIT = 750_000;
    uint256 public constant HSS_RESERVE_TINYBAR = 5 * TINYBAR_PER_HBAR;
    int64 public constant HEDERA_SUCCESS = 22;
    uint8 private constant ATS_AUTHORIZED_HOLD = 1;

    IAtsCollateralToken public immutable atsToken;
    IHbarUsdOracle public immutable oracle;
    bytes32 public immutable partition;
    uint8 public immutable tokenDecimals;
    uint256 public immutable nominalValueUsdE8;
    address public immutable owner;
    uint16 public immutable maximumAdvanceBps;
    uint16 public immutable maximumAnnualRateBps;
    uint16 public immutable maximumQuoteMovementBps;
    uint64 public immutable minimumTermSeconds;
    uint64 public immutable maximumTermSeconds;
    uint64 public immutable maximumOfferLifetimeSeconds;

    uint256 public offerSequence;
    uint256 public cashLiabilities;
    uint256 public reservedAutomation;

    mapping(bytes32 offerId => FundedOffer offer) public offers;
    mapping(bytes32 positionId => Position position) public positions;
    mapping(address account => uint256 tinybarCredit) public credits;

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidPolicy();
    error InvalidTerms();
    error SelfDealing();
    error KycRequired(address account);
    error InsufficientCollateralCoverage(uint256 principalUsdE8, uint256 maximumUsdE8);
    error IncorrectFunding(uint256 suppliedTinybar, uint256 requiredTinybar);
    error OfferNotFound();
    error OfferExpired();
    error NotLender();
    error NotBorrower();
    error PositionNotOpen();
    error NotMatured(uint256 currentTime, uint256 maturity);
    error BeyondAssetMaturity(uint256 facilityMaturity, uint256 assetMaturity);
    error QuoteMoved(uint256 quotedTinybar, uint256 currentTinybar);
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientFreeBalance(uint256 available, uint256 required);
    error HoldCallFailed(bytes4 selector);
    error InvalidHold();
    error NothingToWithdraw();
    error NativeTransferFailed();
    error Insolvent(uint256 balance, uint256 required);
    error OwnerOnly();
    error SelfCallOnly();
    error DirectFundingDisabled();
    error AutomationFundsLocked(uint256 available, uint256 requested);

    event OfferFunded(
        bytes32 indexed offerId,
        address indexed lender,
        address indexed borrower,
        uint256 principalTinybar,
        uint256 quotePriceUsdE8
    );
    event OfferCancelled(bytes32 indexed offerId, address indexed lender, uint256 creditedTinybar);
    event PositionOpened(
        bytes32 indexed positionId, address indexed lender, address indexed borrower, uint256 holdId, uint256 maturity
    );
    event PositionRepaid(bytes32 indexed positionId, uint256 repaymentTinybar);
    event PositionDefaulted(bytes32 indexed positionId, uint256 collateralAmount);
    event Withdrawal(address indexed account, uint256 amountTinybar);
    event AutomationFunded(address indexed sponsor, uint256 amountTinybar);
    event AutomationReserved(bytes32 indexed positionId, address indexed scheduleAddress, uint64 executionSecond);
    event AutomationUnavailable(bytes32 indexed positionId);
    event AutomationCompleted(bytes32 indexed positionId);
    event UnusedAutomationWithdrawn(address indexed recipient, uint256 amountTinybar);

    constructor(
        IAtsCollateralToken atsToken_,
        bytes32 partition_,
        IHbarUsdOracle oracle_,
        uint8 tokenDecimals_,
        uint256 nominalValueUsdE8_,
        RailPolicy memory policy_,
        address owner_
    ) {
        if (address(atsToken_) == address(0) || address(oracle_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (partition_ == bytes32(0) || tokenDecimals_ > 18 || nominalValueUsdE8_ == 0) {
            revert InvalidConfiguration();
        }
        if (
            policy_.maximumAdvanceBps == 0 || policy_.maximumAdvanceBps > MAX_ADVANCE_BPS
                || policy_.maximumAnnualRateBps > MAX_RATE_BPS
                || policy_.maximumQuoteMovementBps > MAX_QUOTE_MOVEMENT_BPS || policy_.minimumTermSeconds < MIN_TERM
                || policy_.maximumTermSeconds < policy_.minimumTermSeconds || policy_.maximumTermSeconds > MAX_TERM
                || policy_.maximumOfferLifetimeSeconds == 0 || policy_.maximumOfferLifetimeSeconds > MAX_OFFER_LIFETIME
        ) revert InvalidPolicy();
        atsToken = atsToken_;
        partition = partition_;
        oracle = oracle_;
        tokenDecimals = tokenDecimals_;
        nominalValueUsdE8 = nominalValueUsdE8_;
        maximumAdvanceBps = policy_.maximumAdvanceBps;
        maximumAnnualRateBps = policy_.maximumAnnualRateBps;
        maximumQuoteMovementBps = policy_.maximumQuoteMovementBps;
        minimumTermSeconds = policy_.minimumTermSeconds;
        maximumTermSeconds = policy_.maximumTermSeconds;
        maximumOfferLifetimeSeconds = policy_.maximumOfferLifetimeSeconds;
        owner = owner_;
    }

    receive() external payable {
        revert DirectFundingDisabled();
    }

    function previewOffer(OfferTerms calldata terms)
        external
        view
        returns (
            uint256 maximumPrincipalUsdE8,
            uint256 principalTinybar,
            uint256 repaymentTinybar,
            uint64 maturity,
            uint256 priceUsdE8,
            uint64 publishTime
        )
    {
        _validateTerms(terms);
        maximumPrincipalUsdE8 = _maximumPrincipalUsdE8(terms.collateralAmount);
        if (terms.principalUsdE8 > maximumPrincipalUsdE8) {
            revert InsufficientCollateralCoverage(terms.principalUsdE8, maximumPrincipalUsdE8);
        }
        (priceUsdE8,, publishTime) = oracle.latestHbarUsd();
        principalTinybar = _usdToTinybar(terms.principalUsdE8, priceUsdE8);
        repaymentTinybar = _repayment(principalTinybar, terms.annualRateBps, terms.termSeconds);
        maturity = uint64(block.timestamp + terms.termSeconds);
    }

    function fundOffer(OfferTerms calldata terms) external payable nonReentrant returns (bytes32 offerId) {
        _validateTerms(terms);
        if (msg.sender == terms.borrower) revert SelfDealing();
        _requireKyc(msg.sender);

        uint256 maximumUsdE8 = _maximumPrincipalUsdE8(terms.collateralAmount);
        if (terms.principalUsdE8 > maximumUsdE8) {
            revert InsufficientCollateralCoverage(terms.principalUsdE8, maximumUsdE8);
        }

        (uint256 priceUsdE8,, uint64 publishTime) = oracle.latestHbarUsd();
        uint256 principalTinybar = _usdToTinybar(terms.principalUsdE8, priceUsdE8);
        if (msg.value != principalTinybar) revert IncorrectFunding(msg.value, principalTinybar);

        offerId = keccak256(abi.encode(address(this), block.chainid, msg.sender, terms, ++offerSequence));
        offers[offerId] = FundedOffer({
            lender: msg.sender,
            terms: terms,
            principalTinybar: principalTinybar,
            quotePriceUsdE8: priceUsdE8,
            quotePublishTime: publishTime,
            exists: true
        });
        cashLiabilities += principalTinybar;
        _requireSolvent();
        emit OfferFunded(offerId, msg.sender, terms.borrower, principalTinybar, priceUsdE8);
    }

    function cancelOffer(bytes32 offerId) external nonReentrant {
        FundedOffer storage offer = offers[offerId];
        if (!offer.exists) revert OfferNotFound();
        if (offer.lender != msg.sender) revert NotLender();

        uint256 amount = offer.principalTinybar;
        delete offers[offerId];
        credits[msg.sender] += amount;
        _requireSolvent();
        emit OfferCancelled(offerId, msg.sender, amount);
    }

    function acceptOffer(bytes32 offerId) external nonReentrant returns (bytes32 positionId) {
        FundedOffer storage stored = offers[offerId];
        if (!stored.exists) revert OfferNotFound();

        FundedOffer memory offer = stored;
        if (offer.terms.borrower != msg.sender) revert NotBorrower();
        if (block.timestamp > offer.terms.offerExpiresAt) revert OfferExpired();
        _requireKyc(offer.lender);
        _requireKyc(msg.sender);

        (uint256 currentPriceUsdE8,,) = oracle.latestHbarUsd();
        uint256 currentPrincipalTinybar = _usdToTinybar(offer.terms.principalUsdE8, currentPriceUsdE8);
        if (
            _absoluteDifference(currentPrincipalTinybar, offer.principalTinybar) * BPS
                > offer.principalTinybar * maximumQuoteMovementBps
        ) {
            revert QuoteMoved(offer.principalTinybar, currentPrincipalTinybar);
        }

        uint256 allowance_ = atsToken.allowance(msg.sender, address(this));
        if (allowance_ < offer.terms.collateralAmount) {
            revert InsufficientAllowance(allowance_, offer.terms.collateralAmount);
        }
        uint256 freeBalance = atsToken.balanceOfByPartition(partition, msg.sender);
        if (freeBalance < offer.terms.collateralAmount) {
            revert InsufficientFreeBalance(freeBalance, offer.terms.collateralAmount);
        }

        positionId = offerId;
        uint64 openedAt = uint64(block.timestamp);
        uint64 maturity = uint64(block.timestamp + offer.terms.termSeconds);
        uint256 repaymentTinybar =
            _repayment(offer.principalTinybar, offer.terms.annualRateBps, offer.terms.termSeconds);

        IAtsCollateralToken.Hold memory requestedHold = IAtsCollateralToken.Hold({
            amount: offer.terms.collateralAmount,
            expirationTimestamp: type(uint256).max,
            escrow: address(this),
            to: address(0),
            data: abi.encode(positionId)
        });
        (bool created, uint256 holdId) =
            atsToken.createHoldFromByPartition(partition, msg.sender, requestedHold, bytes(""));
        if (!created) {
            revert HoldCallFailed(IAtsCollateralToken.createHoldFromByPartition.selector);
        }
        if (holdId == 0) revert InvalidHold();

        _validateCreatedHold(positionId, msg.sender, holdId, offer.terms.collateralAmount, maturity);

        positions[positionId] = Position({
            lender: offer.lender,
            borrower: msg.sender,
            collateralAmount: offer.terms.collateralAmount,
            holdId: holdId,
            principalTinybar: offer.principalTinybar,
            repaymentTinybar: repaymentTinybar,
            openedAt: openedAt,
            maturity: maturity,
            scheduleAddress: address(0),
            state: PositionState.OPEN,
            automation: AutomationState.NONE
        });

        delete offers[offerId];
        credits[msg.sender] += offer.principalTinybar;
        emit PositionOpened(positionId, offer.lender, msg.sender, holdId, maturity);

        _armAutomation(positionId, maturity);
        _requireSolvent();
    }

    function repay(bytes32 positionId) external payable nonReentrant {
        Position storage position = positions[positionId];
        if (position.state != PositionState.OPEN) revert PositionNotOpen();
        if (position.borrower != msg.sender) revert NotBorrower();
        if (msg.value != position.repaymentTinybar) {
            revert IncorrectFunding(msg.value, position.repaymentTinybar);
        }

        uint256 currentCollateralAmount = _validatedCurrentHoldAmount(positionId, position);

        position.state = PositionState.REPAID;
        cashLiabilities += msg.value;
        credits[position.lender] += msg.value;

        bool released = atsToken.releaseHoldByPartition(_holdIdentifier(position), currentCollateralAmount);
        if (!released) revert HoldCallFailed(IAtsCollateralToken.releaseHoldByPartition.selector);
        _requireHoldDrained(position);

        _requireSolvent();
        emit PositionRepaid(positionId, msg.value);
    }

    function settle(bytes32 positionId) external nonReentrant returns (bool executed) {
        Position storage position = positions[positionId];
        if (position.state == PositionState.NONE) revert PositionNotOpen();
        if (position.state == PositionState.DEFAULTED) return false;
        if (block.timestamp < position.maturity) {
            if (position.state == PositionState.REPAID) return false;
            revert NotMatured(block.timestamp, position.maturity);
        }

        if (position.state == PositionState.REPAID) {
            _completeAutomation(positionId, position);
            return false;
        }

        _requireKyc(position.lender);
        uint256 currentCollateralAmount = _validatedCurrentHoldAmount(positionId, position);
        position.state = PositionState.DEFAULTED;
        _completeAutomation(positionId, position);

        (bool success, bytes32 executedPartition) =
            atsToken.executeHoldByPartition(_holdIdentifier(position), position.lender, currentCollateralAmount);
        if (!success) revert HoldCallFailed(IAtsCollateralToken.executeHoldByPartition.selector);
        if (executedPartition != partition) revert InvalidHold();
        _requireHoldDrained(position);

        _requireSolvent();
        emit PositionDefaulted(positionId, currentCollateralAmount);
        return true;
    }

    function withdraw() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        cashLiabilities -= amount;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
        _requireSolvent();
        emit Withdrawal(msg.sender, amount);
    }

    function fundAutomation() external payable nonReentrant {
        if (msg.value == 0) revert IncorrectFunding(0, 1);
        _requireSolvent();
        emit AutomationFunded(msg.sender, msg.value);
    }

    function withdrawUnusedAutomation(address payable recipient, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert OwnerOnly();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = availableAutomation();
        if (amount == 0 || amount > available) revert AutomationFundsLocked(available, amount);
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
        _requireSolvent();
        emit UnusedAutomationWithdrawn(recipient, amount);
    }

    function availableAutomation() public view returns (uint256) {
        uint256 required = cashLiabilities + reservedAutomation;
        return address(this).balance > required ? address(this).balance - required : 0;
    }

    function requiredBacking() external view returns (uint256) {
        return cashLiabilities + reservedAutomation;
    }

    function policy() external view returns (RailPolicy memory) {
        return RailPolicy({
            maximumAdvanceBps: maximumAdvanceBps,
            maximumAnnualRateBps: maximumAnnualRateBps,
            maximumQuoteMovementBps: maximumQuoteMovementBps,
            minimumTermSeconds: minimumTermSeconds,
            maximumTermSeconds: maximumTermSeconds,
            maximumOfferLifetimeSeconds: maximumOfferLifetimeSeconds
        });
    }

    function getOffer(bytes32 offerId) external view returns (FundedOffer memory) {
        return offers[offerId];
    }

    function getPosition(bytes32 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    /// @notice Isolated self-call so malformed or unavailable system-contract
    /// responses are caught by `_armAutomation` instead of reverting acceptance.
    function schedulePosition(bytes32 positionId, uint64 executionSecond)
        external
        virtual
        returns (int64 responseCode, address scheduleAddress, bool capacity)
    {
        if (msg.sender != address(this)) revert SelfCallOnly();
        capacity = hasScheduleCapacity(executionSecond, HSS_GAS_LIMIT);
        if (!capacity) return (0, address(0), false);
        (responseCode, scheduleAddress) =
            scheduleCall(address(this), executionSecond, HSS_GAS_LIMIT, 0, abi.encodeCall(this.settle, (positionId)));
    }

    function _armAutomation(bytes32 positionId, uint64 maturity) internal {
        Position storage position = positions[positionId];
        if (availableAutomation() < HSS_RESERVE_TINYBAR) {
            position.automation = AutomationState.UNAVAILABLE;
            emit AutomationUnavailable(positionId);
            return;
        }

        uint64[3] memory offsets = [uint64(2), uint64(5), uint64(10)];
        for (uint256 i = 0; i < offsets.length; ++i) {
            uint64 executionSecond = maturity + offsets[i];
            try this.schedulePosition(positionId, executionSecond) returns (
                int64 responseCode, address scheduleAddress, bool capacity
            ) {
                if (capacity && responseCode == HEDERA_SUCCESS && scheduleAddress != address(0)) {
                    position.scheduleAddress = scheduleAddress;
                    position.automation = AutomationState.PENDING;
                    reservedAutomation += HSS_RESERVE_TINYBAR;
                    emit AutomationReserved(positionId, scheduleAddress, executionSecond);
                    return;
                }
            } catch {}
        }

        position.automation = AutomationState.UNAVAILABLE;
        emit AutomationUnavailable(positionId);
    }

    function _completeAutomation(bytes32 positionId, Position storage position) internal {
        if (position.automation == AutomationState.PENDING) {
            reservedAutomation -= HSS_RESERVE_TINYBAR;
            position.automation = AutomationState.COMPLETED;
            emit AutomationCompleted(positionId);
        }
    }

    function _validateTerms(OfferTerms calldata terms) internal view {
        if (
            terms.borrower == address(0) || terms.collateralAmount == 0 || terms.principalUsdE8 == 0
                || terms.annualRateBps > maximumAnnualRateBps || terms.termSeconds < minimumTermSeconds
                || terms.termSeconds > maximumTermSeconds || terms.offerExpiresAt <= block.timestamp
                || terms.offerExpiresAt > block.timestamp + maximumOfferLifetimeSeconds
        ) revert InvalidTerms();
        uint256 facilityMaturity = block.timestamp + terms.termSeconds;
        uint256 assetMaturity = atsToken.getMaturityDate();
        if (assetMaturity == 0 || facilityMaturity > assetMaturity) {
            revert BeyondAssetMaturity(facilityMaturity, assetMaturity);
        }
    }

    function _validateCreatedHold(
        bytes32 positionId,
        address borrower,
        uint256 holdId,
        uint256 collateralAmount,
        uint64 maturity
    ) internal view {
        (
            uint256 amount,
            uint256 expirationTimestamp,
            address escrow,
            address destination,
            bytes memory data,
            bytes memory operatorData,
            uint8 thirdPartyType
        ) = atsToken.getHoldForByPartition(
            IAtsCollateralToken.HoldIdentifier({partition: partition, tokenHolder: borrower, holdId: holdId})
        );
        if (
            amount != collateralAmount || expirationTimestamp <= maturity || escrow != address(this)
                || destination != address(0) || keccak256(data) != keccak256(abi.encode(positionId))
                || operatorData.length != 0 || thirdPartyType != ATS_AUTHORIZED_HOLD
        ) revert InvalidHold();
    }

    function _validatedCurrentHoldAmount(bytes32 positionId, Position storage position)
        internal
        view
        returns (uint256 amount)
    {
        uint256 expirationTimestamp;
        address escrow;
        address destination;
        bytes memory data;
        bytes memory operatorData;
        uint8 thirdPartyType;
        (amount, expirationTimestamp, escrow, destination, data, operatorData, thirdPartyType) =
            atsToken.getHoldForByPartition(_holdIdentifier(position));

        uint256 totalHeld = atsToken.getHeldAmountForByPartition(partition, position.borrower);
        if (
            amount == 0 || amount > totalHeld || expirationTimestamp <= position.maturity || escrow != address(this)
                || destination != address(0) || keccak256(data) != keccak256(abi.encode(positionId))
                || operatorData.length != 0 || thirdPartyType != ATS_AUTHORIZED_HOLD
        ) revert InvalidHold();
    }

    function _requireHoldDrained(Position storage position) internal view {
        (uint256 remainingAmount,,,,,,) = atsToken.getHoldForByPartition(_holdIdentifier(position));
        if (remainingAmount != 0) revert InvalidHold();
    }

    function _holdIdentifier(Position storage position)
        internal
        view
        returns (IAtsCollateralToken.HoldIdentifier memory)
    {
        return IAtsCollateralToken.HoldIdentifier({
            partition: partition, tokenHolder: position.borrower, holdId: position.holdId
        });
    }

    function _requireKyc(address account) internal view {
        if (atsToken.getKycStatusFor(account) != IAtsCollateralToken.KycStatus.GRANTED) {
            revert KycRequired(account);
        }
    }

    function _maximumPrincipalUsdE8(uint256 collateralAmount) internal view returns (uint256) {
        uint256 nominalUsdE8 = collateralAmount * nominalValueUsdE8 / (10 ** tokenDecimals);
        return nominalUsdE8 * maximumAdvanceBps / BPS;
    }

    function _usdToTinybar(uint256 usdE8, uint256 hbarPriceUsdE8) internal pure returns (uint256) {
        return _divideUp(usdE8 * TINYBAR_PER_HBAR, hbarPriceUsdE8);
    }

    function _repayment(uint256 principalTinybar, uint256 annualRateBps, uint256 termSeconds)
        internal
        pure
        returns (uint256)
    {
        uint256 interest = _divideUp(principalTinybar * annualRateBps * termSeconds, BPS * uint256(365 days));
        return principalTinybar + interest;
    }

    function _divideUp(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        return numerator == 0 ? 0 : ((numerator - 1) / denominator) + 1;
    }

    function _absoluteDifference(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a - b : b - a;
    }

    function _requireSolvent() internal view {
        uint256 required = cashLiabilities + reservedAutomation;
        if (address(this).balance < required) revert Insolvent(address(this).balance, required);
    }
}
