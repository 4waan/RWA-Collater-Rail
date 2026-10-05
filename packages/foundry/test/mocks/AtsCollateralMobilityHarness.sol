// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralMobility} from "../../contracts/experimental/clpr/AtsCollateralMobility.sol";
import {IClprServiceMinimal} from "../../contracts/experimental/clpr/IClprApplication.sol";
import {IAtsCollateralToken} from "../../contracts/interfaces/IAtsCollateralToken.sol";

contract AtsCollateralMobilityHarness is AtsCollateralMobility {
    bool public schedulingAvailable = true;
    address public nextScheduleAddress = address(0x1234);

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
    )
        AtsCollateralMobility(
            atsToken_,
            partition_,
            tokenDecimals_,
            nominalValueUsdE8_,
            policy_,
            owner_,
            clprService_,
            channelId_,
            connectorId_,
            peerApplication_,
            localDomain_,
            peerDomain_
        )
    {}

    function setSchedulingAvailable(bool available) external {
        schedulingAvailable = available;
    }

    function schedulePosition(bytes32, uint64)
        external
        override
        returns (int64 responseCode, address scheduleAddress, bool capacity)
    {
        if (msg.sender != address(this)) revert SelfCallOnly();
        if (!schedulingAvailable) return (0, address(0), false);
        return (HEDERA_SUCCESS, nextScheduleAddress, true);
    }
}
