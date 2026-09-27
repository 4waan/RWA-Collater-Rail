// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralRailHts} from "../contracts/AtsCollateralRailHts.sol";
import {IHederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/IHederaTokenService.sol";
import {TestBase} from "./TestBase.sol";
import {AtsCollateralRailHtsHarness} from "./mocks/AtsCollateralRailHtsHarness.sol";
import {MockAtsToken} from "./mocks/MockAtsToken.sol";
import {MockHtsToken} from "./mocks/MockHtsToken.sol";
import {MockUsdOracle} from "./mocks/MockUsdOracle.sol";

contract EmptyHtsFacade {
    fallback() external {}
}

contract EmptyFacadeRailHarness is AtsCollateralRailHts {
    constructor(MockAtsToken ats_, bytes32 partition_, address token_, MockUsdOracle oracle_, RailPolicy memory policy_)
        AtsCollateralRailHts(ats_, partition_, token_, oracle_, 2, 100 * 1e8, policy_, address(this))
    {}

    function _htsFungibleMetadata() internal pure override returns (SettlementMetadata memory) {
        return SettlementMetadata({decimals: 6, deleted: false, defaultKycStatus: true, paused: false});
    }

    function _htsFeeCounts() internal pure override returns (uint256, uint256, uint256) {
        return (0, 0, 0);
    }

    function _htsAssociateRail() internal pure override returns (int64) {
        return HEDERA_SUCCESS;
    }
}

contract AtsCollateralRailHtsTest is TestBase {
    bytes32 private constant PARTITION = keccak256("COLLATERAL_RAIL_HTS");
    address private constant LENDER = address(0xA11CE);
    address private constant BORROWER = address(0xB0B);
    uint256 private constant COLLATERAL = 100;
    uint256 private constant PRINCIPAL = 10_000_000;
    uint64 private constant TERM = 1 days;

    MockAtsToken private ats;
    MockHtsToken private token;
    MockUsdOracle private oracle;
    AtsCollateralRailHtsHarness private rail;

    function setUp() public {
        vm.warp(1_000_000);
        ats = new MockAtsToken();
        token = new MockHtsToken();
        oracle = new MockUsdOracle();
        rail = _deploy(ats, token, oracle);

        ats.setMaturity(block.timestamp + 365 days);
        ats.setKyc(LENDER, true);
        ats.setKyc(BORROWER, true);
        ats.setBalance(PARTITION, BORROWER, COLLATERAL * 10);
        ats.setAllowance(BORROWER, address(rail), COLLATERAL * 10);
        token.setKyc(LENDER, true);
        token.setKyc(BORROWER, true);
        rail.initializeSettlement();
    }

    function testInitializeStoresTokenPropertiesAndCannotRepeat() public {
        assertTrue(rail.settlementInitialized());
        assertEq(rail.settlementDecimals(), 6);
        assertFalse(rail.settlementKycNotApplicable());

        vm.expectRevert(AtsCollateralRailHts.SettlementAlreadyInitialized.selector);
        rail.initializeSettlement();
    }

    function testInitializeAcceptsAlreadyAssociatedResponse() public {
        MockHtsToken otherToken = new MockHtsToken();
        otherToken.setResponses(194, 22, 22, 22, 22, 22);
        AtsCollateralRailHtsHarness otherRail = _deploy(ats, otherToken, oracle);
        otherRail.initializeSettlement();
        assertTrue(otherRail.settlementInitialized());
    }

    function testInitializeRejectsFailedTokenInfoFeeInfoAndAssociation() public {
        MockHtsToken otherToken = new MockHtsToken();
        AtsCollateralRailHtsHarness otherRail = _deploy(ats, otherToken, oracle);
        otherToken.setQueryResponses(167, 22);
        vm.expectRevert(
            abi.encodeWithSelector(
                AtsCollateralRailHts.HtsCallFailed.selector,
                IHederaTokenService.getFungibleTokenInfo.selector,
                int64(167)
            )
        );
        otherRail.initializeSettlement();

        otherToken.setQueryResponses(22, 167);
        vm.expectRevert(
            abi.encodeWithSelector(
                AtsCollateralRailHts.HtsCallFailed.selector, IHederaTokenService.getTokenCustomFees.selector, int64(167)
            )
        );
        otherRail.initializeSettlement();

        otherToken.setQueryResponses(22, 22);
        otherToken.setResponses(7, 22, 22, 22, 22, 22);
        vm.expectRevert(
            abi.encodeWithSelector(
                AtsCollateralRailHts.HtsCallFailed.selector, IHederaTokenService.associateToken.selector, int64(7)
            )
        );
        otherRail.initializeSettlement();
        assertFalse(otherRail.settlementInitialized());
    }

    function testEmptyHtsPrecompileResponseNeverCountsAsSuccessfulInterfaceBehavior() public {
        AtsCollateralRailHts productionRail =
            new AtsCollateralRailHts(ats, PARTITION, address(token), oracle, 2, 100 * 1e8, _policy(), address(this));
        vm.mockCall(
            address(0x167),
            abi.encodeWithSelector(IHederaTokenService.getFungibleTokenInfo.selector, address(token)),
            bytes("")
        );
        vm.expectRevert();
        productionRail.initializeSettlement();
        assertFalse(productionRail.settlementInitialized());
    }

    function testFacadeBytecodeWithEmptyBalanceResponseIsRejected() public {
        EmptyHtsFacade emptyFacade = new EmptyHtsFacade();
        EmptyFacadeRailHarness emptyRail =
            new EmptyFacadeRailHarness(ats, PARTITION, address(emptyFacade), oracle, _policy());
        vm.expectRevert(
            abi.encodeWithSelector(
                AtsCollateralRailHts.MalformedTokenBalance.selector, address(emptyFacade), uint256(0)
            )
        );
        emptyRail.initializeSettlement();
        assertFalse(emptyRail.settlementInitialized());
    }

    function testInitializeRejectsDeletedPausedInvalidDecimalsAndFees() public {
        MockHtsToken otherToken = new MockHtsToken();
        AtsCollateralRailHtsHarness otherRail = _deploy(ats, otherToken, oracle);
        otherToken.setMetadata(6, true, false, false);
        vm.expectRevert(AtsCollateralRailHts.SettlementTokenDeleted.selector);
        otherRail.initializeSettlement();

        otherToken.setMetadata(19, false, false, false);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.InvalidSettlementDecimals.selector, int32(19)));
        otherRail.initializeSettlement();

        otherToken.setMetadata(6, false, false, true);
        vm.expectRevert(AtsCollateralRailHts.SettlementTokenPaused.selector);
        otherRail.initializeSettlement();

        otherToken.setMetadata(6, false, false, false);
        otherToken.setFeeCounts(1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementCustomFees.selector, 1, 0, 0));
        otherRail.initializeSettlement();

        otherToken.setFeeCounts(0, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementCustomFees.selector, 0, 1, 0));
        otherRail.initializeSettlement();

        otherToken.setFeeCounts(0, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementCustomFees.selector, 0, 0, 1));
        otherRail.initializeSettlement();
    }

    function testRepaymentLifecycleMaintainsExactTokenLiabilities() public {
        bytes32 positionId = _fundAndAccept();
        uint256 repayment = rail.getPosition(positionId).repaymentTokenUnits;

        assertEq(token.balanceOf(address(rail)), PRINCIPAL);
        assertEq(rail.cashTokenLiabilities(), PRINCIPAL);
        assertEq(rail.credits(BORROWER), PRINCIPAL);

        vm.prank(BORROWER);
        rail.withdraw();
        assertEq(token.balanceOf(BORROWER), PRINCIPAL);
        assertEq(rail.cashTokenLiabilities(), 0);

        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);
        vm.prank(BORROWER);
        rail.repay(positionId);

        assertEq(rail.cashTokenLiabilities(), repayment);
        assertEq(rail.credits(LENDER), repayment);
        assertEq(uint256(rail.getPosition(positionId).state), uint256(AtsCollateralRailHts.PositionState.REPAID));

        vm.prank(LENDER);
        rail.withdraw();
        assertEq(token.balanceOf(LENDER), PRINCIPAL + repayment);
        assertEq(rail.cashTokenLiabilities(), 0);
        assertEq(token.balanceOf(address(rail)), 0);
    }

    function testMaturedDefaultLeavesBorrowerCreditSolvent() public {
        bytes32 positionId = _fundAndAccept();
        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        vm.warp(position.maturity);
        assertTrue(rail.settle(positionId));

        assertEq(uint256(rail.getPosition(positionId).state), uint256(AtsCollateralRailHts.PositionState.DEFAULTED));
        assertEq(rail.cashTokenLiabilities(), PRINCIPAL);
        assertEq(token.balanceOf(address(rail)), PRINCIPAL);
        assertEq(ats.balanceOfByPartition(PARTITION, LENDER), COLLATERAL);
    }

    function testSiblingHoldRemainsIsolatedWhenFirstPositionRepays() public {
        bytes32 firstOffer = _fund();
        bytes32 secondOffer = _fund();
        vm.prank(BORROWER);
        bytes32 firstPosition = rail.acceptOffer(firstOffer);
        vm.prank(BORROWER);
        bytes32 secondPosition = rail.acceptOffer(secondOffer);

        uint256 repayment = rail.getPosition(firstPosition).repaymentTokenUnits;
        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);
        vm.prank(BORROWER);
        rail.repay(firstPosition);

        AtsCollateralRailHts.Position memory sibling = rail.getPosition(secondPosition);
        assertEq(ats.holdAmount(PARTITION, BORROWER, sibling.holdId), COLLATERAL);
        assertEq(ats.getHeldAmountForByPartition(PARTITION, BORROWER), COLLATERAL);
        assertEq(uint256(sibling.state), uint256(AtsCollateralRailHts.PositionState.OPEN));
    }

    function testDownwardAtsAdjustmentUsesCurrentHoldAmount() public {
        bytes32 positionId = _fundAndAccept();
        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        ats.setAdjustedHoldAmount(PARTITION, BORROWER, position.holdId, COLLATERAL / 2);
        uint256 repayment = position.repaymentTokenUnits;
        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);

        vm.prank(BORROWER);
        rail.repay(positionId);
        assertEq(ats.getHeldAmountForByPartition(PARTITION, BORROWER), 0);
        assertEq(ats.balanceOfByPartition(PARTITION, BORROWER), COLLATERAL * 10 - COLLATERAL / 2);
    }

    function testDirectHbarFundingIsRejected() public {
        vm.deal(address(this), 1);
        vm.expectRevert(AtsCollateralRailHts.DirectFundingDisabled.selector);
        payable(address(rail)).transfer(1);
    }

    function testHssReserveIsIndependentFromTokenLiability() public {
        vm.deal(address(this), rail.HSS_RESERVE_TINYBAR());
        rail.fundAutomation{value: rail.HSS_RESERVE_TINYBAR()}();
        rail.configureSchedule(1, 22, address(0x516B));
        bytes32 positionId = _fundAndAccept();

        assertEq(rail.reservedAutomation(), rail.HSS_RESERVE_TINYBAR());
        assertEq(rail.cashTokenLiabilities(), PRINCIPAL);
        assertEq(address(rail).balance, rail.HSS_RESERVE_TINYBAR());

        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        vm.warp(position.maturity);
        rail.settle(positionId);
        assertEq(rail.reservedAutomation(), 0);
        assertEq(rail.cashTokenLiabilities(), PRINCIPAL);
    }

    function testRepayBeforeMaturityWinsRaceAndScheduledSettleBecomesNoOp() public {
        vm.deal(address(this), rail.HSS_RESERVE_TINYBAR());
        rail.fundAutomation{value: rail.HSS_RESERVE_TINYBAR()}();
        rail.configureSchedule(1, 22, address(0x516B));
        bytes32 positionId = _fundAndAccept();
        uint256 repayment = rail.getPosition(positionId).repaymentTokenUnits;
        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);

        vm.prank(BORROWER);
        rail.repay(positionId);
        vm.warp(rail.getPosition(positionId).maturity);
        assertFalse(rail.settle(positionId));
        assertEq(rail.reservedAutomation(), 0);
        assertEq(
            uint256(rail.getPosition(positionId).automation), uint256(AtsCollateralRailHts.AutomationState.COMPLETED)
        );
    }

    function testDefaultWinsRaceAndRepaymentCannotFollow() public {
        bytes32 positionId = _fundAndAccept();
        uint256 repayment = rail.getPosition(positionId).repaymentTokenUnits;
        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);
        vm.warp(rail.getPosition(positionId).maturity);
        rail.settle(positionId);

        vm.prank(BORROWER);
        vm.expectRevert(AtsCollateralRailHts.PositionNotOpen.selector);
        rail.repay(positionId);
    }

    function testFeeAddedAfterInitializationFailsClosed() public {
        token.setFeeCounts(0, 1, 0);
        _prepareFunding();
        vm.prank(LENDER);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementCustomFees.selector, 0, 1, 0));
        rail.fundOffer(_terms());
        assertEq(token.balanceOf(LENDER), PRINCIPAL * 2);
        assertEq(rail.cashTokenLiabilities(), 0);
    }

    function testFrozenKycPausedAndAllowanceFailuresDoNotFund() public {
        _prepareFunding();
        token.setFrozen(LENDER, true);
        vm.prank(LENDER);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementAccountFrozen.selector, LENDER));
        rail.fundOffer(_terms());

        token.setFrozen(LENDER, false);
        token.setKyc(LENDER, false);
        vm.prank(LENDER);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.SettlementKycRequired.selector, LENDER));
        rail.fundOffer(_terms());

        token.setKyc(LENDER, true);
        token.setMetadata(6, false, false, true);
        vm.prank(LENDER);
        vm.expectRevert(AtsCollateralRailHts.SettlementTokenPaused.selector);
        rail.fundOffer(_terms());

        token.setMetadata(6, false, false, false);
        token.setAllowance(LENDER, address(rail), PRINCIPAL - 1);
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(AtsCollateralRailHts.InsufficientAllowance.selector, PRINCIPAL - 1, PRINCIPAL)
        );
        rail.fundOffer(_terms());
        assertEq(rail.cashTokenLiabilities(), 0);
    }

    function testWrongHtsResponseAndInboundDeltaMismatchRollbackFunding() public {
        _prepareFunding();
        token.setResponses(22, 22, 22, 22, 7, 22);
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(AtsCollateralRailHts.HtsCallFailed.selector, bytes4(0x15dacbea), int64(7))
        );
        rail.fundOffer(_terms());
        assertEq(token.balanceOf(LENDER), PRINCIPAL * 2);

        token.setResponses(22, 22, 22, 22, 22, 22);
        token.setDeltaAdjustments(-1, 0);
        vm.prank(LENDER);
        vm.expectRevert(
            abi.encodeWithSelector(AtsCollateralRailHts.TransferDeltaMismatch.selector, 0, PRINCIPAL - 1, PRINCIPAL)
        );
        rail.fundOffer(_terms());
        assertEq(token.balanceOf(LENDER), PRINCIPAL * 2);
        assertEq(token.balanceOf(address(rail)), 0);
        assertEq(rail.cashTokenLiabilities(), 0);
    }

    function testOutboundDeltaMismatchRestoresCreditAndLiability() public {
        _fundAndAccept();
        token.setDeltaAdjustments(0, -1);
        vm.prank(BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(AtsCollateralRailHts.TransferDeltaMismatch.selector, PRINCIPAL, 1, PRINCIPAL)
        );
        rail.withdraw();

        assertEq(rail.credits(BORROWER), PRINCIPAL);
        assertEq(rail.cashTokenLiabilities(), PRINCIPAL);
        assertEq(token.balanceOf(address(rail)), PRINCIPAL);
        assertEq(token.balanceOf(BORROWER), 0);
    }

    function testAtsFailureAfterTokenRepaymentRollsBackEverything() public {
        bytes32 positionId = _fundAndAccept();
        uint256 repayment = rail.getPosition(positionId).repaymentTokenUnits;
        token.setBalance(BORROWER, repayment);
        token.setAllowance(BORROWER, address(rail), repayment);
        ats.setTerminalResidualAmount(1);

        uint256 railBalanceBefore = token.balanceOf(address(rail));
        uint256 borrowerBalanceBefore = token.balanceOf(BORROWER);
        uint256 allowanceBefore = token.allowance(BORROWER, address(rail));
        uint256 liabilitiesBefore = rail.cashTokenLiabilities();
        vm.prank(BORROWER);
        vm.expectRevert(AtsCollateralRailHts.InvalidHold.selector);
        rail.repay(positionId);

        assertEq(token.balanceOf(address(rail)), railBalanceBefore);
        assertEq(token.balanceOf(BORROWER), borrowerBalanceBefore);
        assertEq(token.allowance(BORROWER, address(rail)), allowanceBefore);
        assertEq(rail.cashTokenLiabilities(), liabilitiesBefore);
        assertEq(uint256(rail.getPosition(positionId).state), uint256(AtsCollateralRailHts.PositionState.OPEN));
        assertEq(ats.holdAmount(PARTITION, BORROWER, 1), COLLATERAL);
    }

    function testQuoteMovementBoundary() public {
        bytes32 offerId = _fund();
        oracle.setQuote(101_000_000, 0, uint64(block.timestamp));
        vm.prank(BORROWER);
        rail.acceptOffer(offerId);

        setUp();
        offerId = _fund();
        oracle.setQuote(101_000_001, 0, uint64(block.timestamp));
        vm.prank(BORROWER);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.QuoteMoved.selector, 100_000_000, 101_000_001));
        rail.acceptOffer(offerId);
        assertTrue(rail.getOffer(offerId).exists);
    }

    function testTransferAmountAboveInt64RangeRejected() public {
        AtsCollateralRailHts.OfferTerms memory terms = _terms();
        terms.principalTokenUnits = uint128(rail.MAX_TRANSFER_AMOUNT() + 1);
        token.setBalance(LENDER, terms.principalTokenUnits);
        token.setAllowance(LENDER, address(rail), terms.principalTokenUnits);
        uint256 rejectedAmount = rail.MAX_TRANSFER_AMOUNT() + 1;
        vm.prank(LENDER);
        vm.expectRevert(abi.encodeWithSelector(AtsCollateralRailHts.TransferAmountOutOfRange.selector, rejectedAmount));
        rail.fundOffer(terms);
    }

    function _fundAndAccept() internal returns (bytes32 positionId) {
        bytes32 offerId = _fund();
        vm.prank(BORROWER);
        positionId = rail.acceptOffer(offerId);
    }

    function _fund() internal returns (bytes32 offerId) {
        _prepareFunding();
        vm.prank(LENDER);
        offerId = rail.fundOffer(_terms());
    }

    function _prepareFunding() internal {
        token.setBalance(LENDER, PRINCIPAL * 2);
        token.setAllowance(LENDER, address(rail), PRINCIPAL * 2);
    }

    function _terms() internal view returns (AtsCollateralRailHts.OfferTerms memory) {
        return AtsCollateralRailHts.OfferTerms({
            borrower: BORROWER,
            collateralAmount: uint128(COLLATERAL),
            principalTokenUnits: uint128(PRINCIPAL),
            annualRateBps: 1_000,
            termSeconds: TERM,
            offerExpiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _deploy(MockAtsToken ats_, MockHtsToken token_, MockUsdOracle oracle_)
        internal
        returns (AtsCollateralRailHtsHarness)
    {
        return new AtsCollateralRailHtsHarness(ats_, PARTITION, token_, oracle_, 2, 100 * 1e8, _policy(), address(this));
    }

    function _policy() internal pure returns (AtsCollateralRailHts.RailPolicy memory) {
        return AtsCollateralRailHts.RailPolicy({
            maximumAdvanceBps: 6_000,
            maximumAnnualRateBps: 2_000,
            maximumQuoteMovementBps: 100,
            minimumTermSeconds: 2 minutes,
            maximumTermSeconds: 30 days,
            maximumOfferLifetimeSeconds: 2 hours
        });
    }
}
