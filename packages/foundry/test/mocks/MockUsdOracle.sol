// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUsdOracle} from "../../contracts/interfaces/IUsdOracle.sol";

contract MockUsdOracle is IUsdOracle {
    uint256 public priceUsdE8 = 100_000_000;
    uint256 public confidenceUsdE8;
    uint64 public publishTime;

    function setQuote(uint256 priceUsdE8_, uint256 confidenceUsdE8_, uint64 publishTime_) external {
        priceUsdE8 = priceUsdE8_;
        confidenceUsdE8 = confidenceUsdE8_;
        publishTime = publishTime_;
    }

    function latestUsdPrice() external view returns (uint256, uint256, uint64) {
        return (priceUsdE8, confidenceUsdE8, publishTime == 0 ? uint64(block.timestamp) : publishTime);
    }
}
