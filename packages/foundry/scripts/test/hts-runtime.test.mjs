import assert from "node:assert/strict";
import test from "node:test";
import { HtsEvidenceJournal } from "../lib/hts-proof-runtime.mjs";
import { htsOutputPath, selectedHtsProfile } from "../lib/hts-demo-runtime.ts";

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
