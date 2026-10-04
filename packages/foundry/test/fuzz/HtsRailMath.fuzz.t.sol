// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralRailHts} from "../../contracts/AtsCollateralRailHts.sol";
import {TestBase} from "../TestBase.sol";
import {AtsCollateralRailHtsHarness} from "../mocks/AtsCollateralRailHtsHarness.sol";
import {MockAtsToken} from "../mocks/MockAtsToken.sol";
import {MockHtsToken} from "../mocks/MockHtsToken.sol";
import {MockUsdOracle} from "../mocks/MockUsdOracle.sol";

contract HtsRailMathFuzzTest is TestBase {
    bytes32 private constant PARTITION = keccak256("HTS_MATH");

    MockAtsToken private ats;
    MockHtsToken private token;
    MockUsdOracle private oracle;
    AtsCollateralRailHtsHarness private rail;

    function setUp() public {
        ats = new MockAtsToken();
        token = new MockHtsToken();
        oracle = new MockUsdOracle();
        rail = _deploy(token);
        rail.initializeSettlement();
    }

    function testFuzzTokenUnitsToUsdRoundsDebtUp(uint256 rawUnits, uint256 rawPrice) public view {
        uint256 tokenUnits = rawUnits % rail.MAX_TRANSFER_AMOUNT() + 1;
        uint256 priceUsdE8 = rawPrice % 1_000_000_000_000 + 1;
        uint256 product = tokenUnits * priceUsdE8;
        uint256 expected = (product + 1_000_000 - 1) / 1_000_000;
        assertEq(rail.tokenUnitsToUsdE8(tokenUnits, priceUsdE8), expected);
    }

    function testFuzzMaximumTokenPrincipalRoundsDown(uint256 rawPrice) public view {
        uint256 priceUsdE8 = rawPrice % 1_000_000_000_000 + 1;
        uint256 expectedMaximumUsdE8 = 60 * 1e8;
        uint256 expected = expectedMaximumUsdE8 * 1_000_000 / priceUsdE8;
        assertEq(rail.maximumPrincipalTokenUnits(100, priceUsdE8), expected);
    }

    function testFuzzInterestRoundsUp(uint256 rawPrincipal, uint16 rawRate, uint64 rawTerm) public view {
        uint256 principal = rawPrincipal % rail.MAX_TRANSFER_AMOUNT() + 1;
        uint256 rate = uint256(rawRate) % 10_001;
        uint256 term = uint256(rawTerm) % 365 days + 1;
        uint256 numerator = principal * rate * term;
        uint256 denominator = 10_000 * uint256(365 days);
        uint256 interest = numerator == 0 ? 0 : (numerator + denominator - 1) / denominator;
        assertEq(rail.repaymentTokenUnits(principal, rate, term), principal + interest);
    }

    function testEverySupportedDecimalBoundaryFromZeroThroughEighteen() public {
        for (uint8 decimals = 0; decimals <= 18; ++decimals) {
            MockHtsToken decimalToken = new MockHtsToken();
            decimalToken.setMetadata(int32(uint32(decimals)), false, true, false);
            AtsCollateralRailHtsHarness decimalRail = _deploy(decimalToken);
            decimalRail.initializeSettlement();

            uint256 scale = 10 ** decimals;
            assertEq(decimalRail.settlementDecimals(), decimals);
            assertEq(decimalRail.maximumPrincipalTokenUnits(100, 1e8), 60 * scale);
            assertEq(decimalRail.tokenUnitsToUsdE8(1, 1e8), (1e8 + scale - 1) / scale);
        }
    }

    function testOneUnitRemaindersUseOppositeConservativeDirections() public view {
        assertEq(rail.tokenUnitsToUsdE8(1, 100_000_001), 101);
        assertEq(rail.maximumPrincipalTokenUnits(100, 100_000_001), 59_999_999);
        assertEq(rail.repaymentTokenUnits(1, 1, 120), 2);
    }

    function _deploy(MockHtsToken token_) internal returns (AtsCollateralRailHtsHarness) {
        AtsCollateralRailHts.RailPolicy memory policy = AtsCollateralRailHts.RailPolicy({
            maximumAdvanceBps: 6_000,
            maximumAnnualRateBps: 10_000,
            maximumQuoteMovementBps: 100,
            minimumTermSeconds: 2 minutes,
            maximumTermSeconds: 365 days,
            maximumOfferLifetimeSeconds: 2 hours
        });
        return new AtsCollateralRailHtsHarness(ats, PARTITION, token_, oracle, 2, 100 * 1e8, policy, address(this));
    }
}
