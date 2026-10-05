// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralMobility} from "../../../contracts/experimental/clpr/AtsCollateralMobility.sol";
import {ClprApplicationBase} from "../../../contracts/experimental/clpr/ClprApplicationBase.sol";
import {ClprMobilityTypes} from "../../../contracts/experimental/clpr/ClprMobilityTypes.sol";
import {IERC20MobilitySettlement, RemoteCashEscrow} from "../../../contracts/experimental/clpr/RemoteCashEscrow.sol";
import {AtsCollateralMobilityHarness} from "../../mocks/AtsCollateralMobilityHarness.sol";
import {MockAtsToken} from "../../mocks/MockAtsToken.sol";
import {MockClprService} from "../../mocks/MockClprService.sol";
import {MockSettlementToken} from "../../mocks/MockSettlementToken.sol";
import {TestBase} from "../../TestBase.sol";

contract ClprCollateralMobilityTest is TestBase {
    bytes32 internal constant PARTITION = keccak256("CLPR-ATS");
    bytes32 internal constant CHANNEL = keccak256("CLPR-CHANNEL");
    bytes32 internal constant CONNECTOR = keccak256("CLPR-CONNECTOR");
    bytes32 internal constant HEDERA_DOMAIN = keccak256("hedera:testnet");
    bytes32 internal constant REMOTE_DOMAIN = keccak256("eip155:1337");
    uint256 internal constant COLLATERAL = 1_000e6;
    uint256 internal constant PRINCIPAL = 50_000e6;
    uint256 internal constant REPAYMENT = 50_500e6;

    address internal constant LENDER = address(0xBEEF);
    address internal constant BORROWER = address(0xCAFE);

    MockClprService internal service;
    MockSettlementToken internal cashToken;
    MockAtsToken internal atsToken;
    RemoteCashEscrow internal remote;
    AtsCollateralMobility internal hedera;

    function setUp() public {
        vm.warp(1_900_000_000);
        service = new MockClprService();
        cashToken = new MockSettlementToken();
        atsToken = new MockAtsToken();
        remote = new RemoteCashEscrow(
            IERC20MobilitySettlement(address(cashToken)),
            service,
            CHANNEL,
            CONNECTOR,
            address(this),
            address(0),
            REMOTE_DOMAIN,
            HEDERA_DOMAIN
        );
        hedera = new AtsCollateralMobility(
            atsToken,
            PARTITION,
            6,
            100e8,
            _policy(),
            address(this),
            service,
            CHANNEL,
            CONNECTOR,
            address(remote),
            HEDERA_DOMAIN,
            REMOTE_DOMAIN
        );
        remote.initializePeerApplication(address(hedera));

        atsToken.setKyc(LENDER, true);
        atsToken.setKyc(BORROWER, true);
        atsToken.setMaturity(block.timestamp + 400 days);
        atsToken.setBalance(PARTITION, BORROWER, COLLATERAL * 3);
        atsToken.setAllowance(BORROWER, address(hedera), COLLATERAL * 3);

        cashToken.mint(LENDER, PRINCIPAL * 3);
        cashToken.mint(BORROWER, REPAYMENT * 3);
        vm.prank(LENDER);
        cashToken.approve(address(remote), type(uint256).max);
        vm.prank(BORROWER);
        cashToken.approve(address(remote), type(uint256).max);
    }

    function test_repaymentLifecycleAcrossOrderedMessages() public {
        (bytes32 mobilityId,) = _openPosition();

        vm.prank(BORROWER);
        bytes32 repaymentOutbox = remote.escrowRepayment(mobilityId);
        remote.dispatchMessage(repaymentOutbox);
        service.deliver(3);

        bytes32 acceptedOutbox = hedera.latestOutbox(mobilityId, ClprMobilityTypes.MessageKind.REPAYMENT_ACCEPTED);
        hedera.dispatchMessage(acceptedOutbox);
        service.deliver(4);

        AtsCollateralMobility.Position memory position = hedera.getPosition(mobilityId);
        RemoteCashEscrow.RemoteOffer memory offer = remote.getOffer(mobilityId);
        assertEq(uint256(position.state), uint256(AtsCollateralMobility.PositionState.REPAID));
        assertEq(uint256(offer.state), uint256(RemoteCashEscrow.OfferState.REPAID));
        assertEq(remote.credits(LENDER), REPAYMENT);
        assertEq(remote.cashTokenLiabilities(), REPAYMENT);
        assertEq(atsToken.terminalActions(), 1);

        uint256 beforeBalance = cashToken.balanceOf(LENDER);
        vm.prank(LENDER);
        remote.withdrawCredit();
        assertEq(cashToken.balanceOf(LENDER), beforeBalance + REPAYMENT);
        assertEq(remote.cashTokenLiabilities(), 0);
    }

    function test_defaultWinsAndPendingRepaymentBecomesBorrowerRefund() public {
        (bytes32 mobilityId,) = _openPosition();

        vm.prank(BORROWER);
        bytes32 repaymentOutbox = remote.escrowRepayment(mobilityId);
        remote.dispatchMessage(repaymentOutbox);

        AtsCollateralMobility.Position memory beforeDefault = hedera.getPosition(mobilityId);
        vm.warp(beforeDefault.maturity + 1);
        (bool executed, bytes32 defaultOutbox) = hedera.settle(mobilityId);
        assertTrue(executed);
        hedera.dispatchMessage(defaultOutbox);
        service.deliver(4);

        RemoteCashEscrow.RemoteOffer memory offer = remote.getOffer(mobilityId);
        assertEq(uint256(offer.state), uint256(RemoteCashEscrow.OfferState.DEFAULTED));
        assertEq(remote.credits(BORROWER), REPAYMENT);
        assertEq(remote.pendingRepaymentLiability(), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                AtsCollateralMobility.InvalidPositionState.selector, AtsCollateralMobility.PositionState.DEFAULTED
            )
        );
        service.deliver(3);
        AtsCollateralMobility.Position memory afterLateRepayment = hedera.getPosition(mobilityId);
        assertEq(uint256(afterLateRepayment.state), uint256(AtsCollateralMobility.PositionState.DEFAULTED));
    }

    function test_lockedOfferCancellationRequiresExpiryAndVerifiedDelivery() public {
        (bytes32 mobilityId,) = _fundAndLock();
        vm.prank(LENDER);
        vm.expectRevert(RemoteCashEscrow.OfferStillActive.selector);
        remote.cancelOffer(mobilityId);

        ClprMobilityTypes.Terms memory terms = _terms();
        vm.warp(terms.offerExpiresAt + 1);
        vm.prank(LENDER);
        bytes32 cancelOutbox = remote.cancelOffer(mobilityId);

        AtsCollateralMobility.Position memory locked = hedera.getPosition(mobilityId);
        assertEq(uint256(locked.state), uint256(AtsCollateralMobility.PositionState.COLLATERAL_LOCKED));
        remote.dispatchMessage(cancelOutbox);
        service.deliver(2);

        AtsCollateralMobility.Position memory cancelled = hedera.getPosition(mobilityId);
        assertEq(uint256(cancelled.state), uint256(AtsCollateralMobility.PositionState.CANCELLED));
        assertEq(atsToken.terminalActions(), 1);
        assertEq(remote.credits(LENDER), PRINCIPAL);
    }

    function test_duplicateDeliveryIsIdempotentAndConflictFailsClosed() public {
        (bytes32 mobilityId, bytes32 fundingOutbox) = _fundOnly();
        remote.dispatchMessage(fundingOutbox);
        service.deliver(0);
        service.deliver(0);

        MockClprService.QueuedMessage memory queued = service.messageAt(0);
        ClprMobilityTypes.Message memory message = abi.decode(queued.data, (ClprMobilityTypes.Message));
        message.body = abi.encode(bytes32("conflict"));
        vm.expectRevert(
            abi.encodeWithSelector(ClprApplicationBase.ReplayConflict.selector, ClprMobilityTypes.semanticKey(message))
        );
        service.deliverRaw(address(hedera), CHANNEL, address(remote), abi.encode(message));

        vm.prank(BORROWER);
        hedera.acceptOffer(mobilityId);
        assertEq(atsToken.holdsCreated(), 1);
    }

    function test_wrongServiceChannelAndPeerFailClosed() public {
        (, bytes32 fundingOutbox) = _fundOnly();
        remote.dispatchMessage(fundingOutbox);
        MockClprService.QueuedMessage memory queued = service.messageAt(0);

        vm.expectRevert(ClprApplicationBase.ClprServiceOnly.selector);
        hedera.onClprMessage(CHANNEL, abi.encodePacked(address(remote)), queued.data);

        vm.expectRevert(ClprApplicationBase.WrongChannel.selector);
        service.deliverRaw(address(hedera), bytes32("wrong"), address(remote), queued.data);

        vm.expectRevert(ClprApplicationBase.WrongPeerApplication.selector);
        service.deliverRaw(address(hedera), CHANNEL, address(0xBAD), queued.data);
    }

    function test_failedDispatchLeavesOutboxRetryable() public {
        (, bytes32 fundingOutbox) = _fundOnly();
        service.setFailSend(true);
        vm.expectRevert(MockClprService.MockSendFailed.selector);
        remote.dispatchMessage(fundingOutbox);

        ClprApplicationBase.OutboxItem memory item = remote.getOutboxItem(fundingOutbox);
        assertFalse(item.dispatched);
        service.setFailSend(false);
        remote.dispatchMessage(fundingOutbox);
        item = remote.getOutboxItem(fundingOutbox);
        assertTrue(item.dispatched);
    }

    function test_newAttemptRetriesTheSameLogicalMessageIdempotently() public {
        (bytes32 mobilityId, bytes32 fundingOutbox) = _fundOnly();
        remote.dispatchMessage(fundingOutbox);
        service.deliver(0);

        bytes32 retryOutbox = remote.retryMessage(fundingOutbox);
        remote.dispatchMessage(retryOutbox);
        service.deliver(1);

        vm.prank(BORROWER);
        hedera.acceptOffer(mobilityId);
        assertEq(atsToken.holdsCreated(), 1);
    }

    function test_falseEmptyAndShortTokenResponsesRollbackFunding() public {
        ClprMobilityTypes.Terms memory terms = _terms();
        MockSettlementToken.Mode[3] memory modes = [
            MockSettlementToken.Mode.FALSE_VALUE,
            MockSettlementToken.Mode.EMPTY_RETURN,
            MockSettlementToken.Mode.SHORT_DELTA
        ];
        for (uint256 i = 0; i < modes.length; ++i) {
            cashToken.setMode(modes[i]);
            vm.prank(LENDER);
            vm.expectRevert();
            remote.fundOffer(terms);
            assertEq(remote.cashTokenLiabilities(), 0);
            assertEq(cashToken.balanceOf(address(remote)), 0);
        }
    }

    function test_hssReserveIsIndependentAndReleasedByPublicDefault() public {
        RemoteCashEscrow remoteForHarness = new RemoteCashEscrow(
            IERC20MobilitySettlement(address(cashToken)),
            service,
            CHANNEL,
            CONNECTOR,
            address(this),
            address(0),
            REMOTE_DOMAIN,
            HEDERA_DOMAIN
        );
        AtsCollateralMobilityHarness harness = new AtsCollateralMobilityHarness(
            atsToken,
            PARTITION,
            6,
            100e8,
            _policy(),
            address(this),
            service,
            CHANNEL,
            CONNECTOR,
            address(remoteForHarness),
            HEDERA_DOMAIN,
            REMOTE_DOMAIN
        );
        remoteForHarness.initializePeerApplication(address(harness));
        atsToken.setAllowance(BORROWER, address(harness), COLLATERAL);
        vm.prank(LENDER);
        cashToken.approve(address(remoteForHarness), type(uint256).max);

        vm.deal(address(this), harness.HSS_RESERVE_TINYBAR());
        harness.fundAutomation{value: harness.HSS_RESERVE_TINYBAR()}();

        vm.prank(LENDER);
        (bytes32 mobilityId, bytes32 funded) = remoteForHarness.fundOffer(_terms());
        remoteForHarness.dispatchMessage(funded);
        service.deliver(0);
        vm.prank(BORROWER);
        bytes32 locked = harness.acceptOffer(mobilityId);
        harness.dispatchMessage(locked);
        service.deliver(1);
        vm.prank(BORROWER);
        bytes32 withdrawn = remoteForHarness.withdrawPrincipal(mobilityId);
        remoteForHarness.dispatchMessage(withdrawn);
        service.deliver(2);

        assertEq(harness.reservedAutomation(), harness.HSS_RESERVE_TINYBAR());
        AtsCollateralMobility.Position memory position = harness.getPosition(mobilityId);
        assertEq(uint256(position.automation), uint256(AtsCollateralMobility.AutomationState.PENDING));
        vm.warp(position.maturity + 1);
        harness.settle(mobilityId);
        assertEq(harness.reservedAutomation(), 0);
        position = harness.getPosition(mobilityId);
        assertEq(uint256(position.automation), uint256(AtsCollateralMobility.AutomationState.COMPLETED));
    }

    function _openPosition() private returns (bytes32 mobilityId, uint64 maturity) {
        (mobilityId,) = _fundAndLock();
        vm.prank(BORROWER);
        bytes32 principalOutbox = remote.withdrawPrincipal(mobilityId);
        remote.dispatchMessage(principalOutbox);
        service.deliver(2);
        AtsCollateralMobility.Position memory position = hedera.getPosition(mobilityId);
        assertEq(uint256(position.state), uint256(AtsCollateralMobility.PositionState.OPEN));
        maturity = position.maturity;
    }

    function _fundAndLock() private returns (bytes32 mobilityId, bytes32 lockedOutbox) {
        bytes32 fundingOutbox;
        (mobilityId, fundingOutbox) = _fundOnly();
        remote.dispatchMessage(fundingOutbox);
        service.deliver(0);
        vm.prank(BORROWER);
        lockedOutbox = hedera.acceptOffer(mobilityId);
        hedera.dispatchMessage(lockedOutbox);
        service.deliver(1);
    }

    function _fundOnly() private returns (bytes32 mobilityId, bytes32 fundingOutbox) {
        vm.prank(LENDER);
        return remote.fundOffer(_terms());
    }

    function _terms() private view returns (ClprMobilityTypes.Terms memory) {
        return ClprMobilityTypes.Terms({
            lender: LENDER,
            borrower: BORROWER,
            collateralAmount: uint128(COLLATERAL),
            principalTokenUnits: uint128(PRINCIPAL),
            repaymentTokenUnits: uint128(REPAYMENT),
            termSeconds: 1 days,
            offerExpiresAt: uint64(block.timestamp + 1 days)
        });
    }

    function _policy() private pure returns (AtsCollateralMobility.Policy memory) {
        return AtsCollateralMobility.Policy({
            maximumAdvanceBps: 5_000,
            maximumRepaymentBps: 12_000,
            minimumTermSeconds: 2 minutes,
            maximumTermSeconds: 30 days,
            maximumOfferLifetimeSeconds: 7 days
        });
    }
}
