// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUsdOracle} from "../interfaces/IUsdOracle.sol";

/// @title FixedTestUsdOracle
/// @notice Test-only fixed USD price source for controlled HTS mechanics.
/// @dev Never use this oracle to make a market-value or stablecoin claim.
contract FixedTestUsdOracle is IUsdOracle {
    uint256 public immutable fixedPriceUsdE8;

    error InvalidTestPrice();

    constructor(uint256 fixedPriceUsdE8_) {
        if (fixedPriceUsdE8_ == 0) revert InvalidTestPrice();
        fixedPriceUsdE8 = fixedPriceUsdE8_;
    }

    function latestUsdPrice() external view returns (uint256 priceUsdE8, uint256 confidenceUsdE8, uint64 publishTime) {
        return (fixedPriceUsdE8, 0, uint64(block.timestamp));
    }
}
