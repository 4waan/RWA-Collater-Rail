// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ClprMobilityTypes {
    uint16 internal constant PROTOCOL_VERSION = 1;

    enum MessageKind {
        NONE,
        OFFER_FUNDED,
        COLLATERAL_LOCKED,
        PRINCIPAL_WITHDRAWN,
        OFFER_CANCELLED,
        REPAYMENT_ESCROWED,
        REPAYMENT_ACCEPTED,
        DEFAULT_CONFIRMED
    }

    struct Terms {
        address lender;
        address borrower;
        uint128 collateralAmount;
        uint128 principalTokenUnits;
        uint128 repaymentTokenUnits;
        uint64 termSeconds;
        uint64 offerExpiresAt;
    }

    struct Message {
        uint16 version;
        MessageKind kind;
        bytes32 mobilityId;
        uint32 attempt;
        bytes32 sourceDomain;
        bytes32 destinationDomain;
        address sourceApplication;
        address destinationApplication;
        uint64 sourceTimestamp;
        uint64 expiresAt;
        bytes32 termsHash;
        bytes body;
    }

    function hashTerms(Terms memory terms) internal pure returns (bytes32) {
        return keccak256(abi.encode(terms));
    }

    function semanticKey(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                message.version,
                message.kind,
                message.mobilityId,
                message.attempt,
                message.sourceDomain,
                message.destinationDomain,
                message.sourceApplication,
                message.destinationApplication
            )
        );
    }

    function logicalKey(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                message.version,
                message.kind,
                message.mobilityId,
                message.sourceDomain,
                message.destinationDomain,
                message.sourceApplication,
                message.destinationApplication,
                message.termsHash
            )
        );
    }

    function logicalContentHash(Message memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                message.version,
                message.kind,
                message.mobilityId,
                message.sourceDomain,
                message.destinationDomain,
                message.sourceApplication,
                message.destinationApplication,
                message.sourceTimestamp,
                message.expiresAt,
                message.termsHash,
                message.body
            )
        );
    }
}
