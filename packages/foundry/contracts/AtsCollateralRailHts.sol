// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HederaScheduleService} from "@hiero-ledger/hiero-contracts/schedule-service/HederaScheduleService.sol";
import {HederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/HederaTokenService.sol";
import {IHederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/IHederaTokenService.sol";
import {IAtsCollateralToken} from "./interfaces/IAtsCollateralToken.sol";
import {IUsdOracle} from "./interfaces/IUsdOracle.sol";
import {ReentrancyLock} from "./utils/ReentrancyLock.sol";

interface IFungibleTokenBalance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title AtsCollateralRailHts
/// @notice Bilateral HTS financing secured by one ATS partition hold.
/// @dev Token liabilities and HBAR schedule reserves are accounted separately.
contract AtsCollateralRailHts is HederaScheduleService, HederaTokenService, ReentrancyLock {
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
        uint128 principalTokenUnits;
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
        uint256 principalTokenUnits;
        uint256 repaymentTokenUnits;
        uint64 openedAt;
        uint64 maturity;
        address scheduleAddress;
        PositionState state;
        AutomationState automation;
    }

    struct FundedOffer {
        address lender;
        OfferTerms terms;
        uint256 quotePriceUsdE8;
        uint64 quotePublishTime;
        bool exists;
    }

    struct SettlementMetadata {
        int32 decimals;
        bool deleted;
        bool defaultKycStatus;
        bool paused;
    }

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_ADVANCE_BPS = 7_000;
    uint16 public constant MAX_RATE_BPS = 10_000;
    uint16 public constant MAX_QUOTE_MOVEMENT_BPS = 100;
    uint64 public constant MIN_TERM = 2 minutes;
    uint64 public constant MAX_TERM = 365 days;
    uint64 public constant MAX_OFFER_LIFETIME = 24 hours;
    uint256 public constant HSS_GAS_LIMIT = 750_000;
    uint256 public constant TINYBAR_PER_HBAR = 100_000_000;
    uint256 public constant HSS_RESERVE_TINYBAR = 5 * TINYBAR_PER_HBAR;
    uint256 public constant MAX_TRANSFER_AMOUNT = uint256(uint64(type(int64).max));
    int64 public constant HEDERA_SUCCESS = 22;
    int64 public constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
    uint8 private constant ATS_AUTHORIZED_HOLD = 1;

    IAtsCollateralToken public immutable atsToken;
    address public immutable settlementToken;
    IUsdOracle public immutable oracle;
    bytes32 public immutable partition;
    uint8 public immutable atsTokenDecimals;
    uint256 public immutable atsNominalValueUsdE8;
    address public immutable owner;
    uint16 public immutable maximumAdvanceBps;
    uint16 public immutable maximumAnnualRateBps;
    uint16 public immutable maximumQuoteMovementBps;
    uint64 public immutable minimumTermSeconds;
    uint64 public immutable maximumTermSeconds;
    uint64 public immutable maximumOfferLifetimeSeconds;

    bool public settlementInitialized;
    uint8 public settlementDecimals;
    bool public settlementKycNotApplicable;
    uint256 public offerSequence;
    uint256 public cashTokenLiabilities;
    uint256 public reservedAutomation;

    mapping(bytes32 offerId => FundedOffer offer) private _offers;
    mapping(bytes32 positionId => Position position) private _positions;
    mapping(address account => uint256 tokenCredit) public credits;

    error ZeroAddress();
    error InvalidConfiguration();
    error InvalidPolicy();
    error InvalidTerms();
    error SelfDealing();
    error KycRequired(address account);
    error InsufficientCollateralCoverage(uint256 principalUsdE8, uint256 maximumUsdE8);
    error OfferNotFound();
    error OfferExpired();
    error NotLender();
    error NotBorrower();
    error PositionNotOpen();
    error NotMatured(uint256 currentTime, uint256 maturity);
    error BeyondAssetMaturity(uint256 facilityMaturity, uint256 assetMaturity);
    error QuoteMoved(uint256 quotedPriceUsdE8, uint256 currentPriceUsdE8);
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientTokenBalance(uint256 available, uint256 required);
    error InsufficientFreeBalance(uint256 available, uint256 required);
    error HoldCallFailed(bytes4 selector);
    error InvalidHold();
    error NothingToWithdraw();
    error NativeTransferFailed();
    error TokenInsolvent(uint256 balance, uint256 required);
    error AutomationInsolvent(uint256 balance, uint256 required);
    error OwnerOnly();
    error SelfCallOnly();
    error DirectFundingDisabled();
    error AutomationFundsLocked(uint256 available, uint256 requested);
    error SettlementNotInitialized();
    error SettlementAlreadyInitialized();
    error InvalidSettlementToken();
    error InvalidSettlementDecimals(int32 decimals);
    error SettlementTokenDeleted();
    error SettlementTokenPaused();
    error SettlementCustomFees(uint256 fixedFees, uint256 fractionalFees, uint256 royaltyFees);
    error SettlementAccountFrozen(address account);
    error SettlementKycRequired(address account);
    error HtsCallFailed(bytes4 selector, int64 responseCode);
    error TransferAmountOutOfRange(uint256 amount);
    error TransferDeltaMismatch(uint256 beforeBalance, uint256 afterBalance, uint256 expectedDelta);
    error MalformedTokenBalance(address token, uint256 returnLength);

    event SettlementInitialized(address indexed token, uint8 decimals, bool kycNotApplicable);
    event OfferFunded(
        bytes32 indexed offerId,
        address indexed lender,
        address indexed borrower,
        uint256 principalTokenUnits,
        uint256 quotePriceUsdE8
    );
    event OfferCancelled(bytes32 indexed offerId, address indexed lender, uint256 creditedTokenUnits);
    event PositionOpened(
        bytes32 indexed positionId, address indexed lender, address indexed borrower, uint256 holdId, uint256 maturity
    );
    event PositionRepaid(bytes32 indexed positionId, uint256 repaymentTokenUnits);
    event PositionDefaulted(bytes32 indexed positionId, uint256 collateralAmount);
    event Withdrawal(address indexed account, uint256 amountTokenUnits);
    event AutomationFunded(address indexed sponsor, uint256 amountTinybar);
    event AutomationReserved(bytes32 indexed positionId, address indexed scheduleAddress, uint64 executionSecond);
    event AutomationUnavailable(bytes32 indexed positionId);
    event AutomationCompleted(bytes32 indexed positionId);
    event UnusedAutomationWithdrawn(address indexed recipient, uint256 amountTinybar);

    constructor(
        IAtsCollateralToken atsToken_,
        bytes32 partition_,
        address settlementToken_,
        IUsdOracle oracle_,
        uint8 atsTokenDecimals_,
        uint256 atsNominalValueUsdE8_,
        RailPolicy memory policy_,
        address owner_
    ) {
        if (
            address(atsToken_) == address(0) || settlementToken_ == address(0) || address(oracle_) == address(0)
                || owner_ == address(0)
        ) revert ZeroAddress();
        if (partition_ == bytes32(0) || atsTokenDecimals_ > 18 || atsNominalValueUsdE8_ == 0) {
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
        settlementToken = settlementToken_;
        oracle = oracle_;
        atsTokenDecimals = atsTokenDecimals_;
        atsNominalValueUsdE8 = atsNominalValueUsdE8_;
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

    function initializeSettlement() external nonReentrant {
        if (settlementInitialized) revert SettlementAlreadyInitialized();

        SettlementMetadata memory metadata = _htsFungibleMetadata();
        if (metadata.deleted) revert SettlementTokenDeleted();
        if (metadata.paused) revert SettlementTokenPaused();
        if (metadata.decimals < 0 || metadata.decimals > 18) revert InvalidSettlementDecimals(metadata.decimals);
        _requireNoCustomFees();

        int64 responseCode = _htsAssociateRail();
        if (responseCode != HEDERA_SUCCESS && responseCode != TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) {
            revert HtsCallFailed(IHederaTokenService.associateToken.selector, responseCode);
        }

        settlementDecimals = uint8(uint32(metadata.decimals));
        settlementKycNotApplicable = metadata.defaultKycStatus;
        settlementInitialized = true;
        _tokenBalance(address(this));
        emit SettlementInitialized(settlementToken, settlementDecimals, settlementKycNotApplicable);
    }

    function previewOffer(OfferTerms calldata terms)
        external
        view
        returns (
            uint256 maximumPrincipalUsdE8,
            uint256 previewMaximumTokenUnits,
            uint256 principalUsdE8,
            uint256 previewRepaymentTokenUnits,
            uint64 maturity,
            uint256 priceUsdE8,
            uint64 publishTime
        )
    {
        _requireInitialized();
        _validateTerms(terms);
        maximumPrincipalUsdE8 = _maximumPrincipalUsdE8(terms.collateralAmount);
        (priceUsdE8,, publishTime) = oracle.latestUsdPrice();
        previewMaximumTokenUnits = _usdToTokenDown(maximumPrincipalUsdE8, priceUsdE8);
        principalUsdE8 = _tokenToUsdUp(terms.principalTokenUnits, priceUsdE8);
        if (principalUsdE8 > maximumPrincipalUsdE8) {
            revert InsufficientCollateralCoverage(principalUsdE8, maximumPrincipalUsdE8);
        }
        previewRepaymentTokenUnits = _repayment(terms.principalTokenUnits, terms.annualRateBps, terms.termSeconds);
        maturity = uint64(block.timestamp + terms.termSeconds);
    }

    function fundOffer(OfferTerms calldata terms) external nonReentrant returns (bytes32 offerId) {
        _requireInitialized();
        _validateTerms(terms);
        if (msg.sender == terms.borrower) revert SelfDealing();
        _requireAtsKyc(msg.sender);
        _requireTransferAmount(terms.principalTokenUnits);

        uint256 maximumUsdE8 = _maximumPrincipalUsdE8(terms.collateralAmount);
        (uint256 priceUsdE8,, uint64 publishTime) = oracle.latestUsdPrice();
        uint256 principalUsdE8 = _tokenToUsdUp(terms.principalTokenUnits, priceUsdE8);
        if (principalUsdE8 > maximumUsdE8) {
            revert InsufficientCollateralCoverage(principalUsdE8, maximumUsdE8);
        }

        _pullExact(msg.sender, terms.principalTokenUnits);
        offerId = keccak256(abi.encode(address(this), block.chainid, msg.sender, terms, ++offerSequence));
        _offers[offerId] = FundedOffer({
            lender: msg.sender, terms: terms, quotePriceUsdE8: priceUsdE8, quotePublishTime: publishTime, exists: true
        });
        cashTokenLiabilities += terms.principalTokenUnits;
        _requireSolvent();
        emit OfferFunded(offerId, msg.sender, terms.borrower, terms.principalTokenUnits, priceUsdE8);
    }

    function cancelOffer(bytes32 offerId) external nonReentrant {
        FundedOffer storage offer = _offers[offerId];
        if (!offer.exists) revert OfferNotFound();
        if (offer.lender != msg.sender) revert NotLender();

        uint256 amount = offer.terms.principalTokenUnits;
        delete _offers[offerId];
        credits[msg.sender] += amount;
        _requireSolvent();
        emit OfferCancelled(offerId, msg.sender, amount);
    }

    function acceptOffer(bytes32 offerId) external nonReentrant returns (bytes32 positionId) {
        FundedOffer storage stored = _offers[offerId];
        if (!stored.exists) revert OfferNotFound();

        FundedOffer memory offer = stored;
        if (offer.terms.borrower != msg.sender) revert NotBorrower();
        if (block.timestamp > offer.terms.offerExpiresAt) revert OfferExpired();
        _requireAtsKyc(offer.lender);
        _requireAtsKyc(msg.sender);

        (uint256 currentPriceUsdE8,,) = oracle.latestUsdPrice();
        if (!_quoteWithinMovement(offer.quotePriceUsdE8, currentPriceUsdE8)) {
            revert QuoteMoved(offer.quotePriceUsdE8, currentPriceUsdE8);
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
        uint256 calculatedRepaymentTokenUnits =
            _repayment(offer.terms.principalTokenUnits, offer.terms.annualRateBps, offer.terms.termSeconds);
        _requireTransferAmount(calculatedRepaymentTokenUnits);

        IAtsCollateralToken.Hold memory requestedHold = IAtsCollateralToken.Hold({
            amount: offer.terms.collateralAmount,
            expirationTimestamp: type(uint256).max,
            escrow: address(this),
            to: address(0),
            data: abi.encode(positionId)
        });
        (bool created, uint256 holdId) =
            atsToken.createHoldFromByPartition(partition, msg.sender, requestedHold, bytes(""));
        if (!created) revert HoldCallFailed(IAtsCollateralToken.createHoldFromByPartition.selector);
        if (holdId == 0) revert InvalidHold();
        _validateCreatedHold(positionId, msg.sender, holdId, offer.terms.collateralAmount, maturity);

        _positions[positionId] = Position({
            lender: offer.lender,
            borrower: msg.sender,
            collateralAmount: offer.terms.collateralAmount,
            holdId: holdId,
            principalTokenUnits: offer.terms.principalTokenUnits,
            repaymentTokenUnits: calculatedRepaymentTokenUnits,
            openedAt: openedAt,
            maturity: maturity,
            scheduleAddress: address(0),
            state: PositionState.OPEN,
            automation: AutomationState.NONE
        });

        delete _offers[offerId];
        credits[msg.sender] += offer.terms.principalTokenUnits;
        emit PositionOpened(positionId, offer.lender, msg.sender, holdId, maturity);
        _armAutomation(positionId, maturity);
        _requireSolvent();
    }

    function repay(bytes32 positionId) external nonReentrant {
        Position storage position = _positions[positionId];
        if (position.state != PositionState.OPEN) revert PositionNotOpen();
        if (position.borrower != msg.sender) revert NotBorrower();

        uint256 currentCollateralAmount = _validatedCurrentHoldAmount(positionId, position);
        _pullExact(msg.sender, position.repaymentTokenUnits);

        position.state = PositionState.REPAID;
        cashTokenLiabilities += position.repaymentTokenUnits;
        credits[position.lender] += position.repaymentTokenUnits;

        bool released = atsToken.releaseHoldByPartition(_holdIdentifier(position), currentCollateralAmount);
        if (!released) revert HoldCallFailed(IAtsCollateralToken.releaseHoldByPartition.selector);
        _requireHoldDrained(position);
        _requireSolvent();
        emit PositionRepaid(positionId, position.repaymentTokenUnits);
    }

    function settle(bytes32 positionId) external nonReentrant returns (bool executed) {
        Position storage position = _positions[positionId];
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

        _requireAtsKyc(position.lender);
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
        cashTokenLiabilities -= amount;
        _pushExact(msg.sender, amount);
        _requireSolvent();
        emit Withdrawal(msg.sender, amount);
    }

    function fundAutomation() external payable nonReentrant {
        if (msg.value == 0) revert InvalidTerms();
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
        return address(this).balance > reservedAutomation ? address(this).balance - reservedAutomation : 0;
    }

    function requiredBacking() external view returns (uint256 tokenLiabilities, uint256 hbarAutomationReserve) {
        return (cashTokenLiabilities, reservedAutomation);
    }

    function settlementBalance() external view returns (uint256) {
        return _tokenBalance(address(this));
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
        return _offers[offerId];
    }

    function getPosition(bytes32 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

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
        Position storage position = _positions[positionId];
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

    function _pullExact(address from, uint256 amount) internal {
        _requireTransferAmount(amount);
        _assertSettlementAccount(from, amount, true);
        uint256 beforeBalance = _tokenBalance(address(this));
        int64 responseCode = _htsTransferFrom(from, amount);
        if (responseCode != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.transferFrom.selector, responseCode);
        }
        uint256 afterBalance = _tokenBalance(address(this));
        if (afterBalance != beforeBalance + amount) {
            revert TransferDeltaMismatch(beforeBalance, afterBalance, amount);
        }
    }

    function _pushExact(address to, uint256 amount) internal {
        _requireTransferAmount(amount);
        _assertSettlementAccount(to, 0, false);
        uint256 beforeBalance = _tokenBalance(address(this));
        int64 responseCode = _htsTransfer(to, amount);
        if (responseCode != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.transferToken.selector, responseCode);
        }
        uint256 afterBalance = _tokenBalance(address(this));
        if (afterBalance + amount != beforeBalance) {
            revert TransferDeltaMismatch(beforeBalance, afterBalance, amount);
        }
    }

    function _assertSettlementAccount(address account, uint256 amount, bool inbound) internal {
        SettlementMetadata memory metadata = _assertCurrentTokenPolicy();
        (int64 frozenResponseCode, bool frozen) = _htsFrozen(account);
        if (frozenResponseCode != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.isFrozen.selector, frozenResponseCode);
        }
        if (frozen) revert SettlementAccountFrozen(account);

        if (!metadata.defaultKycStatus) {
            (int64 kycResponseCode, bool kycGranted) = _htsKyc(account);
            if (kycResponseCode != HEDERA_SUCCESS) {
                revert HtsCallFailed(IHederaTokenService.isKyc.selector, kycResponseCode);
            }
            if (!kycGranted) revert SettlementKycRequired(account);
        }

        uint256 balance = _tokenBalance(account);
        if (inbound) {
            if (balance < amount) revert InsufficientTokenBalance(balance, amount);
            (int64 allowanceResponseCode, uint256 allowanceAmount) = _htsAllowanceFor(account);
            if (allowanceResponseCode != HEDERA_SUCCESS) {
                revert HtsCallFailed(IHederaTokenService.allowance.selector, allowanceResponseCode);
            }
            if (allowanceAmount < amount) revert InsufficientAllowance(allowanceAmount, amount);
        }
    }

    function _assertCurrentTokenPolicy() internal returns (SettlementMetadata memory metadata) {
        metadata = _htsFungibleMetadata();
        if (metadata.deleted) revert SettlementTokenDeleted();
        if (metadata.paused) revert SettlementTokenPaused();
        if (metadata.decimals != int32(uint32(settlementDecimals))) {
            revert InvalidSettlementDecimals(metadata.decimals);
        }
        _requireNoCustomFees();
    }

    function _requireNoCustomFees() internal {
        (uint256 fixedFeeCount, uint256 fractionalFeeCount, uint256 royaltyFeeCount) = _htsFeeCounts();
        if (fixedFeeCount != 0 || fractionalFeeCount != 0 || royaltyFeeCount != 0) {
            revert SettlementCustomFees(fixedFeeCount, fractionalFeeCount, royaltyFeeCount);
        }
    }

    function _htsFungibleMetadata() internal virtual returns (SettlementMetadata memory metadata) {
        (int256 responseCode, IHederaTokenService.FungibleTokenInfo memory tokenInfo) =
            getFungibleTokenInfo(settlementToken);
        if (responseCode != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.getFungibleTokenInfo.selector, int64(responseCode));
        }
        metadata = SettlementMetadata({
            decimals: tokenInfo.decimals,
            deleted: tokenInfo.tokenInfo.deleted,
            defaultKycStatus: tokenInfo.tokenInfo.defaultKycStatus,
            paused: tokenInfo.tokenInfo.pauseStatus
        });
    }

    function _htsFeeCounts() internal virtual returns (uint256 fixedFees, uint256 fractionalFees, uint256 royaltyFees) {
        int64 responseCode;
        IHederaTokenService.FixedFee[] memory fixedFeeList;
        IHederaTokenService.FractionalFee[] memory fractionalFeeList;
        IHederaTokenService.RoyaltyFee[] memory royaltyFeeList;
        (responseCode, fixedFeeList, fractionalFeeList, royaltyFeeList) = getTokenCustomFees(settlementToken);
        if (responseCode != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.getTokenCustomFees.selector, responseCode);
        }
        return (fixedFeeList.length, fractionalFeeList.length, royaltyFeeList.length);
    }

    function _htsAssociateRail() internal virtual returns (int64) {
        return associateToken(address(this), settlementToken);
    }

    function _htsAllowanceFor(address account) internal virtual returns (int64 responseCode, uint256 amount) {
        return allowance(settlementToken, account, address(this));
    }

    function _htsFrozen(address account) internal virtual returns (int64 responseCode, bool frozen) {
        return isFrozen(settlementToken, account);
    }

    function _htsKyc(address account) internal virtual returns (int64 responseCode, bool granted) {
        return isKyc(settlementToken, account);
    }

    function _htsTransferFrom(address from, uint256 amount) internal virtual returns (int64) {
        return transferFrom(settlementToken, from, address(this), amount);
    }

    function _htsTransfer(address to, uint256 amount) internal virtual returns (int64) {
        return transferToken(settlementToken, address(this), to, int64(uint64(amount)));
    }

    function _tokenBalance(address account) internal view virtual returns (uint256 balance) {
        (bool success, bytes memory result) =
            settlementToken.staticcall(abi.encodeCall(IFungibleTokenBalance.balanceOf, (account)));
        if (!success || result.length != 32) revert MalformedTokenBalance(settlementToken, result.length);
        balance = abi.decode(result, (uint256));
    }

    function _validateTerms(OfferTerms calldata terms) internal view {
        if (
            terms.borrower == address(0) || terms.collateralAmount == 0 || terms.principalTokenUnits == 0
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

    function _requireAtsKyc(address account) internal view {
        if (atsToken.getKycStatusFor(account) != IAtsCollateralToken.KycStatus.GRANTED) {
            revert KycRequired(account);
        }
    }

    function _maximumPrincipalUsdE8(uint256 collateralAmount) internal view returns (uint256) {
        uint256 nominalUsdE8 = collateralAmount * atsNominalValueUsdE8 / (10 ** atsTokenDecimals);
        return nominalUsdE8 * maximumAdvanceBps / BPS;
    }

    function _tokenToUsdUp(uint256 tokenUnits, uint256 priceUsdE8) internal view returns (uint256) {
        return _divideUp(tokenUnits * priceUsdE8, _settlementScale());
    }

    function _usdToTokenDown(uint256 usdE8, uint256 priceUsdE8) internal view returns (uint256) {
        if (priceUsdE8 == 0) revert InvalidConfiguration();
        return usdE8 * _settlementScale() / priceUsdE8;
    }

    function _repayment(uint256 principalTokenUnits, uint256 annualRateBps, uint256 termSeconds)
        internal
        pure
        returns (uint256)
    {
        uint256 interest = _divideUp(principalTokenUnits * annualRateBps * termSeconds, BPS * uint256(365 days));
        return principalTokenUnits + interest;
    }

    function _settlementScale() internal view returns (uint256) {
        return 10 ** settlementDecimals;
    }

    function _requireTransferAmount(uint256 amount) internal pure {
        if (amount == 0 || amount > MAX_TRANSFER_AMOUNT) revert TransferAmountOutOfRange(amount);
    }

    function _requireInitialized() internal view {
        if (!settlementInitialized) revert SettlementNotInitialized();
    }

    function _divideUp(uint256 numerator, uint256 denominator) internal pure returns (uint256) {
        return numerator == 0 ? 0 : ((numerator - 1) / denominator) + 1;
    }

    function _absoluteDifference(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a - b : b - a;
    }

    function _quoteWithinMovement(uint256 quotedPriceUsdE8, uint256 currentPriceUsdE8) internal view returns (bool) {
        return
            _absoluteDifference(currentPriceUsdE8, quotedPriceUsdE8) * BPS <= quotedPriceUsdE8 * maximumQuoteMovementBps;
    }

    function _requireSolvent() internal view {
        uint256 tokenBalance = _tokenBalance(address(this));
        if (tokenBalance < cashTokenLiabilities) revert TokenInsolvent(tokenBalance, cashTokenLiabilities);
        if (address(this).balance < reservedAutomation) {
            revert AutomationInsolvent(address(this).balance, reservedAutomation);
        }
    }
}
