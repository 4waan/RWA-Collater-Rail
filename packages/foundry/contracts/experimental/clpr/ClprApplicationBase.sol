// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyLock} from "../../utils/ReentrancyLock.sol";
import {ClprMobilityTypes} from "./ClprMobilityTypes.sol";
import {IClprApplication, IClprServiceMinimal} from "./IClprApplication.sol";

abstract contract ClprApplicationBase is IClprApplication, ReentrancyLock {
    struct OutboxItem {
        ClprMobilityTypes.Message message;
        bool exists;
        bool dispatched;
        uint64 clprMessageId;
    }

    IClprServiceMinimal public immutable clprService;
    bytes32 public immutable channelId;
    bytes32 public immutable connectorId;
    address public immutable configurationOwner;
    address public peerApplication;
    bytes32 public immutable localDomain;
    bytes32 public immutable peerDomain;

    uint256 public outboxSequence;
    mapping(bytes32 outboxId => OutboxItem item) internal _outbox;
    mapping(bytes32 mobilityId => mapping(ClprMobilityTypes.MessageKind kind => bytes32 outboxId)) public latestOutbox;
    mapping(bytes32 semanticKey => bytes32 payloadHash) public receivedPayloadHash;
    mapping(bytes32 semanticKey => bytes response) internal _receivedResponse;
    mapping(bytes32 logicalKey => bytes32 contentHash) public receivedLogicalContentHash;
    mapping(bytes32 logicalKey => bytes response) internal _receivedLogicalResponse;

    error ZeroAddress();
    error InvalidClprConfiguration();
    error ConfigurationOwnerOnly();
    error PeerAlreadyConfigured();
    error ClprServiceOnly();
    error WrongChannel();
    error WrongPeerApplication();
    error InvalidMessage();
    error MessageExpired(uint256 currentTime, uint256 expiry);
    error ReplayConflict(bytes32 semanticKey);
    error OutboxItemNotFound();
    error OutboxItemAlreadyDispatched();

    event OutboxQueued(
        bytes32 indexed outboxId, bytes32 indexed mobilityId, ClprMobilityTypes.MessageKind indexed kind, uint32 attempt
    );
    event OutboxDispatched(bytes32 indexed outboxId, uint64 indexed clprMessageId);
    event MessageReceived(
        bytes32 indexed semanticKey, bytes32 indexed mobilityId, ClprMobilityTypes.MessageKind indexed kind
    );
    event ClprResponseObserved(bytes32 indexed channelId, uint64 indexed messageId, uint8 status, bytes responseData);

    constructor(
        IClprServiceMinimal clprService_,
        bytes32 channelId_,
        bytes32 connectorId_,
        address configurationOwner_,
        address peerApplication_,
        bytes32 localDomain_,
        bytes32 peerDomain_
    ) {
        if (address(clprService_) == address(0) || configurationOwner_ == address(0)) {
            revert ZeroAddress();
        }
        if (
            channelId_ == bytes32(0) || connectorId_ == bytes32(0) || localDomain_ == bytes32(0)
                || peerDomain_ == bytes32(0) || localDomain_ == peerDomain_
        ) revert InvalidClprConfiguration();
        clprService = clprService_;
        channelId = channelId_;
        connectorId = connectorId_;
        configurationOwner = configurationOwner_;
        peerApplication = peerApplication_;
        localDomain = localDomain_;
        peerDomain = peerDomain_;
    }

    function initializePeerApplication(address peerApplication_) external {
        if (msg.sender != configurationOwner) revert ConfigurationOwnerOnly();
        if (peerApplication != address(0)) revert PeerAlreadyConfigured();
        if (peerApplication_ == address(0)) revert ZeroAddress();
        peerApplication = peerApplication_;
    }

    function getOutboxItem(bytes32 outboxId) external view returns (OutboxItem memory) {
        return _outbox[outboxId];
    }

    function dispatchMessage(bytes32 outboxId) external nonReentrant returns (uint64 messageId) {
        OutboxItem storage item = _outbox[outboxId];
        if (!item.exists) revert OutboxItemNotFound();
        if (item.dispatched) revert OutboxItemAlreadyDispatched();

        messageId = clprService.sendMessage(
            channelId, connectorId, abi.encodePacked(peerApplication), abi.encode(item.message)
        );
        item.dispatched = true;
        item.clprMessageId = messageId;
        emit OutboxDispatched(outboxId, messageId);
    }

    function retryMessage(bytes32 outboxId) external nonReentrant returns (bytes32 retryOutboxId) {
        OutboxItem storage original = _outbox[outboxId];
        if (!original.exists || !original.dispatched) revert OutboxItemNotFound();
        ClprMobilityTypes.Message memory message = original.message;
        message.attempt += 1;
        retryOutboxId = _storeOutbox(message);
    }

    function onClprMessage(bytes32 suppliedChannelId, bytes calldata sender, bytes calldata messageData)
        external
        nonReentrant
        returns (bytes memory responseData)
    {
        if (msg.sender != address(clprService)) revert ClprServiceOnly();
        if (suppliedChannelId != channelId) revert WrongChannel();
        if (sender.length != 20 || address(bytes20(sender)) != peerApplication) revert WrongPeerApplication();

        ClprMobilityTypes.Message memory message = abi.decode(messageData, (ClprMobilityTypes.Message));
        _validateEnvelope(message);

        bytes32 semanticKey = ClprMobilityTypes.semanticKey(message);
        bytes32 payloadHash = keccak256(messageData);
        bytes32 priorHash = receivedPayloadHash[semanticKey];
        if (priorHash != bytes32(0)) {
            if (priorHash != payloadHash) revert ReplayConflict(semanticKey);
            return _receivedResponse[semanticKey];
        }

        bytes32 logicalKey = ClprMobilityTypes.logicalKey(message);
        bytes32 logicalContentHash = ClprMobilityTypes.logicalContentHash(message);
        bytes32 priorLogicalHash = receivedLogicalContentHash[logicalKey];
        if (priorLogicalHash != bytes32(0)) {
            if (priorLogicalHash != logicalContentHash) revert ReplayConflict(logicalKey);
            responseData = _receivedLogicalResponse[logicalKey];
            receivedPayloadHash[semanticKey] = payloadHash;
            _receivedResponse[semanticKey] = responseData;
            emit MessageReceived(semanticKey, message.mobilityId, message.kind);
            return responseData;
        }

        responseData = _handleClprMessage(message);
        receivedPayloadHash[semanticKey] = payloadHash;
        _receivedResponse[semanticKey] = responseData;
        receivedLogicalContentHash[logicalKey] = logicalContentHash;
        _receivedLogicalResponse[logicalKey] = responseData;
        emit MessageReceived(semanticKey, message.mobilityId, message.kind);
    }

    function onClprResponse(bytes32 suppliedChannelId, uint64 messageId, uint8 status, bytes calldata responseData)
        external
    {
        if (msg.sender != address(clprService)) revert ClprServiceOnly();
        if (suppliedChannelId != channelId) revert WrongChannel();
        emit ClprResponseObserved(suppliedChannelId, messageId, status, responseData);
    }

    function _queueMessage(
        ClprMobilityTypes.MessageKind kind,
        bytes32 mobilityId,
        uint32 attempt,
        uint64 expiresAt,
        bytes32 termsHash,
        bytes memory body
    ) internal returns (bytes32 outboxId) {
        if (peerApplication == address(0)) revert InvalidClprConfiguration();
        ClprMobilityTypes.Message memory message = ClprMobilityTypes.Message({
            version: ClprMobilityTypes.PROTOCOL_VERSION,
            kind: kind,
            mobilityId: mobilityId,
            attempt: attempt,
            sourceDomain: localDomain,
            destinationDomain: peerDomain,
            sourceApplication: address(this),
            destinationApplication: peerApplication,
            sourceTimestamp: uint64(block.timestamp),
            expiresAt: expiresAt,
            termsHash: termsHash,
            body: body
        });
        outboxId = _storeOutbox(message);
    }

    function _storeOutbox(ClprMobilityTypes.Message memory message) private returns (bytes32 outboxId) {
        outboxId = keccak256(
            abi.encode(
                address(this), block.chainid, ++outboxSequence, message.mobilityId, message.kind, message.attempt
            )
        );
        _outbox[outboxId] = OutboxItem({message: message, exists: true, dispatched: false, clprMessageId: 0});
        latestOutbox[message.mobilityId][message.kind] = outboxId;
        emit OutboxQueued(outboxId, message.mobilityId, message.kind, message.attempt);
    }

    function _validateEnvelope(ClprMobilityTypes.Message memory message) private view {
        if (
            message.version != ClprMobilityTypes.PROTOCOL_VERSION || message.kind == ClprMobilityTypes.MessageKind.NONE
                || message.mobilityId == bytes32(0) || message.sourceDomain != peerDomain
                || message.destinationDomain != localDomain || message.sourceApplication != peerApplication
                || message.destinationApplication != address(this) || message.termsHash == bytes32(0)
        ) revert InvalidMessage();
        if (message.expiresAt != 0 && block.timestamp > message.expiresAt) {
            revert MessageExpired(block.timestamp, message.expiresAt);
        }
    }

    function _handleClprMessage(ClprMobilityTypes.Message memory message)
        internal
        virtual
        returns (bytes memory responseData);
}
