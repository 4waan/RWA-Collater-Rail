// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralRailHts} from "../../contracts/AtsCollateralRailHts.sol";
import {TestBase, StdInvariantBase, Vm} from "../TestBase.sol";
import {AtsCollateralRailHtsHarness} from "../mocks/AtsCollateralRailHtsHarness.sol";
import {MockAtsToken} from "../mocks/MockAtsToken.sol";
import {MockHtsToken} from "../mocks/MockHtsToken.sol";
import {MockUsdOracle} from "../mocks/MockUsdOracle.sol";

contract HtsRailActor {
    function fund(AtsCollateralRailHts rail, AtsCollateralRailHts.OfferTerms calldata terms)
        external
        returns (bytes32)
    {
        return rail.fundOffer(terms);
    }

    function accept(AtsCollateralRailHts rail, bytes32 offerId) external {
        rail.acceptOffer(offerId);
    }

    function cancel(AtsCollateralRailHts rail, bytes32 offerId) external {
        rail.cancelOffer(offerId);
    }

    function repay(AtsCollateralRailHts rail, bytes32 positionId) external {
        rail.repay(positionId);
    }

    function withdraw(AtsCollateralRailHts rail) external {
        rail.withdraw();
    }
}

contract HtsRailHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant COVER_FUND = 1 << 0;
    uint256 internal constant COVER_CANCEL = 1 << 1;
    uint256 internal constant COVER_ACCEPT = 1 << 2;
    uint256 internal constant COVER_REPAY = 1 << 3;
    uint256 internal constant COVER_WITHDRAW = 1 << 4;
    uint256 internal constant COVER_AUTOMATION_FUND = 1 << 5;
    uint256 internal constant COVER_HSS_DEFAULT = 1 << 6;
    uint256 internal constant COVER_FALLBACK = 1 << 7;
    uint256 internal constant COVER_TERMINAL_NOOP = 1 << 8;
    uint256 internal constant COVER_COMPLIANCE_REJECTION = 1 << 9;
    uint256 internal constant COVER_COMPLIANCE_RETRY = 1 << 10;
    uint256 internal constant COVER_FEE_REJECTION = 1 << 11;
    uint256 internal constant COVER_TRANSFER_ROLLBACK = 1 << 12;
    uint256 internal constant COVER_ATS_ADJUSTMENT = 1 << 13;
    uint256 internal constant COVER_AUTOMATION_WITHDRAW = 1 << 14;
    uint256 public constant REQUIRED_POST_SEED_COVERAGE = (1 << 15) - 1;

    AtsCollateralRailHtsHarness public immutable rail;
    MockAtsToken public immutable ats;
    MockHtsToken public immutable token;
    HtsRailActor public immutable lender;
    HtsRailActor public immutable borrower;

    uint256 public ghostFundedOfferPrincipal;
    uint256 public ghostTokenCredits;
    uint256 public ghostPendingSchedules;
    uint256 public acceptedPositions;
    uint256 public repaidPositions;
    uint256 public defaultedPositions;
    uint256 public openPositions;
    uint256 public successfulFunds;
    uint256 public successfulCancellations;
    uint256 public successfulWithdrawals;
    uint256 public successfulAutomationFunding;
    uint256 public successfulAutomationWithdrawals;
    uint256 public successfulHssDefaults;
    uint256 public successfulFallbackDefaults;
    uint256 public complianceRejections;
    uint256 public successfulComplianceRetries;
    uint256 public feeRejections;
    uint256 public transferRollbacks;
    uint256 public adjustedDefaults;
    uint256 public harmlessTerminalNoops;
    uint256 public postSeedCoverage;
    uint256 public postSeedTransitions;
    bool public postSeedCoverageEnabled;
    bool public ghostAccountingMismatch;

    constructor(
        AtsCollateralRailHtsHarness rail_,
        MockAtsToken ats_,
        MockHtsToken token_,
        HtsRailActor lender_,
        HtsRailActor borrower_
    ) {
        rail = rail_;
        ats = ats_;
        token = token_;
        lender = lender_;
        borrower = borrower_;
    }

    receive() external payable {}

    function enablePostSeedCoverage() external {
        postSeedCoverageEnabled = true;
    }

    function fundThenCancel(uint64 seed) external {
        (bytes32 offerId, uint256 principal) = _fund(seed);
        if (offerId == bytes32(0)) return;
        try lender.cancel(rail, offerId) {
            _decreaseOfferPrincipal(principal);
            ghostTokenCredits += principal;
            ++successfulCancellations;
            _cover(COVER_CANCEL);
        } catch {}
        _withdrawAndRecord(lender);
    }

    function fundAcceptRepayWithdraw(uint64 seed) external {
        rail.configureSchedule(1, 22, address(0x516B));
        (bytes32 positionId, uint256 principal) = _fund(seed);
        if (positionId == bytes32(0) || !_accept(positionId, principal)) return;

        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        token.setBalance(address(borrower), position.repaymentTokenUnits);
        token.setAllowance(address(borrower), address(rail), position.repaymentTokenUnits);
        try borrower.repay(rail, positionId) {
            ghostTokenCredits += position.repaymentTokenUnits;
            ++repaidPositions;
            --openPositions;
            _cover(COVER_REPAY);
        } catch {}

        _withdrawAndRecord(borrower);
        _withdrawAndRecord(lender);
        vm.warp(position.maturity + 2);
        _terminalNoop(positionId);
    }

    function hssDefault(uint64 seed) external {
        rail.configureSchedule(1, 22, address(0x516B));
        (bytes32 positionId, uint256 principal) = _fund(seed);
        if (positionId == bytes32(0) || !_accept(positionId, principal)) return;
        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        vm.warp(position.maturity + 2);
        if (_default(positionId)) {
            ++successfulHssDefaults;
            _cover(COVER_HSS_DEFAULT);
        }
        _withdrawAndRecord(borrower);
        _terminalNoop(positionId);
    }

    function publicFallback(uint64 seed) external {
        rail.configureSchedule(0, 22, address(0));
        (bytes32 positionId, uint256 principal) = _fund(seed);
        if (positionId == bytes32(0) || !_accept(positionId, principal)) return;
        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        vm.warp(position.maturity + 12);
        if (_default(positionId)) {
            ++successfulFallbackDefaults;
            _cover(COVER_FALLBACK);
        }
        _withdrawAndRecord(borrower);
        _terminalNoop(positionId);
    }

    function complianceRejectAndRetry(uint64 seed) external {
        _refreshAssetMaturity();
        AtsCollateralRailHts.OfferTerms memory terms = _terms(seed);
        _prepareLender(terms.principalTokenUnits);
        token.setFrozen(address(lender), true);
        try lender.fund(rail, terms) returns (bytes32) {
            ghostAccountingMismatch = true;
        } catch {
            ++complianceRejections;
            _cover(COVER_COMPLIANCE_REJECTION);
        }

        token.setFrozen(address(lender), false);
        try lender.fund(rail, terms) returns (bytes32 offerId) {
            ghostFundedOfferPrincipal += terms.principalTokenUnits;
            ++successfulFunds;
            ++successfulComplianceRetries;
            _cover(COVER_FUND);
            _cover(COVER_COMPLIANCE_RETRY);
            try lender.cancel(rail, offerId) {
                _decreaseOfferPrincipal(terms.principalTokenUnits);
                ghostTokenCredits += terms.principalTokenUnits;
                ++successfulCancellations;
                _cover(COVER_CANCEL);
            } catch {}
            _withdrawAndRecord(lender);
        } catch {}
    }

    function rejectFeeToken(uint64 seed) external {
        _refreshAssetMaturity();
        AtsCollateralRailHts.OfferTerms memory terms = _terms(seed);
        _prepareLender(terms.principalTokenUnits);
        token.setFeeCounts(1, 0, 0);
        try lender.fund(rail, terms) returns (bytes32) {
            ghostAccountingMismatch = true;
        } catch {
            ++feeRejections;
            _cover(COVER_FEE_REJECTION);
        }
        token.setFeeCounts(0, 0, 0);
    }

    function rejectTransferDelta(uint64 seed) external {
        _refreshAssetMaturity();
        AtsCollateralRailHts.OfferTerms memory terms = _terms(seed);
        _prepareLender(terms.principalTokenUnits);
        token.setDeltaAdjustments(-1, 0);
        try lender.fund(rail, terms) returns (bytes32) {
            ghostAccountingMismatch = true;
        } catch {
            ++transferRollbacks;
            _cover(COVER_TRANSFER_ROLLBACK);
        }
        token.setDeltaAdjustments(0, 0);
    }

    function adjustedDefault(uint64 seed) external {
        rail.configureSchedule(0, 22, address(0));
        (bytes32 positionId, uint256 principal) = _fund(seed);
        if (positionId == bytes32(0) || !_accept(positionId, principal)) return;
        AtsCollateralRailHts.Position memory position = rail.getPosition(positionId);
        ats.setAdjustedHoldAmount(rail.partition(), address(borrower), position.holdId, position.collateralAmount + 1);
        vm.warp(position.maturity + 12);
        if (_default(positionId)) {
            ++adjustedDefaults;
            _cover(COVER_ATS_ADJUSTMENT);
        }
        _withdrawAndRecord(borrower);
    }

    function sponsorAutomation(uint64 seed) external {
        uint256 amount = 1 + uint256(seed % uint64(2 * 1e8));
        if (address(this).balance < amount) return;
        try rail.fundAutomation{value: amount}() {
            ++successfulAutomationFunding;
            _cover(COVER_AUTOMATION_FUND);
        } catch {}
    }

    function withdrawUnusedAutomation(uint64 seed) external {
        if (rail.availableAutomation() == 0 && address(this).balance != 0) {
            try rail.fundAutomation{value: 1}() {
                ++successfulAutomationFunding;
                _cover(COVER_AUTOMATION_FUND);
            } catch {}
        }
        uint256 available = rail.availableAutomation();
        if (available == 0) return;
        uint256 amount = 1 + uint256(seed) % available;
        vm.prank(rail.owner());
        try rail.withdrawUnusedAutomation(payable(address(this)), amount) {
            ++successfulAutomationWithdrawals;
            _cover(COVER_AUTOMATION_WITHDRAW);
        } catch {}
    }

    function _fund(uint64 seed) internal returns (bytes32 offerId, uint256 principal) {
        _refreshAssetMaturity();
        AtsCollateralRailHts.OfferTerms memory terms = _terms(seed);
        principal = terms.principalTokenUnits;
        _prepareLender(principal);
        try lender.fund(rail, terms) returns (bytes32 createdOfferId) {
            ghostFundedOfferPrincipal += principal;
            ++successfulFunds;
            _cover(COVER_FUND);
            return (createdOfferId, principal);
        } catch {
            return (bytes32(0), principal);
        }
    }

    function _accept(bytes32 offerId, uint256 principal) internal returns (bool) {
        try borrower.accept(rail, offerId) {
            _decreaseOfferPrincipal(principal);
            ghostTokenCredits += principal;
            ++acceptedPositions;
            ++openPositions;
            if (rail.getPosition(offerId).automation == AtsCollateralRailHts.AutomationState.PENDING) {
                ++ghostPendingSchedules;
            }
            _cover(COVER_ACCEPT);
            return true;
        } catch {
            return false;
        }
    }

    function _default(bytes32 positionId) internal returns (bool) {
        bool wasPending = rail.getPosition(positionId).automation == AtsCollateralRailHts.AutomationState.PENDING;
        try rail.settle(positionId) returns (bool executed) {
            if (!executed) return false;
            if (wasPending) _decreasePendingSchedule();
            ++defaultedPositions;
            --openPositions;
            return true;
        } catch {
            return false;
        }
    }

    function _terminalNoop(bytes32 positionId) internal {
        bool wasPending = rail.getPosition(positionId).automation == AtsCollateralRailHts.AutomationState.PENDING;
        try rail.settle(positionId) returns (bool executed) {
            if (wasPending && rail.getPosition(positionId).automation == AtsCollateralRailHts.AutomationState.COMPLETED)
            {
                _decreasePendingSchedule();
            }
            if (!executed) {
                ++harmlessTerminalNoops;
                _cover(COVER_TERMINAL_NOOP);
            }
        } catch {}
    }

    function _withdrawAndRecord(HtsRailActor actor) internal {
        uint256 amount = rail.credits(address(actor));
        if (amount == 0) return;
        try actor.withdraw(rail) {
            _decreaseTokenCredits(amount);
            ++successfulWithdrawals;
            _cover(COVER_WITHDRAW);
        } catch {}
    }

    function _prepareLender(uint256 principal) internal {
        token.setBalance(address(lender), principal * 2);
        token.setAllowance(address(lender), address(rail), principal * 2);
    }

    function _terms(uint64 seed) internal view returns (AtsCollateralRailHts.OfferTerms memory) {
        return AtsCollateralRailHts.OfferTerms({
            borrower: address(borrower),
            collateralAmount: 100,
            principalTokenUnits: uint128((1 + uint256(seed % 50)) * 1e6),
            annualRateBps: uint16(seed % 2_001),
            termSeconds: uint64(120 + seed % uint64(30 days)),
            offerExpiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _refreshAssetMaturity() internal {
        ats.setMaturity(block.timestamp + 730 days);
    }

    function _decreaseOfferPrincipal(uint256 amount) internal {
        if (ghostFundedOfferPrincipal < amount) {
            ghostAccountingMismatch = true;
            ghostFundedOfferPrincipal = 0;
        } else {
            ghostFundedOfferPrincipal -= amount;
        }
    }

    function _decreaseTokenCredits(uint256 amount) internal {
        if (ghostTokenCredits < amount) {
            ghostAccountingMismatch = true;
            ghostTokenCredits = 0;
        } else {
            ghostTokenCredits -= amount;
        }
    }

    function _decreasePendingSchedule() internal {
        if (ghostPendingSchedules == 0) {
            ghostAccountingMismatch = true;
        } else {
            --ghostPendingSchedules;
        }
    }

    function _cover(uint256 bit) internal {
        if (!postSeedCoverageEnabled) return;
        postSeedCoverage |= bit;
        ++postSeedTransitions;
    }
}

contract HtsRailSolvencyInvariantTest is TestBase, StdInvariantBase {
    bytes32 internal constant PARTITION = keccak256("HTS_INVARIANT");

    MockAtsToken internal ats;
    MockHtsToken internal token;
    AtsCollateralRailHtsHarness internal rail;
    HtsRailHandler internal handler;

    function setUp() public {
        ats = new MockAtsToken();
        token = new MockHtsToken();
        MockUsdOracle oracle = new MockUsdOracle();
        rail = new AtsCollateralRailHtsHarness(ats, PARTITION, token, oracle, 2, 100 * 1e8, _policy(), address(this));
        rail.initializeSettlement();

        HtsRailActor lender = new HtsRailActor();
        HtsRailActor borrower = new HtsRailActor();
        handler = new HtsRailHandler(rail, ats, token, lender, borrower);
        ats.setMaturity(block.timestamp + 730 days);
        ats.setKyc(address(lender), true);
        ats.setKyc(address(borrower), true);
        ats.setBalance(PARTITION, address(borrower), 1e30);
        ats.setAllowance(address(borrower), address(rail), type(uint256).max);
        token.setKyc(address(lender), true);
        token.setKyc(address(borrower), true);
        vm.deal(address(handler), 1e30);

        for (uint256 i = 0; i < 30; ++i) {
            handler.sponsorAutomation(type(uint64).max);
        }
        handler.fundThenCancel(1);
        handler.fundAcceptRepayWithdraw(2);
        handler.hssDefault(3);
        handler.publicFallback(4);
        handler.enablePostSeedCoverage();

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = HtsRailHandler.fundThenCancel.selector;
        selectors[1] = HtsRailHandler.fundAcceptRepayWithdraw.selector;
        selectors[2] = HtsRailHandler.hssDefault.selector;
        selectors[3] = HtsRailHandler.publicFallback.selector;
        selectors[4] = HtsRailHandler.complianceRejectAndRetry.selector;
        selectors[5] = HtsRailHandler.rejectFeeToken.selector;
        selectors[6] = HtsRailHandler.rejectTransferDelta.selector;
        selectors[7] = HtsRailHandler.adjustedDefault.selector;
        selectors[8] = HtsRailHandler.sponsorAutomation.selector;
        selectors[9] = HtsRailHandler.withdrawUnusedAutomation.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantTokenBalanceCoversTokenLiabilities() public view {
        assertTrue(token.balanceOf(address(rail)) >= rail.cashTokenLiabilities());
    }

    function invariantHbarBalanceCoversAutomationReserve() public view {
        assertTrue(address(rail).balance >= rail.reservedAutomation());
    }

    function invariantCashLiabilitiesMatchOfferPrincipalAndCredits() public view {
        assertFalse(handler.ghostAccountingMismatch());
        assertEq(rail.cashTokenLiabilities(), handler.ghostFundedOfferPrincipal() + handler.ghostTokenCredits());
    }

    function invariantAutomationReserveMatchesPendingSchedules() public view {
        assertFalse(handler.ghostAccountingMismatch());
        assertEq(rail.reservedAutomation(), handler.ghostPendingSchedules() * rail.HSS_RESERVE_TINYBAR());
    }

    function invariantEveryAcceptanceCreatedOneRailHold() public view {
        assertEq(ats.holdsCreated(), handler.acceptedPositions());
    }

    function invariantTerminalActionsMatchRepaidAndDefaultedPositions() public view {
        assertEq(ats.terminalActions(), handler.repaidPositions() + handler.defaultedPositions());
    }

    function invariantOpenPositionsMatchTerminalAccounting() public view {
        assertEq(
            handler.openPositions(),
            handler.acceptedPositions() - handler.repaidPositions() - handler.defaultedPositions()
        );
    }

    function testPostSeedCoverageReachesEveryRequiredHtsPath() public {
        assertEq(handler.postSeedCoverage(), 0);
        handler.sponsorAutomation(1);
        handler.fundThenCancel(1);
        handler.fundAcceptRepayWithdraw(2);
        handler.hssDefault(3);
        handler.publicFallback(4);
        handler.complianceRejectAndRetry(5);
        handler.rejectFeeToken(6);
        handler.rejectTransferDelta(7);
        handler.adjustedDefault(8);
        handler.withdrawUnusedAutomation(9);
        assertEq(handler.postSeedCoverage(), handler.REQUIRED_POST_SEED_COVERAGE());
    }

    function afterInvariant() public view {
        assertTrue(handler.postSeedTransitions() > 0);
        assertTrue(handler.postSeedCoverage() > 0);
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
