import assert from "node:assert/strict";
import test from "node:test";
import type { ReferenceDeployment } from "@collateral-rail/shared/evidence";
import { presentOracleEvidence } from "./oracle-evidence";

const stateProof = {
  type: "state" as const,
  blockNumber: "41012411",
  rpcOrigin: "https://testnet.hashio.io",
  assertions: {},
};

const transactionProof = {
  type: "transaction" as const,
  kind: "pyth-price-refresh",
  hash: `0x${"1".repeat(64)}`,
  consensusTimestamp: "1.000000001",
  result: "SUCCESS",
  hashScan: `https://hashscan.io/testnet/transaction/0x${"1".repeat(64)}`,
};

function deployment(
  oracle: ReferenceDeployment["oracle"],
): ReferenceDeployment {
  return {
    oracle,
    pyth: null,
    lifecycle: {
      atsBondDeployment: null,
      ssiAndKycConfiguration: null,
      collateralIssuance: null,
      pythPriceUpdate: null,
      fundedOffer: null,
      holdCreation: null,
      hssScheduleCreation: null,
      repaidFacility: null,
      maturedDefault: null,
      liveConfigurationRead: stateProof,
    },
    verification: {
      complete: true,
      state: stateProof,
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      contractLinks: {},
    },
  } as ReferenceDeployment;
}

test("HIP-475 presentation uses block state and carries the network-rate caveat", () => {
  const record = deployment({
    kind: "hedera-exchange-rate",
    systemContract: "0x0000000000000000000000000000000000000168",
    systemFile: "0.0.112",
    priceUsdE8: "7802800",
    confidenceUsdE8: "0",
    observedAt: 1_790_433_046,
    purpose: "HBAR cash-leg settlement conversion only",
    caveat:
      "HIP-475 exposes the active network settlement conversion rate, not a live market price oracle.",
  });

  const presentation = presentOracleEvidence(record);
  assert.equal(presentation.kind, "hedera-exchange-rate");
  assert.equal(presentation.proof, stateProof);
  assert.match(presentation.detail, /block 41012411/);
  assert.match(presentation.caveat, /not a live market price oracle/);
  assert.doesNotMatch(presentation.source, /Pyth/);
});

test("Pyth presentation requires and cites its transaction proof", () => {
  const feedId = `0x${"2".repeat(64)}`;
  const record = deployment({
    kind: "pyth",
    feedId,
    priceUsdE8: "7802800",
    confidenceUsdE8: "1000",
    observedAt: 1_790_433_046,
    purpose: "HBAR cash-leg conversion only",
  });
  record.pyth = {
    feedId,
    priceUsdE8: "7802800",
    confidenceUsdE8: "1000",
    publishTime: 1_790_433_046,
    purpose: "HBAR cash-leg conversion only",
  };
  record.lifecycle.pythPriceUpdate = transactionProof;

  const presentation = presentOracleEvidence(record);
  assert.equal(presentation.kind, "pyth");
  assert.equal(presentation.proof, transactionProof);
  assert.match(presentation.source, /Pyth adapter/);
  assert.match(presentation.caveat, /does not value the ATS security/);
});
