// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AtsCollateralRailHts} from "../../contracts/AtsCollateralRailHts.sol";
import {IHederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/IHederaTokenService.sol";
import {IAtsCollateralToken} from "../../contracts/interfaces/IAtsCollateralToken.sol";
import {IUsdOracle} from "../../contracts/interfaces/IUsdOracle.sol";
import {MockHtsToken} from "./MockHtsToken.sol";

contract AtsCollateralRailHtsHarness is AtsCollateralRailHts {
    uint256 public availableOnAttempt;
    uint256 public scheduleAttempts;
    uint64[] public scheduledSeconds;
    int64 public mockScheduleResponse = HEDERA_SUCCESS;
    address public mockScheduleAddress = address(0x516B);

    constructor(
        IAtsCollateralToken atsToken_,
        bytes32 partition_,
        MockHtsToken settlementToken_,
        IUsdOracle oracle_,
        uint8 atsTokenDecimals_,
        uint256 atsNominalValueUsdE8_,
        RailPolicy memory policy_,
        address owner_
    )
        AtsCollateralRailHts(
            atsToken_,
            partition_,
            address(settlementToken_),
            oracle_,
            atsTokenDecimals_,
            atsNominalValueUsdE8_,
            policy_,
            owner_
        )
    {}

    function configureSchedule(uint256 attempt, int64 responseCode, address scheduleAddress) external {
        availableOnAttempt = attempt;
        mockScheduleResponse = responseCode;
        mockScheduleAddress = scheduleAddress;
    }

    function maximumPrincipalTokenUnits(uint256 collateralAmount, uint256 priceUsdE8) external view returns (uint256) {
        _requireInitialized();
        return _usdToTokenDown(_maximumPrincipalUsdE8(collateralAmount), priceUsdE8);
    }

    function tokenUnitsToUsdE8(uint256 tokenUnits, uint256 priceUsdE8) external view returns (uint256) {
        _requireInitialized();
        return _tokenToUsdUp(tokenUnits, priceUsdE8);
    }

    function repaymentTokenUnits(uint256 principalTokenUnits, uint256 annualRateBps, uint256 termSeconds)
        external
        pure
        returns (uint256)
    {
        return _repayment(principalTokenUnits, annualRateBps, termSeconds);
    }

    function quoteWithinMovement(uint256 quotedPriceUsdE8, uint256 currentPriceUsdE8) external view returns (bool) {
        return _quoteWithinMovement(quotedPriceUsdE8, currentPriceUsdE8);
    }

    function schedulePosition(bytes32, uint64 executionSecond)
        external
        override
        returns (int64 responseCode, address scheduleAddress, bool capacity)
    {
        if (msg.sender != address(this)) revert SelfCallOnly();
        ++scheduleAttempts;
        scheduledSeconds.push(executionSecond);
        capacity = availableOnAttempt != 0 && scheduleAttempts >= availableOnAttempt;
        if (!capacity) return (0, address(0), false);
        return (mockScheduleResponse, mockScheduleAddress, true);
    }

    function _mockToken() internal view returns (MockHtsToken) {
        return MockHtsToken(settlementToken);
    }

    function _htsFungibleMetadata() internal override returns (SettlementMetadata memory) {
        MockHtsToken token = _mockToken();
        if (token.metadataResponse() != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.getFungibleTokenInfo.selector, token.metadataResponse());
        }
        return SettlementMetadata({
            decimals: token.decimals(),
            deleted: token.deleted(),
            defaultKycStatus: token.defaultKycStatus(),
            paused: token.paused()
        });
    }

    function _htsFeeCounts()
        internal
        override
        returns (uint256 fixedFees, uint256 fractionalFees, uint256 royaltyFees)
    {
        MockHtsToken token = _mockToken();
        if (token.feeResponse() != HEDERA_SUCCESS) {
            revert HtsCallFailed(IHederaTokenService.getTokenCustomFees.selector, token.feeResponse());
        }
        return (token.fixedFees(), token.fractionalFees(), token.royaltyFees());
    }

    function _htsAssociateRail() internal override returns (int64) {
        return _mockToken().associateResponse();
    }

    function _htsAllowanceFor(address account) internal override returns (int64 responseCode, uint256 amount) {
        MockHtsToken token = _mockToken();
        return (token.allowanceResponse(), token.allowance(account, address(this)));
    }

    function _htsFrozen(address account) internal override returns (int64 responseCode, bool frozen) {
        MockHtsToken token = _mockToken();
        return (token.frozenResponse(), token.frozen(account));
    }

    function _htsKyc(address account) internal override returns (int64 responseCode, bool granted) {
        MockHtsToken token = _mockToken();
        return (token.kycResponse(), token.kyc(account));
    }

    function _htsTransferFrom(address from, uint256 amount) internal override returns (int64) {
        return _mockToken().transferFromFor(address(this), from, address(this), amount);
    }

    function _htsTransfer(address to, uint256 amount) internal override returns (int64) {
        return _mockToken().transferFor(address(this), to, amount);
    }

    function _tokenBalance(address account) internal view override returns (uint256) {
        return _mockToken().balanceOf(account);
    }
}
