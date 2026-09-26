import { defineChain, type Address } from "viem";
import {
  HEDERA_TESTNET_CHAIN_ID,
  HEDERA_TESTNET_RPC_URL,
  PYTH_ADDRESS,
} from "@collateral-rail/shared/hedera";

const ALLOWED_RPC_HOSTS = new Set(["testnet.hashio.io"]);

function safeRpcUrl(value: string | undefined): string {
  if (!value) return HEDERA_TESTNET_RPC_URL;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && ALLOWED_RPC_HOSTS.has(parsed.hostname))
      return parsed.toString();
  } catch {}
  return HEDERA_TESTNET_RPC_URL;
}

export const rpcUrl = safeRpcUrl(process.env.NEXT_PUBLIC_HEDERA_RPC_URL);

export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET_CHAIN_ID,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
});

function publicAddress(value: string | undefined): Address | undefined {
  return value && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? (value as Address)
    : undefined;
}

export type OracleKind = "hedera-exchange-rate" | "pyth";

const configuredOracleKind = process.env.NEXT_PUBLIC_ORACLE_KIND?.trim();
const isOracleConfigurationValid =
  !configuredOracleKind ||
  configuredOracleKind === "hedera-exchange-rate" ||
  configuredOracleKind === "pyth";
export const oracleKind: OracleKind =
  configuredOracleKind === "pyth" ? "pyth" : "hedera-exchange-rate";

export const addresses = {
  rail: publicAddress(process.env.NEXT_PUBLIC_RAIL_ADDRESS),
  atsToken: publicAddress(process.env.NEXT_PUBLIC_ATS_TOKEN_ADDRESS),
  oracle: publicAddress(process.env.NEXT_PUBLIC_ORACLE_ADDRESS),
  pyth: PYTH_ADDRESS as Address,
};

export const isLiveMode = Boolean(
  isOracleConfigurationValid &&
    addresses.rail &&
    addresses.atsToken &&
    addresses.oracle,
);

export { HEDERA_TESTNET_CHAIN_ID };
