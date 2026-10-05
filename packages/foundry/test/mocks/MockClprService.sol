// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IClprApplication, IClprServiceMinimal} from "../../contracts/experimental/clpr/IClprApplication.sol";

contract MockClprService is IClprServiceMinimal {
    struct QueuedMessage {
        bytes32 channelId;
        bytes32 connectorId;
        address sender;
        address target;
        bytes data;
    }

    QueuedMessage[] private _messages;
    bool public failSend;

    error MockSendFailed();
    error InvalidTarget();

    function setFailSend(bool fail) external {
        failSend = fail;
    }

    function sendMessage(
        bytes32 channelId,
        bytes32 connectorId,
        bytes calldata targetApplication,
        bytes calldata messageData
    ) external returns (uint64 messageId) {
        if (failSend) revert MockSendFailed();
        if (targetApplication.length != 20) revert InvalidTarget();
        address target = address(bytes20(targetApplication));
        _messages.push(
            QueuedMessage({
                channelId: channelId, connectorId: connectorId, sender: msg.sender, target: target, data: messageData
            })
        );
        messageId = uint64(_messages.length);
    }

    function messageCount() external view returns (uint256) {
        return _messages.length;
    }

    function messageAt(uint256 index) external view returns (QueuedMessage memory) {
        return _messages[index];
    }

    function deliver(uint256 index) external returns (bytes memory response) {
        QueuedMessage storage queued = _messages[index];
        return
            IClprApplication(queued.target)
                .onClprMessage(queued.channelId, abi.encodePacked(queued.sender), queued.data);
    }

    function deliverRaw(address target, bytes32 channelId, address sender, bytes calldata data)
        external
        returns (bytes memory response)
    {
        return IClprApplication(target).onClprMessage(channelId, abi.encodePacked(sender), data);
    }

    function deliverResponse(address target, bytes32 channelId, uint64 messageId, uint8 status, bytes calldata data)
        external
    {
        IClprApplication(target).onClprResponse(channelId, messageId, status, data);
    }
}
