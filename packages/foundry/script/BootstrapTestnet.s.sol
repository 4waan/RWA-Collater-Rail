// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAtsFactory} from "../contracts/interfaces/IAtsFactory.sol";
import {IAtsCollateralToken, IAtsIssuerSetup} from "../contracts/interfaces/IAtsCollateralToken.sol";
import {IPyth} from "../contracts/interfaces/IPyth.sol";
import {PythHbarUsdOracle} from "../contracts/oracle/PythHbarUsdOracle.sol";
import {HederaExchangeRateOracle} from "../contracts/oracle/HederaExchangeRateOracle.sol";
import {IHbarUsdOracle} from "../contracts/interfaces/IPyth.sol";
import {AtsCollateralRail} from "../contracts/AtsCollateralRail.sol";
import {RailAcceptance} from "../contracts/verifiers/RailAcceptance.sol";

interface VmBootstrap {
    function envAddress(string calldata name) external view returns (address value);
    function envOr(string calldata name, address defaultValue) external view returns (address value);
    function envOr(string calldata name, bytes32 defaultValue) external view returns (bytes32 value);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256 value);
    function startBroadcast() external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
}

contract BootstrapTestnet {
    struct BootstrapConfig {
        address operator;
        address lender;
        address borrower;
        address resolver;
        address factory;
        address pyth;
        bool usePythOracle;
    }

    VmBootstrap internal constant vm = VmBootstrap(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant DEFAULT_RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;
    address internal constant DEFAULT_FACTORY = 0xd1F118A40f3b02883D35909eF2517e7EDd78379d;
    address internal constant DEFAULT_PYTH = 0xA2aa501b19aff244D90cc15a4Cf739D2725B5729;
    bytes32 internal constant HBAR_USD_PRICE_ID = 0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd;
    bytes32 internal constant DEFAULT_PARTITION = bytes32(uint256(1));
    bytes32 internal constant BOND_CONFIG = bytes32(uint256(2));
    uint256 internal constant WEIBAR_PER_TINYBAR = 10_000_000_000;

    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 internal constant ROLE_ISSUER = 0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    bytes32 internal constant ROLE_KYC = 0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc;
    bytes32 internal constant ROLE_SSI_MANAGER = 0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1;

    error DependencyUnavailable(address dependency);
    error SetupFailed(bytes4 selector);
    error ConfigurationMismatch();

    event BootstrapCompleted(address indexed token, address indexed oracle, address indexed rail);

    function run() external virtual {
        BootstrapConfig memory config = _readConfig();
        _validateDependencies(config.resolver, config.factory, config.pyth, config.usePythOracle);

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

        IHbarUsdOracle priceOracle = config.usePythOracle
            ? IHbarUsdOracle(address(new PythHbarUsdOracle(IPyth(config.pyth), HBAR_USD_PRICE_ID)))
            : IHbarUsdOracle(address(new HederaExchangeRateOracle()));
        AtsCollateralRail rail = new AtsCollateralRail(
            IAtsCollateralToken(token), DEFAULT_PARTITION, priceOracle, 0, 100 * 1e8, _readPolicy(), config.operator
        );
        // Foundry signs an EthereumTransaction value in weibars. Hedera converts it
        // to tinybars before exposing msg.value to the deployed rail.
        rail.fundAutomation{value: 2 * rail.HSS_RESERVE_TINYBAR() * WEIBAR_PER_TINYBAR}();
        RailAcceptance acceptance = new RailAcceptance(rail);
        vm.stopBroadcast();

        _validateLiveConfiguration(token, config.operator, config.lender, config.borrower, maturity);
        _writeAddresses(token, address(priceOracle), address(rail), address(acceptance), config, maturity);
        emit BootstrapCompleted(token, address(priceOracle), address(rail));
    }

    function _readConfig() internal view returns (BootstrapConfig memory config) {
        config.operator = vm.envOr("HEDERA_OPERATOR_ADDRESS", address(0));
        if (config.operator == address(0)) config.operator = vm.envAddress("HARNESS_SIGNER_EVM_ADDRESS");
        config.lender = vm.envAddress("LENDER_ADDRESS");
        config.borrower = vm.envAddress("BORROWER_ADDRESS");
        config.resolver = vm.envOr("ATS_RESOLVER_ADDRESS", DEFAULT_RESOLVER);
        config.factory = vm.envOr("ATS_FACTORY_ADDRESS", DEFAULT_FACTORY);
        config.pyth = vm.envOr("PYTH_ADDRESS", DEFAULT_PYTH);
        config.usePythOracle = vm.envOr("USE_PYTH_ORACLE", uint256(0)) == 1;
    }

    function _startBroadcast(address operator) internal {
        bytes32 harnessKey = vm.envOr("HARNESS_SIGNER_PRIVATE_KEY", bytes32(0));
        if (harnessKey == bytes32(0)) {
            vm.startBroadcast();
            return;
        }
        uint256 privateKey = uint256(harnessKey);
        if (vm.addr(privateKey) != operator) revert ConfigurationMismatch();
        vm.startBroadcast(privateKey);
    }

    function _validateDependencies(address resolver, address factory, address pyth, bool usePythOracle) internal view {
        if (resolver.code.length == 0) revert DependencyUnavailable(resolver);
        if (factory.code.length == 0) revert DependencyUnavailable(factory);
        if (usePythOracle && pyth.code.length == 0) revert DependencyUnavailable(pyth);
        // The TypeScript runner checks HSS capacity directly through Hedera
        // JSON RPC before this script starts. Forge's local script EVM cannot
        // execute Hedera system contracts, so duplicating that call here would
        // reject a healthy network before any transaction is broadcast.
    }

    function _validateLiveConfiguration(
        address token,
        address operator,
        address lender,
        address borrower,
        uint256 maturity
    ) internal view {
        IAtsCollateralToken runtime = IAtsCollateralToken(token);
        IAtsIssuerSetup setup = IAtsIssuerSetup(token);
        if (
            !setup.isInternalKycActivated() || !setup.isIssuer(operator)
                || runtime.getKycStatusFor(lender) != IAtsCollateralToken.KycStatus.GRANTED
                || runtime.getKycStatusFor(borrower) != IAtsCollateralToken.KycStatus.GRANTED
                || runtime.getMaturityDate() != maturity || !runtime.hasRole(ROLE_ISSUER, operator)
                || !runtime.hasRole(ROLE_KYC, operator) || !runtime.hasRole(ROLE_SSI_MANAGER, operator)
                || runtime.isClearingActivated() || runtime.decimals() != 0 || runtime.getNominalValue() != 10_000
                || runtime.getNominalValueDecimals() != 2 || runtime.getNominalValueCurrency() != bytes3("USD")
        ) revert ConfigurationMismatch();
    }

    function _bond(address operator, uint256 maturity, address resolver)
        internal
        view
        returns (IAtsFactory.BondData memory bond)
    {
        bytes32[4] memory roles = [DEFAULT_ADMIN_ROLE, ROLE_ISSUER, ROLE_KYC, ROLE_SSI_MANAGER];
        IAtsFactory.Rbac[] memory rbacs = new IAtsFactory.Rbac[](roles.length);
        for (uint256 i = 0; i < roles.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = operator;
            rbacs[i] = IAtsFactory.Rbac({role: roles[i], members: members});
        }

        IAtsFactory.SecurityData memory security = IAtsFactory.SecurityData({
            resolver: resolver,
            maxSupply: 1_000_000,
            resolverProxyConfiguration: IAtsFactory.ResolverProxyConfiguration({key: BOND_CONFIG, version: 1}),
            erc20MetadataInfo: IAtsFactory.ERC20MetadataInfo({
                name: "Collateral Rail Test Bond 2028", symbol: "CRTB", isin: "XS0COLRAIL07", decimals: 0
            }),
            rbacs: rbacs,
            externalPauses: new address[](0),
            externalControlLists: new address[](0),
            externalKycLists: new address[](0),
            compliance: address(0),
            identityRegistry: address(0),
            arePartitionsProtected: false,
            isMultiPartition: false,
            isControllable: true,
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: true,
            erc20VotesActivated: false
        });

        bond = IAtsFactory.BondData({
            security: security,
            bondDetails: IAtsFactory.BondDetailsData({
                currency: bytes3("USD"),
                nominalValue: 10_000,
                nominalValueDecimals: 2,
                startingDate: block.timestamp,
                maturityDate: maturity
            }),
            proceedRecipients: new address[](0),
            proceedRecipientsData: new bytes[](0)
        });
    }

    function _regulation() internal pure returns (IAtsFactory.FactoryRegulationData memory) {
        return IAtsFactory.FactoryRegulationData({
            regulationType: IAtsFactory.RegulationType.REG_S,
            regulationSubType: IAtsFactory.RegulationSubType.NONE,
            additionalSecurityData: IAtsFactory.AdditionalSecurityData({
                countriesControlListType: false,
                listOfCountries: "",
                info: "Collateral Rail self-contained testnet security"
            })
        });
    }

    function _readPolicy() internal view returns (AtsCollateralRail.RailPolicy memory) {
        uint256 advance = vm.envOr("RAIL_MAXIMUM_ADVANCE_BPS", uint256(7_000));
        uint256 rate = vm.envOr("RAIL_MAXIMUM_ANNUAL_RATE_BPS", uint256(10_000));
        uint256 movement = vm.envOr("RAIL_MAXIMUM_QUOTE_MOVEMENT_BPS", uint256(100));
        uint256 minimumTerm = vm.envOr("RAIL_MINIMUM_TERM_SECONDS", uint256(2 minutes));
        uint256 maximumTerm = vm.envOr("RAIL_MAXIMUM_TERM_SECONDS", uint256(365 days));
        uint256 offerLifetime = vm.envOr("RAIL_MAXIMUM_OFFER_LIFETIME_SECONDS", uint256(24 hours));
        if (
            advance == 0 || advance > 7_000 || rate > 10_000 || movement > 100 || minimumTerm < 2 minutes
                || maximumTerm < minimumTerm || maximumTerm > 365 days || offerLifetime == 0 || offerLifetime > 24 hours
        ) revert ConfigurationMismatch();
        return AtsCollateralRail.RailPolicy({
            maximumAdvanceBps: uint16(advance),
            maximumAnnualRateBps: uint16(rate),
            maximumQuoteMovementBps: uint16(movement),
            minimumTermSeconds: uint64(minimumTerm),
            maximumTermSeconds: uint64(maximumTerm),
            maximumOfferLifetimeSeconds: uint64(offerLifetime)
        });
    }

    function _writeAddresses(
        address token,
        address oracle,
        address rail,
        address acceptance,
        BootstrapConfig memory config,
        uint256 maturity
    ) internal {
        string memory key = "deployment";
        vm.serializeAddress(key, "atsToken", token);
        vm.serializeAddress(key, "oracle", oracle);
        vm.serializeAddress(key, "rail", rail);
        vm.serializeAddress(key, "acceptance", acceptance);
        vm.serializeAddress(key, "factory", config.factory);
        vm.serializeAddress(key, "resolver", config.resolver);
        vm.serializeAddress(key, "pyth", config.pyth);
        vm.serializeAddress(key, "operator", config.operator);
        vm.serializeAddress(key, "lender", config.lender);
        vm.serializeAddress(key, "borrower", config.borrower);
        string memory json = vm.serializeUint(key, "assetMaturity", maturity);
        vm.writeJson(json, "./deployments/latest-addresses.json");
    }
}
