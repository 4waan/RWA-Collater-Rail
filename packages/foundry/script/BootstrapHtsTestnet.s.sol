// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BootstrapTestnet} from "./BootstrapTestnet.s.sol";
import {IAtsFactory} from "../contracts/interfaces/IAtsFactory.sol";
import {IAtsCollateralToken, IAtsIssuerSetup} from "../contracts/interfaces/IAtsCollateralToken.sol";
import {IPyth} from "../contracts/interfaces/IPyth.sol";
import {IUsdOracle} from "../contracts/interfaces/IUsdOracle.sol";
import {PythUsdOracle} from "../contracts/oracle/PythUsdOracle.sol";
import {FixedTestUsdOracle} from "../contracts/oracle/FixedTestUsdOracle.sol";
import {AtsCollateralRailHts} from "../contracts/AtsCollateralRailHts.sol";
import {HtsRailAcceptance, IHtsRailReadiness} from "../contracts/verifiers/HtsRailAcceptance.sol";

contract BootstrapHtsTestnet is BootstrapTestnet {
    bytes32 internal constant USDC_USD_PRICE_ID = 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a;

    function run() external override {
        BootstrapConfig memory config = _readConfig();
        address settlementToken = vm.envAddress("SETTLEMENT_TOKEN_ADDRESS");
        bool useFixedTestOracle = vm.envOr("USE_FIXED_TEST_ORACLE", uint256(0)) == 1;
        if (settlementToken.code.length == 0) revert DependencyUnavailable(settlementToken);
        _validateDependencies(config.resolver, config.factory, config.pyth, !useFixedTestOracle);

        uint256 maturity = block.timestamp + 730 days;
        IAtsFactory.BondData memory bond = _bond(config.operator, maturity, config.resolver);
        IAtsFactory.FactoryRegulationData memory regulation = _regulation();

        _startBroadcast(config.operator);
        address token = IAtsFactory(config.factory).deployBond(bond, regulation);
        if (!IAtsIssuerSetup(token).addIssuer(config.operator)) {
            revert SetupFailed(IAtsIssuerSetup.addIssuer.selector);
        }
        if (!IAtsIssuerSetup(token)
                .grantKyc(config.lender, "collateral-rail-lender", block.timestamp, maturity, config.operator)) {
            revert SetupFailed(IAtsIssuerSetup.grantKyc.selector);
        }
        if (!IAtsIssuerSetup(token)
                .grantKyc(config.borrower, "collateral-rail-borrower", block.timestamp, maturity, config.operator)) {
            revert SetupFailed(IAtsIssuerSetup.grantKyc.selector);
        }
        IAtsIssuerSetup(token).issue(config.borrower, 1_000, bytes(""));

        IUsdOracle priceOracle = useFixedTestOracle
            ? IUsdOracle(address(new FixedTestUsdOracle(vm.envOr("FIXED_TEST_PRICE_USD_E8", uint256(1e8)))))
            : IUsdOracle(address(new PythUsdOracle(IPyth(config.pyth), USDC_USD_PRICE_ID)));
        AtsCollateralRailHts rail = new AtsCollateralRailHts(
            IAtsCollateralToken(token),
            DEFAULT_PARTITION,
            settlementToken,
            priceOracle,
            0,
            100 * 1e8,
            _readHtsPolicy(),
            config.operator
        );
        HtsRailAcceptance acceptance = new HtsRailAcceptance(IHtsRailReadiness(address(rail)));
        vm.stopBroadcast();

        _validateLiveConfiguration(token, config.operator, config.lender, config.borrower, maturity);
        _writeHtsAddresses(
            token,
            settlementToken,
            address(priceOracle),
            address(rail),
            address(acceptance),
            config,
            maturity,
            useFixedTestOracle
        );
        emit BootstrapCompleted(token, address(priceOracle), address(rail));
    }

    function _readHtsPolicy() internal view returns (AtsCollateralRailHts.RailPolicy memory) {
        uint256 advance = vm.envOr("RAIL_MAXIMUM_ADVANCE_BPS", uint256(6_000));
        uint256 rate = vm.envOr("RAIL_MAXIMUM_ANNUAL_RATE_BPS", uint256(5_000));
        uint256 movement = vm.envOr("RAIL_MAXIMUM_QUOTE_MOVEMENT_BPS", uint256(100));
        uint256 minimumTerm = vm.envOr("RAIL_MINIMUM_TERM_SECONDS", uint256(2 minutes));
        uint256 maximumTerm = vm.envOr("RAIL_MAXIMUM_TERM_SECONDS", uint256(365 days));
        uint256 offerLifetime = vm.envOr("RAIL_MAXIMUM_OFFER_LIFETIME_SECONDS", uint256(1 hours));
        if (
            advance == 0 || advance > 7_000 || rate > 10_000 || movement > 100 || minimumTerm < 2 minutes
                || maximumTerm < minimumTerm || maximumTerm > 365 days || offerLifetime == 0 || offerLifetime > 24 hours
        ) revert ConfigurationMismatch();
        return AtsCollateralRailHts.RailPolicy({
            maximumAdvanceBps: uint16(advance),
            maximumAnnualRateBps: uint16(rate),
            maximumQuoteMovementBps: uint16(movement),
            minimumTermSeconds: uint64(minimumTerm),
            maximumTermSeconds: uint64(maximumTerm),
            maximumOfferLifetimeSeconds: uint64(offerLifetime)
        });
    }

    function _writeHtsAddresses(
        address token,
        address settlementToken,
        address oracle,
        address rail,
        address acceptance,
        BootstrapConfig memory config,
        uint256 maturity,
        bool fixedTestOracle
    ) internal {
        string memory key = "deployment";
        vm.serializeAddress(key, "atsToken", token);
        vm.serializeAddress(key, "settlementToken", settlementToken);
        vm.serializeAddress(key, "oracle", oracle);
        vm.serializeAddress(key, "rail", rail);
        vm.serializeAddress(key, "acceptance", acceptance);
        vm.serializeAddress(key, "factory", config.factory);
        vm.serializeAddress(key, "resolver", config.resolver);
        vm.serializeAddress(key, "pyth", config.pyth);
        vm.serializeAddress(key, "operator", config.operator);
        vm.serializeAddress(key, "lender", config.lender);
        vm.serializeAddress(key, "borrower", config.borrower);
        vm.serializeUint(key, "assetMaturity", maturity);
        string memory json = vm.serializeUint(key, "fixedTestOracle", fixedTestOracle ? 1 : 0);
        vm.writeJson(json, "./deployments/latest-hts-addresses.json");
    }
}
