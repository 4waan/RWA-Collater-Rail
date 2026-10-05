// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IClprApplication {
    function onClprMessage(bytes32 channelId, bytes calldata sender, bytes calldata messageData)
        external
        returns (bytes memory responseData);

    function onClprResponse(bytes32 channelId, uint64 messageId, uint8 status, bytes calldata responseData) external;
}

interface IClprServiceMinimal {
    function sendMessage(
        bytes32 channelId,
        bytes32 connectorId,
        bytes calldata targetApplication,
        bytes calldata messageData
    ) external returns (uint64 messageId);
}
