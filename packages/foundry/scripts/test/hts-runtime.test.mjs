import assert from "node:assert/strict";
import test from "node:test";
import { HtsEvidenceJournal } from "../lib/hts-proof-runtime.mjs";
import {
  assertCircleUsdcPreflight,
  bestEffortSweepTokenBalance,
  htsFoundryEnvironment,
  htsOutputPath,
  selectedHtsProfile,
  writeHtsEvidenceCandidateAtomic,
} from "../lib/hts-demo-runtime.ts";

const evmProof = {
  type: "transaction",
  kind: "fund-offer-1",
  hash: `0x${"1".repeat(64)}`,
  consensusTimestamp: "1700000000.000000001",
  result: "SUCCESS",
  mirror: "https://example.invalid/evm",
  hashScan: "https://example.invalid/explorer",
};

const nativeProof = {
  type: "hedera-transaction",
  kind: "associate-lender",
  transactionId: "0.0.123@1700000000.000000001",
  transactionHash: `0x${"2".repeat(96)}`,
  consensusTimestamp: "1700000000.000000002",
  result: "SUCCESS",
  mirror: "https://example.invalid/native",
  hashScan: "https://example.invalid/explorer",
};

test("HTS profile selection accepts only explicit profiles", () => {
  assert.equal(selectedHtsProfile(["--profile=controlled"]), "controlled");
  assert.equal(selectedHtsProfile(["--profile", "usdc"]), "usdc");
  assert.throws(() => selectedHtsProfile([]), /controlled or usdc/);
  assert.throws(
    () => selectedHtsProfile(["--profile=mainnet"]),
    /controlled or usdc/,
  );
});

test("HTS candidate paths remain profile-specific and private", () => {
  assert.match(
    htsOutputPath("controlled"),
    /deployments\/testnet-hts-controlled\.json$/,
  );
  assert.match(htsOutputPath("usdc"), /deployments\/testnet-hts-usdc\.json$/);
});

test("HTS Foundry receives only allowlisted ambient and configured values", () => {
  const environment = htsFoundryEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/tmp/test-home",
      PYTH_API_KEY: "must-not-reach-forge",
      UNRELATED_SECRET: "must-not-reach-forge",
    },
    {
      HARNESS_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      HEDERA_TESTNET_RPC_URL: "https://testnet.hashio.io/api",
      SETTLEMENT_TOKEN_ADDRESS: `0x${"2".repeat(40)}`,
    },
  );
  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/test-home",
    HARNESS_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    HEDERA_TESTNET_RPC_URL: "https://testnet.hashio.io/api",
    SETTLEMENT_TOKEN_ADDRESS: `0x${"2".repeat(40)}`,
  });
  assert.equal(environment.PYTH_API_KEY, undefined);
  assert.equal(environment.UNRELATED_SECRET, undefined);
  assert.throws(
    () => htsFoundryEnvironment({}, { UNEXPECTED_VALUE: "rejected" }),
    /Unexpected HTS Foundry environment key/,
  );
});

test("atomic HTS candidate writes reject every noncanonical path", async () => {
  await assert.rejects(
    writeHtsEvidenceCandidateAtomic(
      "/tmp/testnet-hts-controlled.json",
      "controlled",
      "{}\n",
    ),
    /ignored candidate path/,
  );
  await assert.rejects(
    writeHtsEvidenceCandidateAtomic(
      htsOutputPath("controlled"),
      "usdc",
      "{}\n",
    ),
    /ignored candidate path/,
  );
});

test("best-effort token cleanup sweeps positive balances without key material", async () => {
  const swept = [];
  const result = await bestEffortSweepTokenBalance({
    accountId: "0.0.123",
    readBalance: async () => 42n,
    sweep: async (amount) => swept.push(amount),
  });
  assert.deepEqual(swept, [42n]);
  assert.deepEqual(result, {
    accountId: "0.0.123",
    amountTokenUnits: "42",
    swept: true,
  });
  assert.equal("privateKey" in result, false);
});

test("best-effort token cleanup reports failure without throwing", async () => {
  const result = await bestEffortSweepTokenBalance({
    accountId: "0.0.456",
    readBalance: async () => {
      throw new Error("network failure with internal details");
    },
    sweep: async () => {
      throw new Error("not reached");
    },
  });
  assert.deepEqual(result, {
    accountId: "0.0.456",
    amountTokenUnits: null,
    swept: false,
  });
});

function circleMetadata(overrides = {}) {
  return {
    token_id: "0.0.429274",
    name: "USD Coin",
    symbol: "USDC",
    type: "FUNGIBLE_COMMON",
    decimals: "6",
    deleted: false,
    freeze_default: false,
    freeze_key: { _type: "ED25519", key: "public-key" },
    kyc_key: null,
    pause_key: null,
    pause_status: "NOT_APPLICABLE",
    fee_schedule_key: null,
    custom_fees: { fixed_fees: [], fractional_fees: [] },
    ...overrides,
  };
}

function operatorRelationship(overrides = {}) {
  return {
    tokens: [
      {
        token_id: "0.0.429274",
        balance: 18_000_000,
        kyc_status: "NOT_APPLICABLE",
        freeze_status: "UNFROZEN",
        ...overrides,
      },
    ],
  };
}

test("Circle preflight pins token controls and operator readiness", () => {
  assert.doesNotThrow(() =>
    assertCircleUsdcPreflight(circleMetadata(), operatorRelationship()),
  );
  for (const metadata of [
    circleMetadata({ symbol: "FAKE" }),
    circleMetadata({ pause_status: "PAUSED" }),
    circleMetadata({ fee_schedule_key: { key: "mutable-fees" } }),
    circleMetadata({ custom_fees: { fixed_fees: [{}], fractional_fees: [] } }),
  ]) {
    assert.throws(
      () => assertCircleUsdcPreflight(metadata, operatorRelationship()),
      /metadata failed preflight/,
    );
  }
  assert.throws(
    () =>
      assertCircleUsdcPreflight(
        circleMetadata(),
        operatorRelationship({ freeze_status: "FROZEN" }),
      ),
    /relationship failed preflight/,
  );
  assert.throws(
    () =>
      assertCircleUsdcPreflight(
        circleMetadata(),
        operatorRelationship({ balance: 17_999_999 }),
      ),
    /at least 18 Circle testnet USDC/,
  );
});

test("HTS evidence journal deduplicates identical typed proofs", () => {
  const journal = new HtsEvidenceJournal();
  journal.add(evmProof);
  journal.add(structuredClone(evmProof));
  journal.add(nativeProof);
  assert.deepEqual(journal.values(), [evmProof, nativeProof]);
});

test("HTS evidence journal rejects conflicting proof identities", () => {
  const journal = new HtsEvidenceJournal();
  journal.add(evmProof);
  assert.throws(
    () => journal.add({ ...evmProof, result: "CONTRACT_REVERT_EXECUTED" }),
    /Conflicting HTS evidence proof/,
  );
  journal.add(nativeProof);
  assert.throws(
    () => journal.add({ ...nativeProof, kind: "associate-borrower" }),
    /Conflicting HTS evidence proof/,
  );
});
