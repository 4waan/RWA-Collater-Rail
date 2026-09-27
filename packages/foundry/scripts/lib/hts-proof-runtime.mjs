import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_MIRROR_URL,
  fetchAllowedJson,
  fetchMirrorPages,
} from "./evidence-lib.mjs";

const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const TRANSACTION_ID_RE = /^0\.0\.\d+@\d+\.\d{9}$/;

function mirrorEvm(hash, mirrorOrigin = DEFAULT_MIRROR_URL) {
  return `${mirrorOrigin}/api/v1/contracts/results/${hash}`;
}

function hashScanEvm(hash) {
  return `https://hashscan.io/testnet/transaction/${hash}`;
}

function mirrorNative(transactionId, mirrorOrigin = DEFAULT_MIRROR_URL) {
  return `${mirrorOrigin}/api/v1/transactions/${encodeURIComponent(transactionId)}`;
}

function hashScanNative(transactionId) {
  return `https://hashscan.io/testnet/transaction/${transactionId}`;
}

export class HtsEvidenceJournal {
  #proofs = new Map();

  add(proof) {
    const key =
      proof.type === "transaction"
        ? `evm:${proof.hash.toLowerCase()}`
        : `native:${proof.transactionId}`;
    const existing = this.#proofs.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(proof)) {
      throw new Error(`Conflicting HTS evidence proof ${key}.`);
    }
    this.#proofs.set(key, proof);
    return proof;
  }

  values() {
    return [...this.#proofs.values()];
  }
}

export async function waitForNativeProof({
  response,
  client,
  kind,
  mirrorOrigin = DEFAULT_MIRROR_URL,
  timeoutMs = 120_000,
}) {
  const receipt = await response.getReceipt(client);
  if (receipt.status?.toString() !== "SUCCESS") {
    throw new Error(`${kind} did not reach SUCCESS consensus.`);
  }
  const transactionId = response.transactionId?.toString();
  if (!TRANSACTION_ID_RE.test(transactionId ?? "")) {
    throw new Error(`${kind} returned an invalid transaction ID.`);
  }
  const transactionHash = `0x${Buffer.from(response.transactionHash).toString("hex")}`;
  if (!/^0x[a-fA-F0-9]{96}$/.test(transactionHash)) {
    throw new Error(`${kind} returned an invalid SHA-384 transaction hash.`);
  }
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const transactions = await fetchMirrorPages({
        mirrorOrigin,
        pathname: `/api/v1/transactions/${encodeURIComponent(transactionId)}`,
        collectionKey: "transactions",
      });
      const matches = transactions.filter(
        (transaction) =>
          Number(transaction?.nonce ?? 0) === 0 &&
          transaction?.result === "SUCCESS",
      );
      if (matches.length !== 1) {
        throw new Error(
          `Mirror returned ${matches.length} native base records.`,
        );
      }
      const consensusTimestamp = matches[0].consensus_timestamp;
      if (!/^\d+\.\d{1,9}$/.test(consensusTimestamp ?? "")) {
        throw new Error("Mirror omitted the native consensus timestamp.");
      }
      return {
        proof: {
          type: "hedera-transaction",
          kind,
          transactionId,
          transactionHash,
          consensusTimestamp,
          result: "SUCCESS",
          mirror: mirrorNative(transactionId, mirrorOrigin),
          hashScan: hashScanNative(transactionId),
        },
        transaction: matches[0],
        receipt,
      };
    } catch (error) {
      lastError = error;
      await delay(2_000);
    }
  }
  throw new Error(
    `Mirror did not confirm ${kind}: ${lastError instanceof Error ? lastError.message : "timeout"}`,
  );
}

export async function waitForEvmProof({
  hash,
  kind,
  mirrorOrigin = DEFAULT_MIRROR_URL,
  expectSuccess,
  timeoutMs = 120_000,
}) {
  if (!HASH_RE.test(hash)) throw new Error(`${kind} returned an invalid hash.`);
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const contractResult = await fetchAllowedJson(
        new URL(
          `/api/v1/contracts/results/${encodeURIComponent(hash)}`,
          mirrorOrigin,
        ),
        new URL(mirrorOrigin).origin,
      );
      if (
        String(contractResult.hash ?? "").toLowerCase() !== hash.toLowerCase()
      ) {
        throw new Error("Mirror returned a different contract result.");
      }
      const succeeded =
        contractResult.status === "0x1" &&
        contractResult.error_message === null;
      if (succeeded !== expectSuccess) {
        throw new Error(
          "Mirror contract status disagrees with the expected result.",
        );
      }
      const transactions = await fetchMirrorPages({
        mirrorOrigin,
        pathname: `/api/v1/transactions/${encodeURIComponent(hash)}`,
        collectionKey: "transactions",
      });
      const matches = transactions.filter(
        (transaction) =>
          Number(transaction?.nonce ?? 0) === 0 &&
          transaction?.consensus_timestamp === contractResult.timestamp,
      );
      if (matches.length !== 1) {
        throw new Error(`Mirror returned ${matches.length} EVM base records.`);
      }
      const result = matches[0].result;
      if (
        typeof result !== "string" ||
        (expectSuccess && result !== "SUCCESS") ||
        (!expectSuccess && result === "SUCCESS")
      ) {
        throw new Error("Mirror returned an unexpected Hedera result.");
      }
      return {
        proof: {
          type: "transaction",
          kind,
          hash,
          consensusTimestamp: contractResult.timestamp,
          result,
          mirror: mirrorEvm(hash, mirrorOrigin),
          hashScan: hashScanEvm(hash),
        },
        transaction: matches[0],
      };
    } catch (error) {
      lastError = error;
      await delay(2_000);
    }
  }
  throw new Error(
    `Mirror did not confirm ${kind}: ${lastError instanceof Error ? lastError.message : "timeout"}`,
  );
}
