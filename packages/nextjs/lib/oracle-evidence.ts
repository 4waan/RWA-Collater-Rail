import { formatUnits } from "viem";
import type {
  ReferenceDeployment,
  StateProof,
  TransactionProof,
} from "@collateral-rail/shared/evidence";

type OracleProof = TransactionProof | StateProof | null;

export type OracleEvidencePresentation = {
  kind: "hedera-exchange-rate" | "pyth" | "pending";
  label: string;
  claim: string;
  source: string;
  value: string;
  detail: string;
  caveat: string;
  proof: OracleProof;
};

function price(value: string) {
  return `$${formatUnits(BigInt(value), 8)} per HBAR`;
}

export function presentOracleEvidence(
  deployment: ReferenceDeployment,
): OracleEvidencePresentation {
  const oracle = deployment.oracle;
  if (!oracle) {
    return {
      kind: "pending",
      label: "Settlement conversion source",
      claim: "The HBAR settlement conversion source is not yet verified.",
      source: "No oracle proof published",
      value: "Pending",
      detail: "Awaiting verified publication",
      caveat: "No settlement conversion claim is made without typed evidence.",
      proof: null,
    };
  }

  if (oracle.kind === "pyth") {
    return {
      kind: "pyth",
      label: "Pyth HBAR/USD cash quote",
      claim: "A fresh Pyth HBAR/USD cash quote was submitted.",
      source: "Pyth adapter and Mirror-confirmed transaction",
      value: price(oracle.priceUsdE8),
      detail: `${price(oracle.priceUsdE8)}, published at ${oracle.observedAt}`,
      caveat:
        "Pyth converts the HBAR cash leg only. It does not value the ATS security.",
      proof: deployment.lifecycle.pythPriceUpdate,
    };
  }

  const blockNumber = deployment.verification.state?.blockNumber;
  return {
    kind: "hedera-exchange-rate",
    label: "HIP-475 settlement conversion rate",
    claim: "The HBAR settlement conversion rate was read from Hedera.",
    source: `HIP-475 system contract ${oracle.systemContract}, system file ${oracle.systemFile}, and block state`,
    value: price(oracle.priceUsdE8),
    detail: blockNumber
      ? `${price(oracle.priceUsdE8)}, observed at block ${blockNumber}`
      : `${price(oracle.priceUsdE8)}, state proof pending`,
    caveat: oracle.caveat,
    proof: deployment.verification.state,
  };
}
