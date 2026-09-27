// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {AtsCollateralRailHts} from "../contracts/AtsCollateralRailHts.sol";
import {HtsRailAcceptance, IHtsRailReadiness} from "../contracts/verifiers/HtsRailAcceptance.sol";
import {AtsCollateralRailHtsHarness} from "./mocks/AtsCollateralRailHtsHarness.sol";
import {MockAtsToken} from "./mocks/MockAtsToken.sol";
import {MockHtsToken} from "./mocks/MockHtsToken.sol";
import {MockUsdOracle} from "./mocks/MockUsdOracle.sol";

contract HtsRailAcceptanceHarness is HtsRailAcceptance {
    MockHtsToken private immutable token;

    constructor(IHtsRailReadiness rail_, MockHtsToken token_) HtsRailAcceptance(rail_) {
        token = token_;
    }

    function _metadata(address) internal view override returns (int64, int32, bool, bool, bool, bool) {
        return (
            token.metadataResponse(),
            token.decimals(),
            token.deleted(),
            token.paused(),
            token.hasKycKey(),
            token.hasFreezeKey()
        );
    }

    function _feeCounts(address) internal view override returns (int64, uint256, uint256, uint256) {
        return (token.feeResponse(), token.fixedFees(), token.fractionalFees(), token.royaltyFees());
    }

    function _frozen(address, address account) internal view override returns (int64, bool) {
        return (token.frozenResponse(), token.frozen(account));
    }

    function _kyc(address, address account) internal view override returns (int64, bool) {
        return (token.kycResponse(), token.kyc(account));
    }

    function _allowance(address, address account, address spender) internal view override returns (int64, uint256) {
        return (token.allowanceResponse(), token.allowance(account, spender));
    }

    function _balance(address, address account) internal view override returns (uint256) {
        return token.balanceOf(account);
    }
}

contract HtsRailAcceptanceTest is TestBase {
    bytes32 private constant PARTITION = bytes32(uint256(1));
    address private constant LENDER = address(0xA11CE);
    uint256 private constant REQUIRED = 1_000_000;

    MockHtsToken private token;
    AtsCollateralRailHtsHarness private rail;
    HtsRailAcceptanceHarness private acceptance;

    function setUp() public {
        MockAtsToken ats = new MockAtsToken();
        token = new MockHtsToken();
        MockUsdOracle oracle = new MockUsdOracle();
        rail = new AtsCollateralRailHtsHarness(
            ats,
            PARTITION,
            token,
            oracle,
            0,
            100 * 1e8,
            AtsCollateralRailHts.RailPolicy({
                maximumAdvanceBps: 6_000,
                maximumAnnualRateBps: 5_000,
                maximumQuoteMovementBps: 100,
                minimumTermSeconds: 120,
                maximumTermSeconds: 365 days,
                maximumOfferLifetimeSeconds: 1 hours
            }),
            address(this)
        );
        rail.initializeSettlement();
        acceptance = new HtsRailAcceptanceHarness(IHtsRailReadiness(address(rail)), token);
        token.setBalance(LENDER, REQUIRED);
        token.setAllowance(LENDER, address(rail), REQUIRED);
        token.setKyc(LENDER, true);
    }

    function testReadyAccountReportsEveryIndependentCheck() public {
        HtsRailAcceptance.Readiness memory result = acceptance.inspect(LENDER, REQUIRED);
        assertTrue(result.initialized);
        assertTrue(result.tokenPolicyReady);
        assertTrue(result.associationReady);
        assertTrue(result.kycReady);
        assertTrue(result.unfrozen);
        assertTrue(result.balanceReady);
        assertTrue(result.allowanceReady);
        assertTrue(acceptance.ready(result));
    }

    function testComplianceAndAssociationFailuresStayReadOnly() public {
        token.setFrozen(LENDER, true);
        token.setKyc(LENDER, false);
        token.setResponses(22, 184, 22, 22, 22, 22);
        HtsRailAcceptance.Readiness memory result = acceptance.inspect(LENDER, REQUIRED);
        assertFalse(result.associationReady);
        assertFalse(result.kycReady);
        assertFalse(result.unfrozen);
        assertFalse(result.allowanceReady);
        assertEq(token.balanceOf(LENDER), REQUIRED);
        assertEq(token.allowance(LENDER, address(rail)), REQUIRED);
    }

    function testAbsentComplianceKeysAreExplicitlyNotApplicable() public {
        MockHtsToken openToken = new MockHtsToken();
        openToken.setComplianceKeys(false, false);
        openToken.setResponses(22, 22, 172, 177, 22, 22);
        AtsCollateralRailHtsHarness openRail = new AtsCollateralRailHtsHarness(
            new MockAtsToken(),
            PARTITION,
            openToken,
            new MockUsdOracle(),
            0,
            100 * 1e8,
            AtsCollateralRailHts.RailPolicy({
                maximumAdvanceBps: 6_000,
                maximumAnnualRateBps: 5_000,
                maximumQuoteMovementBps: 100,
                minimumTermSeconds: 120,
                maximumTermSeconds: 365 days,
                maximumOfferLifetimeSeconds: 1 hours
            }),
            address(this)
        );
        openRail.initializeSettlement();
        openToken.setBalance(LENDER, REQUIRED);
        openToken.setAllowance(LENDER, address(openRail), REQUIRED);
        HtsRailAcceptanceHarness openAcceptance =
            new HtsRailAcceptanceHarness(IHtsRailReadiness(address(openRail)), openToken);

        HtsRailAcceptance.Readiness memory result = openAcceptance.inspect(LENDER, REQUIRED);
        assertTrue(result.kycReady);
        assertTrue(result.unfrozen);
        assertTrue(result.associationReady);
        assertTrue(result.tokenPolicyReady);
    }

    function testFeeDriftAndInsufficientAmountsFailReadiness() public {
        token.setFeeCounts(0, 1, 0);
        token.setBalance(LENDER, REQUIRED - 1);
        token.setAllowance(LENDER, address(rail), REQUIRED - 1);
        HtsRailAcceptance.Readiness memory result = acceptance.inspect(LENDER, REQUIRED);
        assertFalse(result.tokenPolicyReady);
        assertFalse(result.balanceReady);
        assertFalse(result.allowanceReady);
        assertFalse(acceptance.ready(result));
    }
}
