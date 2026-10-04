export const HEDERA_TESTNET_CHAIN_ID = 296;
export const HEDERA_TESTNET_RPC_URL = "https://testnet.hashio.io/api";
export const HEDERA_TESTNET_MIRROR_URL =
  "https://testnet.mirrornode.hedera.com";
export const PYTH_HERMES_URL = "https://hermes.pyth.network";
export const PYTH_ADDRESS =
  "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729" as const;
export const ATS_FACTORY_ADDRESS =
  "0xd1F118A40f3b02883D35909eF2517e7EDd78379d" as const;
export const ATS_RESOLVER_ADDRESS =
  "0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a" as const;
export const HBAR_USD_PRICE_ID =
  "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd" as const;
export const USDC_USD_PRICE_ID =
  "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a" as const;
export const CIRCLE_TESTNET_USDC_TOKEN_ID = "0.0.429274" as const;
export const CIRCLE_TESTNET_USDC_ADDRESS =
  "0x0000000000000000000000000000000000068cda" as const;
export const CIRCLE_TESTNET_USDC_DECIMALS = 6;
export const DEFAULT_PARTITION = `0x${"0".repeat(63)}1` as const;
export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

export function tinybarToWeibar(value: bigint): bigint {
  if (value < 0n) throw new RangeError("Tinybar value cannot be negative.");
  return value * WEIBAR_PER_TINYBAR;
}

export function weibarToTinybar(value: bigint): bigint {
  if (value < 0n) throw new RangeError("Weibar value cannot be negative.");
  if (value % WEIBAR_PER_TINYBAR !== 0n) {
    throw new RangeError("Weibar value is not an exact tinybar amount.");
  }
  return value / WEIBAR_PER_TINYBAR;
}
