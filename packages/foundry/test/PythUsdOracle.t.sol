// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MockPyth} from "./mocks/MockPyth.sol";
import {PythUsdOracle} from "../contracts/oracle/PythUsdOracle.sol";
import {FixedTestUsdOracle} from "../contracts/oracle/FixedTestUsdOracle.sol";

contract PythUsdOracleTest is TestBase {
    bytes32 internal constant USDC_USD_PRICE_ID = 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a;

    MockPyth internal pyth;
    PythUsdOracle internal oracle;

    function setUp() public {
        vm.warp(1_000_000);
        pyth = new MockPyth();
        oracle = new PythUsdOracle(pyth, USDC_USD_PRICE_ID);
        pyth.setPrice(99_999_900, 10_000, -8, block.timestamp);
    }

    function testUsesPinnedUsdcFeedAndNormalizesToE8() public view {
        assertEq(oracle.priceId(), USDC_USD_PRICE_ID);
        (uint256 price, uint256 confidence, uint64 publishTime) = oracle.latestUsdPrice();
        assertEq(price, 99_999_900);
        assertEq(confidence, 10_000);
        assertEq(publishTime, block.timestamp);
    }

    function testRejectsStaleAndWideConfidenceQuotes() public {
        pyth.setPrice(100_000_000, 1, -8, block.timestamp - 121);
        vm.expectRevert(
            abi.encodeWithSelector(PythUsdOracle.StalePrice.selector, block.timestamp - 121, block.timestamp)
        );
        oracle.latestUsdPrice();

        pyth.setPrice(100_000_000, 2_000_001, -8, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(PythUsdOracle.ConfidenceTooWide.selector, uint256(2_000_001), uint256(100_000_000))
        );
        oracle.latestUsdPrice();
    }

    function testPaysExactUpdateFee() public {
        pyth.setUpdateFee(7);
        bytes[] memory updates = new bytes[](1);
        updates[0] = hex"1234";
        vm.deal(address(this), 7);
        oracle.updatePrice{value: 7}(updates);
        assertEq(pyth.lastValue(), 7);

        vm.expectRevert(abi.encodeWithSelector(PythUsdOracle.IncorrectUpdateFee.selector, uint256(0), uint256(7)));
        oracle.updatePrice(updates);
    }

    function testFixedOracleIsExplicitAndCurrentForControlledTests() public {
        FixedTestUsdOracle fixedOracle = new FixedTestUsdOracle(100_000_000);
        (uint256 price, uint256 confidence, uint64 publishTime) = fixedOracle.latestUsdPrice();
        assertEq(price, 100_000_000);
        assertEq(confidence, 0);
        assertEq(publishTime, block.timestamp);
    }
}
