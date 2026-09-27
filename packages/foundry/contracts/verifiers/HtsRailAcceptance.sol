// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/HederaTokenService.sol";
import {IHederaTokenService} from "@hiero-ledger/hiero-contracts/token-service/IHederaTokenService.sol";

interface IHtsRailReadiness {
    function settlementToken() external view returns (address);
    function settlementInitialized() external view returns (bool);
    function settlementDecimals() external view returns (uint8);
    function settlementHasKycKey() external view returns (bool);
    function settlementHasFreezeKey() external view returns (bool);
}

interface IHtsBalanceFacade {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Read-only acceptance checks for an HTS settlement account.
/// @dev The contract has no token key and exposes no compliance mutation.
contract HtsRailAcceptance is HederaTokenService {
    struct Readiness {
        bool initialized;
        bool tokenPolicyReady;
        bool associationReady;
        bool kycReady;
        bool unfrozen;
        bool balanceReady;
        bool allowanceReady;
        uint256 balanceTokenUnits;
        uint256 allowanceTokenUnits;
        int64 metadataResponse;
        int64 feeResponse;
        int64 frozenResponse;
        int64 kycResponse;
        int64 allowanceResponse;
    }

    int64 internal constant HEDERA_SUCCESS = 22;
    uint256 private constant HTS_KYC_KEY = 1 << 1;
    uint256 private constant HTS_FREEZE_KEY = 1 << 2;

    IHtsRailReadiness public immutable rail;

    constructor(IHtsRailReadiness rail_) {
        if (address(rail_) == address(0)) revert("ZERO_RAIL");
        rail = rail_;
    }

    function inspect(address account, uint256 requiredTokenUnits) external returns (Readiness memory result) {
        address token = rail.settlementToken();
        result.initialized = rail.settlementInitialized();

        (bool metadataHasKycKey, bool metadataHasFreezeKey) = _inspectPolicy(token, result);
        _inspectCompliance(token, account, metadataHasKycKey, metadataHasFreezeKey, result);
        _inspectAmounts(token, account, requiredTokenUnits, result);
    }

    function _inspectPolicy(address token, Readiness memory result)
        internal
        returns (bool metadataHasKycKey, bool metadataHasFreezeKey)
    {
        int64 metadataResponse;
        int32 decimals;
        bool deleted;
        bool paused;
        (metadataResponse, decimals, deleted, paused, metadataHasKycKey, metadataHasFreezeKey) = _metadata(token);
        result.metadataResponse = metadataResponse;
        int64 feeResponse;
        uint256 fixedFees;
        uint256 fractionalFees;
        uint256 royaltyFees;
        (feeResponse, fixedFees, fractionalFees, royaltyFees) = _feeCounts(token);
        result.feeResponse = feeResponse;
        result.tokenPolicyReady = result.metadataResponse == HEDERA_SUCCESS && result.feeResponse == HEDERA_SUCCESS
            && !deleted && !paused && decimals == int32(uint32(rail.settlementDecimals())) && fixedFees == 0
            && fractionalFees == 0 && royaltyFees == 0 && metadataHasKycKey == rail.settlementHasKycKey()
            && metadataHasFreezeKey == rail.settlementHasFreezeKey();
    }

    function _inspectCompliance(
        address token,
        address account,
        bool metadataHasKycKey,
        bool metadataHasFreezeKey,
        Readiness memory result
    ) internal {
        bool frozen;
        if (metadataHasFreezeKey) {
            int64 frozenResponse;
            (frozenResponse, frozen) = _frozen(token, account);
            result.frozenResponse = frozenResponse;
            result.unfrozen = result.frozenResponse == HEDERA_SUCCESS && !frozen;
        } else {
            result.frozenResponse = HEDERA_SUCCESS;
            result.unfrozen = true;
        }

        bool kycGranted;
        if (metadataHasKycKey) {
            int64 kycResponse;
            (kycResponse, kycGranted) = _kyc(token, account);
            result.kycResponse = kycResponse;
            result.kycReady = result.kycResponse == HEDERA_SUCCESS && kycGranted;
        } else {
            result.kycResponse = HEDERA_SUCCESS;
            result.kycReady = true;
        }
    }

    function _inspectAmounts(address token, address account, uint256 requiredTokenUnits, Readiness memory result)
        internal
    {
        (int64 allowanceResponse, uint256 allowanceTokenUnits) = _allowance(token, account, address(rail));
        result.allowanceResponse = allowanceResponse;
        result.allowanceTokenUnits = allowanceTokenUnits;
        result.associationReady = result.allowanceResponse == HEDERA_SUCCESS;
        result.allowanceReady = result.associationReady && result.allowanceTokenUnits >= requiredTokenUnits;
        result.balanceTokenUnits = _balance(token, account);
        result.balanceReady = result.balanceTokenUnits >= requiredTokenUnits;
    }

    function ready(Readiness memory result) external pure returns (bool) {
        return result.initialized && result.tokenPolicyReady && result.associationReady && result.kycReady
            && result.unfrozen && result.balanceReady && result.allowanceReady;
    }

    function _metadata(address token)
        internal
        virtual
        returns (int64 responseCode, int32 decimals, bool deleted, bool paused, bool hasKycKey, bool hasFreezeKey)
    {
        (int256 response, IHederaTokenService.FungibleTokenInfo memory info) = getFungibleTokenInfo(token);
        if (response < type(int64).min || response > type(int64).max) return (0, 0, false, false, false, false);
        responseCode = int64(response);
        decimals = info.decimals;
        deleted = info.tokenInfo.deleted;
        paused = info.tokenInfo.pauseStatus;
        hasKycKey = _hasKey(info.tokenInfo.token.tokenKeys, HTS_KYC_KEY);
        hasFreezeKey = _hasKey(info.tokenInfo.token.tokenKeys, HTS_FREEZE_KEY);
    }

    function _feeCounts(address token)
        internal
        virtual
        returns (int64 responseCode, uint256 fixedFees, uint256 fractionalFees, uint256 royaltyFees)
    {
        IHederaTokenService.FixedFee[] memory fixedFeeList;
        IHederaTokenService.FractionalFee[] memory fractionalFeeList;
        IHederaTokenService.RoyaltyFee[] memory royaltyFeeList;
        (responseCode, fixedFeeList, fractionalFeeList, royaltyFeeList) = getTokenCustomFees(token);
        return (responseCode, fixedFeeList.length, fractionalFeeList.length, royaltyFeeList.length);
    }

    function _frozen(address token, address account) internal virtual returns (int64, bool) {
        return isFrozen(token, account);
    }

    function _kyc(address token, address account) internal virtual returns (int64, bool) {
        return isKyc(token, account);
    }

    function _allowance(address token, address account, address spender) internal virtual returns (int64, uint256) {
        return allowance(token, account, spender);
    }

    function _balance(address token, address account) internal view virtual returns (uint256 balance) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeCall(IHtsBalanceFacade.balanceOf, (account)));
        if (!success || result.length != 32) return 0;
        return abi.decode(result, (uint256));
    }

    function _hasKey(IHederaTokenService.TokenKey[] memory tokenKeys, uint256 keyType) private pure returns (bool) {
        for (uint256 i = 0; i < tokenKeys.length; ++i) {
            if ((tokenKeys[i].keyType & keyType) != 0) return true;
        }
        return false;
    }
}
