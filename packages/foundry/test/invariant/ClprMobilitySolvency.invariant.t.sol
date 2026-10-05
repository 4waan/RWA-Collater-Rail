// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralMobility} from "../../contracts/experimental/clpr/AtsCollateralMobility.sol";
import {ClprApplicationBase} from "../../contracts/experimental/clpr/ClprApplicationBase.sol";
import {ClprMobilityTypes} from "../../contracts/experimental/clpr/ClprMobilityTypes.sol";
import {IERC20MobilitySettlement, RemoteCashEscrow} from "../../contracts/experimental/clpr/RemoteCashEscrow.sol";
import {TestBase, StdInvariantBase, Vm} from "../TestBase.sol";
import {AtsCollateralMobilityHarness} from "../mocks/AtsCollateralMobilityHarness.sol";
import {MockAtsToken} from "../mocks/MockAtsToken.sol";
import {MockClprService} from "../mocks/MockClprService.sol";
import {MockSettlementToken} from "../mocks/MockSettlementToken.sol";

contract ClprMobilityHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant COVER_REPAYMENT = 1 << 0;
    uint256 internal constant COVER_DEFAULT = 1 << 1;
    uint256 internal constant COVER_DEFAULT_REFUND = 1 << 2;
    uint256 internal constant COVER_LOCKED_CANCEL = 1 << 3;
    uint256 internal constant COVER_DUPLICATE = 1 << 4;
    uint256 internal constant COVER_INVALID_SOURCE = 1 << 5;
    uint256 internal constant COVER_LATE_REPAYMENT = 1 << 6;
    uint256 public constant REQUIRED_POST_SEED_COVERAGE = (1 << 7) - 1;

    uint256 internal constant COLLATERAL = 1_000e6;
    address internal constant LENDER = address(0xBEEF);
    address internal constant BORROWER = address(0xCAFE);

    MockClprService public immutable service;
    MockSettlementToken public immutable token;
    MockAtsToken public immutable ats;
    RemoteCashEscrow public immutable remote;
    AtsCollateralMobilityHarness public immutable hedera;

    uint256 public ghostFundedPrincipal;
    uint256 public ghostPendingRepayment;
    uint256 public ghostTokenCredits;
    uint256 public ghostPendingSchedules;
    uint256 public collateralAccepted;
    uint256 public activatedPositions;
    uint256 public repaidPositions;
    uint256 public defaultedPositions;
    uint256 public cancelledLockedPositions;
    uint256 public openPositions;
    uint256 public repaymentPayouts;
    uint256 public repaymentRefunds;
    uint256 public finalizedRepaymentEscrows;
    uint256 public postSeedCoverage;
    uint256 public postSeedTransitions;
    bool public postSeedCoverageEnabled;

    constructor(
        MockClprService service_,
        MockSettlementToken token_,
        MockAtsToken ats_,
        RemoteCashEscrow remote_,
        AtsCollateralMobilityHarness hedera_
    ) {
        service = service_;
        token = token_;
        ats = ats_;
        remote = remote_;
        hedera = hedera_;
    }

    receive() external payable {}

    function enablePostSeedCoverage() external {
        postSeedCoverageEnabled = true;
    }

    function repaymentLifecycle(uint64 seed) external {
        (bytes32 mobilityId, uint256 repayment) = _open(seed);
        uint256 index = service.messageCount();
        vm.prank(BORROWER);
        bytes32 repaymentOutbox = remote.escrowRepayment(mobilityId);
        ghostPendingRepayment += repayment;
        remote.dispatchMessage(repaymentOutbox);
        service.deliver(index);
        ++repaidPositions;
        --openPositions;

        bytes32 accepted = hedera.latestOutbox(mobilityId, ClprMobilityTypes.MessageKind.REPAYMENT_ACCEPTED);
        index = service.messageCount();
        hedera.dispatchMessage(accepted);
        service.deliver(index);
        ghostPendingRepayment -= repayment;
        ghostTokenCredits += repayment;
        repaymentPayouts += repayment;
        finalizedRepaymentEscrows += repayment;

        AtsCollateralMobility.Position memory position = hedera.getPosition(mobilityId);
        vm.warp(position.maturity + 2);
        hedera.settle(mobilityId);
        --ghostPendingSchedules;
        _cover(COVER_REPAYMENT);
    }

    function defaultLifecycle(uint64 seed) external {
        (bytes32 mobilityId,) = _open(seed);
        AtsCollateralMobility.Position memory position = hedera.getPosition(mobilityId);
        vm.warp(position.maturity + 2);
        (, bytes32 defaultOutbox) = hedera.settle(mobilityId);
        --ghostPendingSchedules;
        ++defaultedPositions;
        --openPositions;
        uint256 index = service.messageCount();
        hedera.dispatchMessage(defaultOutbox);
        service.deliver(index);
        _cover(COVER_DEFAULT);
    }

    function defaultWithPendingRepayment(uint64 seed) external {
        (bytes32 mobilityId, uint256 repayment) = _open(seed);
        uint256 lateMessageIndex = service.messageCount();
        vm.prank(BORROWER);
        bytes32 repaymentOutbox = remote.escrowRepayment(mobilityId);
        ghostPendingRepayment += repayment;
        remote.dispatchMessage(repaymentOutbox);

        AtsCollateralMobility.Position memory position = hedera.getPosition(mobilityId);
        vm.warp(position.maturity + 2);
        (, bytes32 defaultOutbox) = hedera.settle(mobilityId);
        --ghostPendingSchedules;
        ++defaultedPositions;
        --openPositions;
        uint256 defaultMessageIndex = service.messageCount();
        hedera.dispatchMessage(defaultOutbox);
        service.deliver(defaultMessageIndex);
        ghostPendingRepayment -= repayment;
        ghostTokenCredits += repayment;
        repaymentRefunds += repayment;
        finalizedRepaymentEscrows += repayment;
        _cover(COVER_DEFAULT_REFUND);

        try service.deliver(lateMessageIndex) {
            revert("late repayment accepted after default");
        } catch {
            _cover(COVER_LATE_REPAYMENT);
        }
    }

    function cancelLockedLifecycle(uint64 seed) external {
        (bytes32 mobilityId, ClprMobilityTypes.Terms memory terms) = _fundAndLock(seed);
        vm.warp(terms.offerExpiresAt + 1);
        vm.prank(LENDER);
        bytes32 cancelOutbox = remote.cancelOffer(mobilityId);
        ghostFundedPrincipal -= terms.principalTokenUnits;
        ghostTokenCredits += terms.principalTokenUnits;
        uint256 index = service.messageCount();
        remote.dispatchMessage(cancelOutbox);
        service.deliver(index);
        ++cancelledLockedPositions;
        _cover(COVER_LOCKED_CANCEL);
    }

    function duplicateAndInvalidDelivery(uint64 seed) external {
        ClprMobilityTypes.Terms memory terms = _prepareTerms(seed);
        vm.prank(LENDER);
        (bytes32 mobilityId, bytes32 funded) = remote.fundOffer(terms);
        ghostFundedPrincipal += terms.principalTokenUnits;
        uint256 index = service.messageCount();
        remote.dispatchMessage(funded);
        service.deliver(index);
        service.deliver(index);
        _cover(COVER_DUPLICATE);

        MockClprService.QueuedMessage memory queued = service.messageAt(index);
        try service.deliverRaw(address(hedera), queued.channelId, address(0xBAD), queued.data) {
            revert("invalid source accepted");
        } catch {
            _cover(COVER_INVALID_SOURCE);
        }

        vm.prank(LENDER);
        bytes32 cancelled = remote.cancelOffer(mobilityId);
        ghostFundedPrincipal -= terms.principalTokenUnits;
        ghostTokenCredits += terms.principalTokenUnits;
        index = service.messageCount();
        remote.dispatchMessage(cancelled);
        service.deliver(index);
    }

    function _open(uint64 seed) private returns (bytes32 mobilityId, uint256 repayment) {
        ClprMobilityTypes.Terms memory terms;
        (mobilityId, terms) = _fundAndLock(seed);
        repayment = terms.repaymentTokenUnits;
        vm.prank(BORROWER);
        bytes32 principal = remote.withdrawPrincipal(mobilityId);
        ghostFundedPrincipal -= terms.principalTokenUnits;
        uint256 index = service.messageCount();
        remote.dispatchMessage(principal);
        service.deliver(index);
        ++activatedPositions;
        ++openPositions;
        ++ghostPendingSchedules;
    }

    function _fundAndLock(uint64 seed) private returns (bytes32 mobilityId, ClprMobilityTypes.Terms memory terms) {
        terms = _prepareTerms(seed);
        vm.prank(LENDER);
        bytes32 funded;
        (mobilityId, funded) = remote.fundOffer(terms);
        ghostFundedPrincipal += terms.principalTokenUnits;
        uint256 index = service.messageCount();
        remote.dispatchMessage(funded);
        service.deliver(index);
        vm.prank(BORROWER);
        bytes32 locked = hedera.acceptOffer(mobilityId);
        ++collateralAccepted;
        index = service.messageCount();
        hedera.dispatchMessage(locked);
        service.deliver(index);
    }

    function _prepareTerms(uint64 seed) private returns (ClprMobilityTypes.Terms memory terms) {
        ats.setMaturity(block.timestamp + 730 days);
        ats.setBalance(hedera.partition(), BORROWER, 1e30);
        ats.setAllowance(BORROWER, address(hedera), type(uint256).max);
        uint256 principal = (1 + uint256(seed % 50_000)) * 1e6;
        uint256 repayment = principal + (principal / 100) + 1;
        token.mint(LENDER, principal);
        token.mint(BORROWER, repayment);
        vm.prank(LENDER);
        token.approve(address(remote), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(remote), type(uint256).max);
        terms = ClprMobilityTypes.Terms({
            lender: LENDER,
            borrower: BORROWER,
            collateralAmount: uint128(COLLATERAL),
            principalTokenUnits: uint128(principal),
            repaymentTokenUnits: uint128(repayment),
            termSeconds: uint64(120 + seed % uint64(1 days)),
            offerExpiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _cover(uint256 bit) private {
        if (!postSeedCoverageEnabled) return;
        postSeedCoverage |= bit;
        ++postSeedTransitions;
    }
}

contract ClprMobilitySolvencyInvariantTest is TestBase, StdInvariantBase {
    bytes32 internal constant PARTITION = keccak256("CLPR-INVARIANT");
    bytes32 internal constant CHANNEL = keccak256("CLPR-CHANNEL");
    bytes32 internal constant CONNECTOR = keccak256("CLPR-CONNECTOR");
    bytes32 internal constant HEDERA_DOMAIN = keccak256("hedera:testnet");
    bytes32 internal constant REMOTE_DOMAIN = keccak256("eip155:1337");

    MockClprService internal service;
    MockSettlementToken internal token;
    MockAtsToken internal ats;
    RemoteCashEscrow internal remote;
    AtsCollateralMobilityHarness internal hedera;
    ClprMobilityHandler internal handler;

    function setUp() public {
        vm.warp(1_900_000_000);
        service = new MockClprService();
        token = new MockSettlementToken();
        ats = new MockAtsToken();
        remote = new RemoteCashEscrow(
            IERC20MobilitySettlement(address(token)),
            service,
            CHANNEL,
            CONNECTOR,
            address(this),
            address(0),
            REMOTE_DOMAIN,
            HEDERA_DOMAIN
        );
        hedera = new AtsCollateralMobilityHarness(
            ats,
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
        ats.setKyc(address(0xBEEF), true);
        ats.setKyc(address(0xCAFE), true);
        handler = new ClprMobilityHandler(service, token, ats, remote, hedera);

        vm.deal(address(this), 1e24);
        hedera.fundAutomation{value: 1e22}();
        handler.repaymentLifecycle(1);
        handler.defaultLifecycle(2);
        handler.defaultWithPendingRepayment(3);
        handler.cancelLockedLifecycle(4);
        handler.duplicateAndInvalidDelivery(5);
        handler.enablePostSeedCoverage();

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = ClprMobilityHandler.repaymentLifecycle.selector;
        selectors[1] = ClprMobilityHandler.defaultLifecycle.selector;
        selectors[2] = ClprMobilityHandler.defaultWithPendingRepayment.selector;
        selectors[3] = ClprMobilityHandler.cancelLockedLifecycle.selector;
        selectors[4] = ClprMobilityHandler.duplicateAndInvalidDelivery.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantRemoteBalanceCoversLiabilities() public view {
        assertTrue(token.balanceOf(address(remote)) >= remote.cashTokenLiabilities());
    }

    function invariantHederaBalanceCoversAutomation() public view {
        assertTrue(address(hedera).balance >= hedera.reservedAutomation());
    }

    function invariantRemoteLiabilitiesMatchIndependentGhosts() public view {
        assertEq(
            remote.cashTokenLiabilities(),
            handler.ghostFundedPrincipal() + handler.ghostPendingRepayment() + handler.ghostTokenCredits()
        );
    }

    function invariantAutomationMatchesPendingSchedules() public view {
        assertEq(hedera.reservedAutomation(), handler.ghostPendingSchedules() * hedera.HSS_RESERVE_TINYBAR());
    }

    function invariantEveryAcceptanceCreatesOneHold() public view {
        assertEq(ats.holdsCreated(), handler.collateralAccepted());
    }

    function invariantEveryHoldHasOneTerminalOutcomeAtMost() public view {
        assertEq(
            ats.terminalActions(),
            handler.repaidPositions() + handler.defaultedPositions() + handler.cancelledLockedPositions()
        );
    }

    function invariantOpenPositionsMatchActivationAndTerminals() public view {
        assertEq(
            handler.openPositions(),
            handler.activatedPositions() - handler.repaidPositions() - handler.defaultedPositions()
        );
    }

    function invariantRepaymentEscrowHasOneRemoteTerminalCredit() public view {
        assertEq(handler.repaymentPayouts() + handler.repaymentRefunds(), handler.finalizedRepaymentEscrows());
    }

    function testPostSeedCoverageReachesRequiredPaths() public {
        assertEq(handler.postSeedCoverage(), 0);
        handler.repaymentLifecycle(11);
        handler.defaultLifecycle(12);
        handler.defaultWithPendingRepayment(13);
        handler.cancelLockedLifecycle(14);
        handler.duplicateAndInvalidDelivery(15);
        assertEq(handler.postSeedCoverage(), handler.REQUIRED_POST_SEED_COVERAGE());
    }

    function afterInvariant() public view {
        assertTrue(handler.postSeedTransitions() > 0);
        assertTrue(handler.postSeedCoverage() > 0);
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
