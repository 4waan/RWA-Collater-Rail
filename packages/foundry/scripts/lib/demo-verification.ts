import { atsAbi, oracleAbi, railAbi } from "@collateral-rail/shared/abis";
import { DEFAULT_PARTITION } from "@collateral-rail/shared/hedera";
import type { RailPolicy } from "@collateral-rail/shared/recipes";
import type { Address, PublicClient } from "viem";
import { ROLE_ISSUER, ROLE_KYC, ROLE_SSI_MANAGER } from "./demo-runtime.ts";

type VerificationOptions = {
  publicClient: PublicClient;
  atsToken: Address;
  oracle: Address;
  rail: Address;
  issuer: Address;
  lender: Address;
  borrower: Address;
  expectedPolicy: RailPolicy;
  blockNumber: bigint;
};

export async function readVerifiedFinalState({
  publicClient,
  atsToken,
  oracle,
  rail,
  issuer,
  lender,
  borrower,
  expectedPolicy,
  blockNumber,
}: VerificationOptions) {
  const [
    internalKyc,
    isIssuer,
    lenderKyc,
    borrowerKyc,
    assetMaturity,
    clearingActive,
    tokenDecimals,
    nominalValue,
    nominalValueDecimals,
    nominalValueCurrency,
    issuerRole,
    kycRole,
    ssiRole,
    borrowerFree,
    borrowerHeld,
    lenderFree,
    lenderHeld,
    cashLiabilities,
    reservedAutomation,
    requiredBacking,
    deployedPolicy,
    oraclePrice,
  ] = await Promise.all([
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isInternalKycActivated",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isIssuer",
      args: [issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getMaturityDate",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isClearingActivated",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "decimals",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValue",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValueDecimals",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValueCurrency",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_ISSUER, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_KYC, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_SSI_MANAGER, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "balanceOfByPartition",
      args: [DEFAULT_PARTITION, borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getHeldAmountForByPartition",
      args: [DEFAULT_PARTITION, borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "balanceOfByPartition",
      args: [DEFAULT_PARTITION, lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getHeldAmountForByPartition",
      args: [DEFAULT_PARTITION, lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: railAbi,
      functionName: "cashLiabilities",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: railAbi,
      functionName: "reservedAutomation",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: railAbi,
      functionName: "requiredBacking",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: railAbi,
      functionName: "policy",
      blockNumber,
    }),
    publicClient.readContract({
      address: oracle,
      abi: oracleAbi,
      functionName: "latestHbarUsd",
      blockNumber,
    }),
  ]);

  if (!internalKyc || !isIssuer || !issuerRole || !kycRole || !ssiRole) {
    throw new Error("Final ATS issuer, KYC, or role verification failed.");
  }
  if (lenderKyc !== 1 || borrowerKyc !== 1) {
    throw new Error("Final ATS counterparty KYC verification failed.");
  }
  if (
    clearingActive ||
    tokenDecimals !== 0 ||
    nominalValue !== 10_000n ||
    nominalValueDecimals !== 2 ||
    nominalValueCurrency.toLowerCase() !== "0x555344"
  ) {
    throw new Error("Final ATS asset configuration verification failed.");
  }
  if (oraclePrice[0] <= 0n || oraclePrice[2] <= 0n) {
    throw new Error("Final HBAR settlement conversion verification failed.");
  }

  const policy = {
    maximumAdvanceBps: Number(deployedPolicy.maximumAdvanceBps),
    maximumAnnualRateBps: Number(deployedPolicy.maximumAnnualRateBps),
    maximumQuoteMovementBps: Number(deployedPolicy.maximumQuoteMovementBps),
    minimumTermSeconds: Number(deployedPolicy.minimumTermSeconds),
    maximumTermSeconds: Number(deployedPolicy.maximumTermSeconds),
    maximumOfferLifetimeSeconds: Number(
      deployedPolicy.maximumOfferLifetimeSeconds,
    ),
  };
  if (JSON.stringify(policy) !== JSON.stringify(expectedPolicy)) {
    throw new Error("Deployed rail policy does not match the selected recipe.");
  }

  return {
    internalKyc,
    issuer: isIssuer,
    lenderKyc,
    borrowerKyc,
    assetMaturity,
    clearingActive,
    tokenDecimals,
    nominalValue,
    nominalValueDecimals,
    nominalValueCurrency,
    issuerRole,
    kycRole,
    ssiRole,
    borrowerFree,
    borrowerHeld,
    lenderFree,
    lenderHeld,
    cashLiabilities,
    reservedAutomation,
    requiredBacking,
    policy,
    oraclePriceUsdE8: oraclePrice[0],
    oracleConfidenceUsdE8: oraclePrice[1],
    oraclePublishTime: oraclePrice[2],
  };
}
