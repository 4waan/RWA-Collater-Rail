// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClprApplicationBase} from "./ClprApplicationBase.sol";
import {ClprMobilityTypes} from "./ClprMobilityTypes.sol";
import {IClprServiceMinimal} from "./IClprApplication.sol";

interface IERC20MobilitySettlement {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}

/// @notice Experimental peer-ledger escrow for a controlled six-decimal test token.
contract RemoteCashEscrow is ClprApplicationBase {
    enum OfferState {
        NONE,
        FUNDED,
        COLLATERAL_LOCKED,
        PRINCIPAL_WITHDRAWN,
        REPAYMENT_ESCROWED,
        REPAID,
        DEFAULTED,
        CANCELLED
    }

    struct RemoteOffer {
        ClprMobilityTypes.Terms terms;
        bytes32 termsHash;
        uint64 principalWithdrawnAt;
        OfferState state;
    }

    IERC20MobilitySettlement public immutable settlementToken;
    uint8 public constant SETTLEMENT_DECIMALS = 6;
    uint64 public constant MIN_TERM = 2 minutes;
    uint64 public constant MAX_TERM = 365 days;
    uint64 public constant MAX_OFFER_LIFETIME = 7 days;

    uint256 public offerSequence;
    uint256 public fundedPrincipalLiability;
    uint256 public pendingRepaymentLiability;
    uint256 public tokenCreditsLiability;
    uint256 public cashTokenLiabilities;

    mapping(bytes32 mobilityId => RemoteOffer offer) public offers;
    mapping(address account => uint256 amount) public credits;

    error InvalidTerms();
    error UnsupportedDecimals(uint8 actual);
    error NotLender();
    error NotBorrower();
    error InvalidOfferState(OfferState actual);
    error OfferExpired();
    error OfferStillActive();
    error TokenTransferFailed();
    error UnexpectedTokenDelta(uint256 expected, uint256 actual);
    error NothingToWithdraw();
    error Insolvent(uint256 balance, uint256 liabilities);
    error UnsupportedMessage(ClprMobilityTypes.MessageKind kind);
    error TermsMismatch();

    event RemoteOfferFunded(
        bytes32 indexed mobilityId, address indexed lender, address indexed borrower, uint256 amount
    );
    event RemoteOfferCancelled(bytes32 indexed mobilityId, address indexed lender, uint256 amount);
    event RemoteCollateralConfirmed(bytes32 indexed mobilityId);
    event RemotePrincipalWithdrawn(bytes32 indexed mobilityId, address indexed borrower, uint256 amount);
    event RemoteRepaymentEscrowed(bytes32 indexed mobilityId, address indexed borrower, uint256 amount);
    event RemoteRepaymentAccepted(bytes32 indexed mobilityId, address indexed lender, uint256 amount);
    event RemoteDefaultConfirmed(bytes32 indexed mobilityId, address indexed borrower, uint256 refund);
    event RemoteCreditWithdrawn(address indexed account, uint256 amount);

    constructor(
        IERC20MobilitySettlement settlementToken_,
        IClprServiceMinimal clprService_,
        bytes32 channelId_,
        bytes32 connectorId_,
        address configurationOwner_,
        address peerApplication_,
        bytes32 localDomain_,
        bytes32 peerDomain_
    )
        ClprApplicationBase(
            clprService_, channelId_, connectorId_, configurationOwner_, peerApplication_, localDomain_, peerDomain_
        )
    {
        if (address(settlementToken_) == address(0)) revert ZeroAddress();
        uint8 decimals_ = settlementToken_.decimals();
        if (decimals_ != SETTLEMENT_DECIMALS) revert UnsupportedDecimals(decimals_);
        settlementToken = settlementToken_;
    }

    function fundOffer(ClprMobilityTypes.Terms calldata terms)
        external
        nonReentrant
        returns (bytes32 mobilityId, bytes32 outboxId)
    {
        _validateTerms(terms);
        if (terms.lender != msg.sender) revert NotLender();

        _pullExact(msg.sender, terms.principalTokenUnits);
        mobilityId = keccak256(abi.encode(address(this), block.chainid, ++offerSequence, terms));
        bytes32 termsHash = ClprMobilityTypes.hashTerms(terms);
        offers[mobilityId] =
            RemoteOffer({terms: terms, termsHash: termsHash, principalWithdrawnAt: 0, state: OfferState.FUNDED});
        fundedPrincipalLiability += terms.principalTokenUnits;
        cashTokenLiabilities += terms.principalTokenUnits;
        outboxId = _queueMessage(
            ClprMobilityTypes.MessageKind.OFFER_FUNDED,
            mobilityId,
            1,
            terms.offerExpiresAt,
            termsHash,
            abi.encode(terms)
        );
        _requireSolvent();
        emit RemoteOfferFunded(mobilityId, terms.lender, terms.borrower, terms.principalTokenUnits);
    }

    function cancelOffer(bytes32 mobilityId) external nonReentrant returns (bytes32 outboxId) {
        RemoteOffer storage offer = offers[mobilityId];
        if (offer.terms.lender != msg.sender) revert NotLender();
        if (offer.state == OfferState.COLLATERAL_LOCKED && block.timestamp <= offer.terms.offerExpiresAt) {
            revert OfferStillActive();
        }
        if (offer.state != OfferState.FUNDED && offer.state != OfferState.COLLATERAL_LOCKED) {
            revert InvalidOfferState(offer.state);
        }

        offer.state = OfferState.CANCELLED;
        fundedPrincipalLiability -= offer.terms.principalTokenUnits;
        tokenCreditsLiability += offer.terms.principalTokenUnits;
        credits[offer.terms.lender] += offer.terms.principalTokenUnits;
        outboxId =
            _queueMessage(ClprMobilityTypes.MessageKind.OFFER_CANCELLED, mobilityId, 1, 0, offer.termsHash, bytes(""));
        _requireSolvent();
        emit RemoteOfferCancelled(mobilityId, offer.terms.lender, offer.terms.principalTokenUnits);
    }

    function withdrawPrincipal(bytes32 mobilityId) external nonReentrant returns (bytes32 outboxId) {
        RemoteOffer storage offer = offers[mobilityId];
        if (offer.terms.borrower != msg.sender) revert NotBorrower();
        if (offer.state != OfferState.COLLATERAL_LOCKED) revert InvalidOfferState(offer.state);
        if (block.timestamp > offer.terms.offerExpiresAt) revert OfferExpired();

        offer.state = OfferState.PRINCIPAL_WITHDRAWN;
        offer.principalWithdrawnAt = uint64(block.timestamp);
        fundedPrincipalLiability -= offer.terms.principalTokenUnits;
        cashTokenLiabilities -= offer.terms.principalTokenUnits;
        _pushExact(msg.sender, offer.terms.principalTokenUnits);
        outboxId = _queueMessage(
            ClprMobilityTypes.MessageKind.PRINCIPAL_WITHDRAWN,
            mobilityId,
            1,
            0,
            offer.termsHash,
            abi.encode(offer.principalWithdrawnAt)
        );
        _requireSolvent();
        emit RemotePrincipalWithdrawn(mobilityId, msg.sender, offer.terms.principalTokenUnits);
    }

    function escrowRepayment(bytes32 mobilityId) external nonReentrant returns (bytes32 outboxId) {
        RemoteOffer storage offer = offers[mobilityId];
        if (offer.terms.borrower != msg.sender) revert NotBorrower();
        if (offer.state != OfferState.PRINCIPAL_WITHDRAWN) revert InvalidOfferState(offer.state);

        _pullExact(msg.sender, offer.terms.repaymentTokenUnits);
        offer.state = OfferState.REPAYMENT_ESCROWED;
        pendingRepaymentLiability += offer.terms.repaymentTokenUnits;
        cashTokenLiabilities += offer.terms.repaymentTokenUnits;
        outboxId = _queueMessage(
            ClprMobilityTypes.MessageKind.REPAYMENT_ESCROWED, mobilityId, 1, 0, offer.termsHash, bytes("")
        );
        _requireSolvent();
        emit RemoteRepaymentEscrowed(mobilityId, msg.sender, offer.terms.repaymentTokenUnits);
    }

    function withdrawCredit() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credits[msg.sender] = 0;
        tokenCreditsLiability -= amount;
        cashTokenLiabilities -= amount;
        _pushExact(msg.sender, amount);
        _requireSolvent();
        emit RemoteCreditWithdrawn(msg.sender, amount);
    }

    function requiredBacking() external view returns (uint256) {
        return fundedPrincipalLiability + pendingRepaymentLiability + tokenCreditsLiability;
    }

    function getOffer(bytes32 mobilityId) external view returns (RemoteOffer memory) {
        return offers[mobilityId];
    }

    function _handleClprMessage(ClprMobilityTypes.Message memory message) internal override returns (bytes memory) {
        RemoteOffer storage offer = offers[message.mobilityId];
        if (offer.termsHash != message.termsHash) revert TermsMismatch();

        if (message.kind == ClprMobilityTypes.MessageKind.COLLATERAL_LOCKED) {
            if (offer.state != OfferState.FUNDED) revert InvalidOfferState(offer.state);
            offer.state = OfferState.COLLATERAL_LOCKED;
            emit RemoteCollateralConfirmed(message.mobilityId);
        } else if (message.kind == ClprMobilityTypes.MessageKind.REPAYMENT_ACCEPTED) {
            if (offer.state != OfferState.REPAYMENT_ESCROWED) revert InvalidOfferState(offer.state);
            offer.state = OfferState.REPAID;
            pendingRepaymentLiability -= offer.terms.repaymentTokenUnits;
            tokenCreditsLiability += offer.terms.repaymentTokenUnits;
            credits[offer.terms.lender] += offer.terms.repaymentTokenUnits;
            emit RemoteRepaymentAccepted(message.mobilityId, offer.terms.lender, offer.terms.repaymentTokenUnits);
        } else if (message.kind == ClprMobilityTypes.MessageKind.DEFAULT_CONFIRMED) {
            if (offer.state != OfferState.PRINCIPAL_WITHDRAWN && offer.state != OfferState.REPAYMENT_ESCROWED) {
                revert InvalidOfferState(offer.state);
            }
            uint256 refund;
            if (offer.state == OfferState.REPAYMENT_ESCROWED) {
                refund = offer.terms.repaymentTokenUnits;
                pendingRepaymentLiability -= refund;
                tokenCreditsLiability += refund;
                credits[offer.terms.borrower] += refund;
            }
            offer.state = OfferState.DEFAULTED;
            emit RemoteDefaultConfirmed(message.mobilityId, offer.terms.borrower, refund);
        } else {
            revert UnsupportedMessage(message.kind);
        }

        _requireSolvent();
        return abi.encode(message.mobilityId, message.kind);
    }

    function _validateTerms(ClprMobilityTypes.Terms calldata terms) private view {
        if (
            terms.lender == address(0) || terms.borrower == address(0) || terms.lender == terms.borrower
                || terms.collateralAmount == 0 || terms.principalTokenUnits == 0
                || terms.repaymentTokenUnits < terms.principalTokenUnits || terms.termSeconds < MIN_TERM
                || terms.termSeconds > MAX_TERM || terms.offerExpiresAt <= block.timestamp
                || terms.offerExpiresAt > block.timestamp + MAX_OFFER_LIFETIME
        ) revert InvalidTerms();
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = settlementToken.balanceOf(address(this));
        (bool success, bytes memory result) = address(settlementToken)
            .call(abi.encodeCall(IERC20MobilitySettlement.transferFrom, (from, address(this), amount)));
        if (!success || result.length != 32 || !abi.decode(result, (bool))) revert TokenTransferFailed();
        uint256 delta = settlementToken.balanceOf(address(this)) - beforeBalance;
        if (delta != amount) revert UnexpectedTokenDelta(amount, delta);
    }

    function _pushExact(address to, uint256 amount) private {
        uint256 beforeBalance = settlementToken.balanceOf(address(this));
        (bool success, bytes memory result) =
            address(settlementToken).call(abi.encodeCall(IERC20MobilitySettlement.transfer, (to, amount)));
        if (!success || result.length != 32 || !abi.decode(result, (bool))) revert TokenTransferFailed();
        uint256 afterBalance = settlementToken.balanceOf(address(this));
        if (afterBalance > beforeBalance) revert UnexpectedTokenDelta(amount, 0);
        uint256 delta = beforeBalance - afterBalance;
        if (delta != amount) revert UnexpectedTokenDelta(amount, delta);
    }

    function _requireSolvent() private view {
        uint256 balance = settlementToken.balanceOf(address(this));
        if (
            cashTokenLiabilities != fundedPrincipalLiability + pendingRepaymentLiability + tokenCreditsLiability
                || balance < cashTokenLiabilities
        ) revert Insolvent(balance, cashTokenLiabilities);
    }
}
