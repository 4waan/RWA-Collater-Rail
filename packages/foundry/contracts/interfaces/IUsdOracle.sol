// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A USD price source normalized to eight decimal places.
interface IUsdOracle {
    function latestUsdPrice() external view returns (uint256 priceUsdE8, uint256 confidenceUsdE8, uint64 publishTime);
}
