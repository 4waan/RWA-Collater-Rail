// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HederaScheduleService} from "@hiero-ledger/hiero-contracts/schedule-service/HederaScheduleService.sol";
import {IAtsCollateralToken} from "../../interfaces/IAtsCollateralToken.sol";
import {ClprApplicationBase} from "./ClprApplicationBase.sol";
import {ClprMobilityTypes} from "./ClprMobilityTypes.sol";
import {IClprServiceMinimal} from "./IClprApplication.sol";

/// @notice Experimental Hedera-side ATS custody application for CLPR mobility.
contract AtsCollateralMobility is ClprApplicationBase, HederaScheduleService {
    enum PositionState {
        NONE,
        COLLATERAL_LOCKED,
        OPEN,
        REPAID,
        DEFAULTED,
        CANCELLED
    }

    enum AutomationState {
        NONE,
        PENDING,
        COMPLETED,
        UNAVAILABLE
    }

    struct Policy {
        uint16 maximumAdvanceBps;
        uint16 maximumRepaymentBps;
        uint64 minimumTermSeconds;
        uint64 maximumTermSeconds;
        uint64 maximumOfferLifetimeSeconds;
    }

    struct PendingOffer {
        ClprMobilityTypes.Terms terms;
        bytes32 termsHash;
        bool exists;
    }

    struct Position {
        ClprMobilityTypes.Terms terms;
        bytes32 termsHash;
        uint256 holdId;
        uint64 principalWithdrawnAt;
        uint64 maturity;
        address scheduleAddress;
        PositionState state;
        AutomationState automation;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant HSS_GAS_LIMIT = 750_000;
    uint256 public constant HSS_RESERVE_TINYBAR = 500_000_000;
    uint256 public constant TOKEN_UNITS_PER_USD = 1_000_000;
    uint256 public constant USD_E8 = 100_000_000;
    uint64 public constant MAX_CLOCK_SKEW = 30 seconds;
    int64 public constant HEDERA_SUCCESS = 22;
    uint8 private constant ATS_AUTHORIZED_HOLD = 1;

    IAtsCollateralToken public immutable atsToken;
    bytes32 public immutable partition;
    uint8 public immutable tokenDecimals;
    uint256 public immutable nominalValueUsdE8;
    address public immutable owner;
    uint16 public immutable maximumAdvanceBps;
    uint16 public immutable maximumRepaymentBps;
    uint64 public immutable minimumTermSeconds;
    uint64 public immutable maximumTermSeconds;
    uint64 public immutable maximumOfferLifetimeSeconds;

    uint256 public reservedAutomation;
    mapping(bytes32 mobilityId => PendingOffer offer) public offers;
    mapping(bytes32 mobilityId => Position position) public positions;

    error InvalidPolicy();
    error InvalidTerms();
    error TermsMismatch();
    error OfferNotFound();
    error OfferExpired();
    error NotBorrower();
    error PositionNotOpen();
    error InvalidPositionState(PositionState actual);
    error KycRequired(address account);
    error InsufficientCollateralCoverage(uint256 principalUsdE8, uint256 maximumUsdE8);
    error InsufficientAllowance(uint256 available, uint256 required);
    error InsufficientFreeBalance(uint256 available, uint256 required);
    error HoldCallFailed(bytes4 selector);
    error InvalidHold();
    error BeyondAssetMaturity(uint256 facilityMaturity, uint256 assetMaturity);
    error NotMatured(uint256 currentTime, uint256 maturity);
    error InvalidSourceTime();
    error UnsupportedMessage(ClprMobilityTypes.MessageKind kind);
    error DirectFundingDisabled();
    error IncorrectFunding();
    error OwnerOnly();
    error SelfCallOnly();
    error NativeTransferFailed();
    error AutomationFundsLocked(uint256 available, uint256 requested);
    error AutomationInsolvent(uint256 balance, uint256 reserve);

    event MobilityOfferReceived(bytes32 indexed mobilityId, address indexed lender, address indexed borrower);
    event MobilityCollateralLocked(bytes32 indexed mobilityId, uint256 indexed holdId, bytes32 outboxId);
    event MobilityPositionOpened(bytes32 indexed mobilityId, uint64 principalWithdrawnAt, uint64 maturity);
    event MobilityOfferCancelled(bytes32 indexed mobilityId, PositionState priorState);
    event MobilityPositionRepaid(bytes32 indexed mobilityId, bytes32 outboxId);
    event MobilityPositionDefaulted(bytes32 indexed mobilityId, uint256 collateralAmount, bytes32 outboxId);
    event AutomationFunded(address indexed sponsor, uint256 amountTinybar);
    event AutomationReserved(bytes32 indexed mobilityId, address indexed scheduleAddress, uint64 executionSecond);
    event AutomationUnavailable(bytes32 indexed mobilityId);
    event AutomationCompleted(bytes32 indexed mobilityId);
    event UnusedAutomationWithdrawn(address indexed recipient, uint256 amountTinybar);

    constructor(
        IAtsCollateralToken atsToken_,
        bytes32 partition_,
        uint8 tokenDecimals_,
        uint256 nominalValueUsdE8_,
        Policy memory policy_,
        address owner_,
        IClprServiceMinimal clprService_,
        bytes32 channelId_,
        bytes32 connectorId_,
        address peerApplication_,
        bytes32 localDomain_,
        bytes32 peerDomain_
    ) ClprApplicationBase(clprService_, channelId_, connectorId_, owner_, peerApplication_, localDomain_, peerDomain_) {
        if (address(atsToken_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (partition_ == bytes32(0) || tokenDecimals_ > 18 || nominalValueUsdE8_ == 0) {
            revert InvalidClprConfiguration();
        }
        if (
            policy_.maximumAdvanceBps == 0 || policy_.maximumAdvanceBps > 7_000 || policy_.maximumRepaymentBps < BPS
                || policy_.maximumRepaymentBps > 20_000 || policy_.minimumTermSeconds < 2 minutes
                || policy_.maximumTermSeconds < policy_.minimumTermSeconds || policy_.maximumTermSeconds > 365 days
                || policy_.maximumOfferLifetimeSeconds == 0 || policy_.maximumOfferLifetimeSeconds > 7 days
        ) revert InvalidPolicy();
        atsToken = atsToken_;
        partition = partition_;
        tokenDecimals = tokenDecimals_;
        nominalValueUsdE8 = nominalValueUsdE8_;
        maximumAdvanceBps = policy_.maximumAdvanceBps;
        maximumRepaymentBps = policy_.maximumRepaymentBps;
        minimumTermSeconds = policy_.minimumTermSeconds;
        maximumTermSeconds = policy_.maximumTermSeconds;
        maximumOfferLifetimeSeconds = policy_.maximumOfferLifetimeSeconds;
        owner = owner_;
    }

    receive() external payable {
        revert DirectFundingDisabled();
    }

    function acceptOffer(bytes32 mobilityId) external nonReentrant returns (bytes32 outboxId) {
        PendingOffer storage pending = offers[mobilityId];
        if (!pending.exists) revert OfferNotFound();
        ClprMobilityTypes.Terms memory terms = pending.terms;
        bytes32 termsHash = pending.termsHash;
        _validateAcceptance(terms, msg.sender);
        uint256 holdId = _createCollateralHold(mobilityId, terms);

        positions[mobilityId] = Position({
            terms: terms,
            termsHash: termsHash,
            holdId: holdId,
            principalWithdrawnAt: 0,
            maturity: 0,
            scheduleAddress: address(0),
            state: PositionState.COLLATERAL_LOCKED,
            automation: AutomationState.NONE
        });
        delete offers[mobilityId];
        outboxId =
            _queueMessage(ClprMobilityTypes.MessageKind.COLLATERAL_LOCKED, mobilityId, 1, 0, termsHash, bytes(""));
        emit MobilityCollateralLocked(mobilityId, holdId, outboxId);
    }

    function settle(bytes32 mobilityId) external nonReentrant returns (bool executed, bytes32 outboxId) {
        Position storage position = positions[mobilityId];
        if (position.state == PositionState.NONE || position.state == PositionState.COLLATERAL_LOCKED) {
            revert PositionNotOpen();
        }
        if (position.state == PositionState.DEFAULTED || position.state == PositionState.CANCELLED) {
            return (false, bytes32(0));
        }
        if (block.timestamp < position.maturity) {
            if (position.state == PositionState.REPAID) return (false, bytes32(0));
            revert NotMatured(block.timestamp, position.maturity);
        }
        if (position.state == PositionState.REPAID) {
            _completeAutomation(mobilityId, position);
            return (false, bytes32(0));
        }

        _requireKyc(position.terms.lender);
        uint256 currentAmount = _validatedCurrentHoldAmount(mobilityId, position);
        position.state = PositionState.DEFAULTED;
        _completeAutomation(mobilityId, position);
        (bool success, bytes32 executedPartition) =
            atsToken.executeHoldByPartition(_holdIdentifier(position), position.terms.lender, currentAmount);
        if (!success) revert HoldCallFailed(IAtsCollateralToken.executeHoldByPartition.selector);
        if (executedPartition != partition) revert InvalidHold();
        _requireHoldDrained(position);

        outboxId = _queueMessage(
            ClprMobilityTypes.MessageKind.DEFAULT_CONFIRMED, mobilityId, 1, 0, position.termsHash, bytes("")
        );
        _requireAutomationSolvent();
        emit MobilityPositionDefaulted(mobilityId, currentAmount, outboxId);
        return (true, outboxId);
    }

    function fundAutomation() external payable nonReentrant {
        if (msg.value == 0) revert IncorrectFunding();
        _requireAutomationSolvent();
        emit AutomationFunded(msg.sender, msg.value);
    }

    function withdrawUnusedAutomation(address payable recipient, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert OwnerOnly();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = availableAutomation();
        if (amount == 0 || amount > available) revert AutomationFundsLocked(available, amount);
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
        _requireAutomationSolvent();
        emit UnusedAutomationWithdrawn(recipient, amount);
    }

    function availableAutomation() public view returns (uint256) {
        return address(this).balance > reservedAutomation ? address(this).balance - reservedAutomation : 0;
    }

    function getPosition(bytes32 mobilityId) external view returns (Position memory) {
        return positions[mobilityId];
    }

    function schedulePosition(bytes32 mobilityId, uint64 executionSecond)
        external
        virtual
        returns (int64 responseCode, address scheduleAddress, bool capacity)
    {
        if (msg.sender != address(this)) revert SelfCallOnly();
        capacity = hasScheduleCapacity(executionSecond, HSS_GAS_LIMIT);
        if (!capacity) return (0, address(0), false);
        (responseCode, scheduleAddress) =
            scheduleCall(address(this), executionSecond, HSS_GAS_LIMIT, 0, abi.encodeCall(this.settle, (mobilityId)));
    }

    function _handleClprMessage(ClprMobilityTypes.Message memory message) internal override returns (bytes memory) {
        if (message.kind == ClprMobilityTypes.MessageKind.OFFER_FUNDED) {
            if (offers[message.mobilityId].exists || positions[message.mobilityId].state != PositionState.NONE) {
                revert InvalidMessage();
            }
            ClprMobilityTypes.Terms memory terms = abi.decode(message.body, (ClprMobilityTypes.Terms));
            if (ClprMobilityTypes.hashTerms(terms) != message.termsHash) revert TermsMismatch();
            _validateTerms(terms);
            offers[message.mobilityId] = PendingOffer({terms: terms, termsHash: message.termsHash, exists: true});
            emit MobilityOfferReceived(message.mobilityId, terms.lender, terms.borrower);
        } else if (message.kind == ClprMobilityTypes.MessageKind.PRINCIPAL_WITHDRAWN) {
            Position storage position = positions[message.mobilityId];
            if (position.termsHash != message.termsHash) revert TermsMismatch();
            if (position.state != PositionState.COLLATERAL_LOCKED) revert InvalidPositionState(position.state);
            uint64 withdrawnAt = abi.decode(message.body, (uint64));
            if (
                withdrawnAt != message.sourceTimestamp || withdrawnAt > block.timestamp + MAX_CLOCK_SKEW
                    || withdrawnAt > position.terms.offerExpiresAt
            ) revert InvalidSourceTime();
            uint256 maturity = uint256(withdrawnAt) + position.terms.termSeconds;
            uint256 assetMaturity = atsToken.getMaturityDate();
            if (maturity > type(uint64).max || assetMaturity == 0 || maturity > assetMaturity) {
                revert BeyondAssetMaturity(maturity, assetMaturity);
            }
            position.principalWithdrawnAt = withdrawnAt;
            position.maturity = uint64(maturity);
            position.state = PositionState.OPEN;
            _armAutomation(message.mobilityId, uint64(maturity));
            emit MobilityPositionOpened(message.mobilityId, withdrawnAt, uint64(maturity));
        } else if (message.kind == ClprMobilityTypes.MessageKind.REPAYMENT_ESCROWED) {
            Position storage position = positions[message.mobilityId];
            if (position.termsHash != message.termsHash) revert TermsMismatch();
            if (position.state != PositionState.OPEN) revert InvalidPositionState(position.state);
            uint256 currentAmount = _validatedCurrentHoldAmount(message.mobilityId, position);
            position.state = PositionState.REPAID;
            bool released = atsToken.releaseHoldByPartition(_holdIdentifier(position), currentAmount);
            if (!released) revert HoldCallFailed(IAtsCollateralToken.releaseHoldByPartition.selector);
            _requireHoldDrained(position);
            bytes32 outboxId = _queueMessage(
                ClprMobilityTypes.MessageKind.REPAYMENT_ACCEPTED,
                message.mobilityId,
                1,
                0,
                position.termsHash,
                bytes("")
            );
            emit MobilityPositionRepaid(message.mobilityId, outboxId);
        } else if (message.kind == ClprMobilityTypes.MessageKind.OFFER_CANCELLED) {
            PendingOffer storage pending = offers[message.mobilityId];
            if (pending.exists) {
                if (pending.termsHash != message.termsHash) revert TermsMismatch();
                delete offers[message.mobilityId];
                emit MobilityOfferCancelled(message.mobilityId, PositionState.NONE);
            } else {
                Position storage position = positions[message.mobilityId];
                if (position.termsHash != message.termsHash) revert TermsMismatch();
                if (position.state != PositionState.COLLATERAL_LOCKED) revert InvalidPositionState(position.state);
                uint256 currentAmount = _validatedCurrentHoldAmount(message.mobilityId, position);
                position.state = PositionState.CANCELLED;
                bool released = atsToken.releaseHoldByPartition(_holdIdentifier(position), currentAmount);
                if (!released) revert HoldCallFailed(IAtsCollateralToken.releaseHoldByPartition.selector);
                _requireHoldDrained(position);
                emit MobilityOfferCancelled(message.mobilityId, PositionState.COLLATERAL_LOCKED);
            }
        } else {
            revert UnsupportedMessage(message.kind);
        }

        _requireAutomationSolvent();
        return abi.encode(message.mobilityId, message.kind);
    }

    function _validateTerms(ClprMobilityTypes.Terms memory terms) private view {
        if (
            terms.lender == address(0) || terms.borrower == address(0) || terms.lender == terms.borrower
                || terms.collateralAmount == 0 || terms.principalTokenUnits == 0
                || terms.repaymentTokenUnits < terms.principalTokenUnits || terms.termSeconds < minimumTermSeconds
                || terms.termSeconds > maximumTermSeconds || terms.offerExpiresAt <= block.timestamp
                || terms.offerExpiresAt > block.timestamp + maximumOfferLifetimeSeconds
                || uint256(terms.repaymentTokenUnits) * BPS > uint256(terms.principalTokenUnits) * maximumRepaymentBps
        ) revert InvalidTerms();
    }

    function _requireCoverage(ClprMobilityTypes.Terms memory terms) private view {
        uint256 principalUsdE8 = uint256(terms.principalTokenUnits) * USD_E8 / TOKEN_UNITS_PER_USD;
        uint256 nominalUsdE8 = uint256(terms.collateralAmount) * nominalValueUsdE8 / (10 ** tokenDecimals);
        uint256 maximumUsdE8 = nominalUsdE8 * maximumAdvanceBps / BPS;
        if (principalUsdE8 > maximumUsdE8) {
            revert InsufficientCollateralCoverage(principalUsdE8, maximumUsdE8);
        }
    }

    function _validateAcceptance(ClprMobilityTypes.Terms memory terms, address caller) private view {
        if (terms.borrower != caller) revert NotBorrower();
        if (block.timestamp > terms.offerExpiresAt) revert OfferExpired();
        _requireKyc(terms.lender);
        _requireKyc(terms.borrower);
        _requireCoverage(terms);

        uint256 latestMaturity = uint256(terms.offerExpiresAt) + terms.termSeconds;
        uint256 assetMaturity = atsToken.getMaturityDate();
        if (assetMaturity == 0 || latestMaturity > assetMaturity) {
            revert BeyondAssetMaturity(latestMaturity, assetMaturity);
        }
        uint256 allowance_ = atsToken.allowance(terms.borrower, address(this));
        if (allowance_ < terms.collateralAmount) {
            revert InsufficientAllowance(allowance_, terms.collateralAmount);
        }
        uint256 freeBalance = atsToken.balanceOfByPartition(partition, terms.borrower);
        if (freeBalance < terms.collateralAmount) {
            revert InsufficientFreeBalance(freeBalance, terms.collateralAmount);
        }
    }

    function _createCollateralHold(bytes32 mobilityId, ClprMobilityTypes.Terms memory terms)
        private
        returns (uint256 holdId)
    {
        IAtsCollateralToken.Hold memory requestedHold = IAtsCollateralToken.Hold({
            amount: terms.collateralAmount,
            expirationTimestamp: type(uint256).max,
            escrow: address(this),
            to: address(0),
            data: abi.encode(mobilityId)
        });
        bool created;
        (created, holdId) = atsToken.createHoldFromByPartition(partition, terms.borrower, requestedHold, bytes(""));
        if (!created) revert HoldCallFailed(IAtsCollateralToken.createHoldFromByPartition.selector);
        if (holdId == 0) revert InvalidHold();
        _validateHold(mobilityId, terms.borrower, holdId, terms.collateralAmount, 0);
    }

    function _armAutomation(bytes32 mobilityId, uint64 maturity) private {
        Position storage position = positions[mobilityId];
        if (maturity <= block.timestamp || availableAutomation() < HSS_RESERVE_TINYBAR) {
            position.automation = AutomationState.UNAVAILABLE;
            emit AutomationUnavailable(mobilityId);
            return;
        }

        uint64[3] memory offsets = [uint64(2), uint64(5), uint64(10)];
        for (uint256 i = 0; i < offsets.length; ++i) {
            uint64 executionSecond = maturity + offsets[i];
            try this.schedulePosition(mobilityId, executionSecond) returns (
                int64 responseCode, address scheduleAddress, bool capacity
            ) {
                if (capacity && responseCode == HEDERA_SUCCESS && scheduleAddress != address(0)) {
                    position.scheduleAddress = scheduleAddress;
                    position.automation = AutomationState.PENDING;
                    reservedAutomation += HSS_RESERVE_TINYBAR;
                    emit AutomationReserved(mobilityId, scheduleAddress, executionSecond);
                    return;
                }
            } catch {}
        }
        position.automation = AutomationState.UNAVAILABLE;
        emit AutomationUnavailable(mobilityId);
    }

    function _completeAutomation(bytes32 mobilityId, Position storage position) private {
        if (position.automation == AutomationState.PENDING) {
            reservedAutomation -= HSS_RESERVE_TINYBAR;
            position.automation = AutomationState.COMPLETED;
            emit AutomationCompleted(mobilityId);
        }
    }

    function _validateHold(bytes32 mobilityId, address borrower, uint256 holdId, uint256 amount, uint64 maturity)
        private
        view
    {
        (
            uint256 actualAmount,
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
            actualAmount != amount || expirationTimestamp <= maturity || escrow != address(this)
                || destination != address(0) || keccak256(data) != keccak256(abi.encode(mobilityId))
                || operatorData.length != 0 || thirdPartyType != ATS_AUTHORIZED_HOLD
        ) revert InvalidHold();
    }

    function _validatedCurrentHoldAmount(bytes32 mobilityId, Position storage position)
        private
        view
        returns (uint256 amount)
    {
        (amount,,,,,,) = atsToken.getHoldForByPartition(_holdIdentifier(position));
        uint256 totalHeld = atsToken.getHeldAmountForByPartition(partition, position.terms.borrower);
        if (amount == 0 || amount > totalHeld) revert InvalidHold();
        _validateHold(mobilityId, position.terms.borrower, position.holdId, amount, position.maturity);
    }

    function _requireHoldDrained(Position storage position) private view {
        (uint256 remainingAmount,,,,,,) = atsToken.getHoldForByPartition(_holdIdentifier(position));
        if (remainingAmount != 0) revert InvalidHold();
    }

    function _holdIdentifier(Position storage position)
        private
        view
        returns (IAtsCollateralToken.HoldIdentifier memory)
    {
        return IAtsCollateralToken.HoldIdentifier({
            partition: partition, tokenHolder: position.terms.borrower, holdId: position.holdId
        });
    }

    function _requireKyc(address account) private view {
        if (atsToken.getKycStatusFor(account) != IAtsCollateralToken.KycStatus.GRANTED) {
            revert KycRequired(account);
        }
    }

    function _requireAutomationSolvent() private view {
        if (address(this).balance < reservedAutomation) {
            revert AutomationInsolvent(address(this).balance, reservedAutomation);
        }
    }
}
