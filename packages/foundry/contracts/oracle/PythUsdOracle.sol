// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPyth} from "../interfaces/IPyth.sol";
import {IUsdOracle} from "../interfaces/IUsdOracle.sol";

/// @title PythUsdOracle
/// @notice Normalizes one configured Pyth USD feed to eight decimals.
contract PythUsdOracle is IUsdOracle {
    uint256 public constant MAX_PRICE_AGE = 120 seconds;
    uint256 public constant MAX_CONFIDENCE_BPS = 200;
    uint256 public constant BPS = 10_000;

    IPyth public immutable pyth;
    bytes32 public immutable priceId;

    error IncorrectUpdateFee(uint256 supplied, uint256 required);
    error InvalidPrice();
    error InvalidExponent(int32 exponent);
    error StalePrice(uint256 publishTime, uint256 currentTime);
    error ConfidenceTooWide(uint256 confidence, uint256 price);

    event PriceUpdated(uint256 feePaid, uint256 priceUsdE8, uint64 publishTime);

    constructor(IPyth pyth_, bytes32 priceId_) {
        if (address(pyth_) == address(0) || priceId_ == bytes32(0)) revert InvalidPrice();
        pyth = pyth_;
        priceId = priceId_;
    }

    function updatePrice(bytes[] calldata updateData)
        external
        payable
        returns (uint256 priceUsdE8, uint256 confidenceUsdE8, uint64 publishTime)
    {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value != fee) revert IncorrectUpdateFee(msg.value, fee);
        pyth.updatePriceFeeds{value: fee}(updateData);
        (priceUsdE8, confidenceUsdE8, publishTime) = latestUsdPrice();
        emit PriceUpdated(fee, priceUsdE8, publishTime);
    }

    function latestUsdPrice() public view returns (uint256 priceUsdE8, uint256 confidenceUsdE8, uint64 publishTime) {
        IPyth.Price memory quote = pyth.getPriceNoOlderThan(priceId, MAX_PRICE_AGE);
        if (quote.price <= 0 || quote.publishTime > type(uint64).max) revert InvalidPrice();
        if (block.timestamp > quote.publishTime + MAX_PRICE_AGE) {
            revert StalePrice(quote.publishTime, block.timestamp);
        }

        priceUsdE8 = _scaleToE8(uint64(quote.price), quote.expo, false);
        confidenceUsdE8 = _scaleToE8(quote.conf, quote.expo, true);
        if (priceUsdE8 == 0) revert InvalidPrice();
        if (confidenceUsdE8 * BPS > priceUsdE8 * MAX_CONFIDENCE_BPS) {
            revert ConfidenceTooWide(confidenceUsdE8, priceUsdE8);
        }
        publishTime = uint64(quote.publishTime);
    }

    function _scaleToE8(uint64 value, int32 exponent, bool roundUp) internal pure returns (uint256 scaled) {
        int256 shift = int256(exponent) + 8;
        if (shift > 38 || shift < -38) revert InvalidExponent(exponent);
        if (shift >= 0) return uint256(value) * (10 ** uint256(shift));

        uint256 divisor = 10 ** uint256(-shift);
        scaled = uint256(value) / divisor;
        if (roundUp && uint256(value) % divisor != 0) ++scaled;
    }
}
