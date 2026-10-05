import assert from "node:assert/strict";
import test from "node:test";
import { validateClprEvidenceRecord } from "../lib/clpr-evidence-lib.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const bytes32 = (digit) => `0x${digit.repeat(64)}`;

function message(observation, direction, kind, index, mobilityId) {
  return {
    observation,
    direction,
    channelId: bytes32("a"),
    sourceService: address("1"),
    destinationService: address("2"),
    sourceApplication: address("3"),
    destinationApplication: address("4"),
    mobilityId,
    messageKind: kind,
    messageId: String(index),
    bundleHash: `0x${index.toString(16).padStart(64, "0")}`,
    proofVerifier: address("5"),
    sourceBlock: String(100 + index),
    destinationBlock: String(200 + index),
    observedAt: "2026-09-29T00:00:00.000Z",
  };
}

function validRecord() {
  const repayment = bytes32("b");
  const fallback = bytes32("c");
  return {
    schemaVersion: 1,
    evidenceKind: "clpr-collateral-mobility",
    status: "verified-experimental",
    generatedAt: "2026-09-29T00:00:00.000Z",
    upstream: {
      specificationCommit: "945082d69e65dd0fd9e9bdf8d59cb8121579f6fd",
      contractsCommit: "276c8d524e6ce3b5ef01da9d68ce3e8f27798a44",
      endpointCommit: "2ccd48d2d5d0d2f15d0829b1a057f27d88fd085e",
    },
    observations: ["observed-local-besu", "observed-besu-to-solo"],
    ledgers: [
      {
        domain: "eip155:1337",
        kind: "besu",
        chainId: "1337",
        clprService: address("1"),
        application: address("3"),
      },
      {
        domain: "hedera:solo",
        kind: "hedera-solo",
        chainId: "298",
        clprService: address("2"),
        application: address("4"),
      },
    ],
    messages: [
      message("observed-local-besu", "A-to-B", "OFFER_FUNDED", 1, repayment),
      message(
        "observed-local-besu",
        "B-to-A",
        "COLLATERAL_LOCKED",
        2,
        repayment,
      ),
      message(
        "observed-local-besu",
        "A-to-B",
        "PRINCIPAL_WITHDRAWN",
        3,
        repayment,
      ),
      message(
        "observed-local-besu",
        "A-to-B",
        "REPAYMENT_ESCROWED",
        4,
        repayment,
      ),
      message(
        "observed-local-besu",
        "B-to-A",
        "REPAYMENT_ACCEPTED",
        5,
        repayment,
      ),
      message(
        "observed-local-besu",
        "B-to-A",
        "DEFAULT_CONFIRMED",
        6,
        fallback,
      ),
      message(
        "observed-besu-to-solo",
        "besu-to-solo",
        "OFFER_FUNDED",
        7,
        fallback,
      ),
      message(
        "observed-besu-to-solo",
        "besu-to-solo",
        "PRINCIPAL_WITHDRAWN",
        8,
        fallback,
      ),
    ],
    lifecycle: {
      repaymentMobilityId: repayment,
      defaultMobilityId: fallback,
      repaymentTerminalState: "REPAID",
      defaultTerminalState: "DEFAULTED",
    },
    accounting: {
      remoteTokenBalance: "50500000000",
      remoteCashLiabilities: "50500000000",
      hederaHbarBalanceTinybar: "500000000",
      reservedAutomationTinybar: "0",
    },
    exactState: [
      {
        type: "state",
        blockNumber: "100",
        rpcOrigin: "http://127.0.0.1:18545",
        assertions: { repayment: "REPAID" },
      },
      {
        type: "state",
        blockNumber: "200",
        rpcOrigin: "http://127.0.0.1:18546",
        assertions: { fallback: "DEFAULTED" },
      },
    ],
    sourceUrls: {
      specification: "https://github.com/LFDT-CLPR/clpr-spec",
      contracts: "https://github.com/LFDT-CLPR/clpr-smart-contracts",
      endpoint: "https://github.com/LFDT-CLPR/clpr-endpoint",
    },
    notDemonstrated: ["solo-to-besu"],
    limitations: [
      "The public Solo ProofService does not support the reverse path.",
    ],
    notice:
      "Observed in controlled local networks. This is experimental evidence.",
  };
}

test("validates distinct observed CLPR directions and terminal paths", async () => {
  assert.equal(await validateClprEvidenceRecord(validRecord()), true);
});

test("rejects an unsupported direction presented as observed", async () => {
  const record = validRecord();
  record.observations.push("observed-solo-to-besu");
  await assert.rejects(
    () => validateClprEvidenceRecord(record),
    /unknown observation/u,
  );
});

test("rejects insolvent CLPR accounting", async () => {
  const record = validRecord();
  record.accounting.remoteTokenBalance = "1";
  await assert.rejects(() => validateClprEvidenceRecord(record), /insolvent/u);
});

test("rejects secret-shaped CLPR evidence fields", async () => {
  const record = validRecord();
  record.operatorPrivateKey = "forbidden";
  await assert.rejects(
    () => validateClprEvidenceRecord(record),
    /forbidden field/u,
  );
});
