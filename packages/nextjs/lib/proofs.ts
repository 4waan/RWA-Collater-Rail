import type {
  ScheduleProof,
  StateProof,
  TransactionProof,
} from "@collateral-rail/shared/evidence";

export type ReferenceProof = TransactionProof | ScheduleProof | StateProof;

const TRANSACTION_HASH = /^0x[a-fA-F0-9]{64}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEDERA_ID = /^0\.0\.\d+$/;
const CONSENSUS_TIMESTAMP = /^\d+\.\d+$/;
const BLOCK_NUMBER = /^\d+$/;
const ALLOWED_STATE_ORIGINS = new Set(["https://testnet.hashio.io"]);
const MIRROR_ORIGIN = "https://testnet.mirrornode.hedera.com";

export function safeHashScanLink(
  value: string | null | undefined,
  kind?: "schedule" | "transaction",
) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== "https://hashscan.io" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const transactionPath = /^\/testnet\/transaction\/[^/]+$/;
    const schedulePath = /^\/testnet\/schedule\/[^/]+$/;
    if (kind === "transaction" && !transactionPath.test(parsed.pathname)) {
      return undefined;
    }
    if (kind === "schedule" && !schedulePath.test(parsed.pathname)) {
      return undefined;
    }
    if (
      !kind &&
      !transactionPath.test(parsed.pathname) &&
      !schedulePath.test(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function hashScanTransaction(hash: string | null | undefined) {
  return hash && TRANSACTION_HASH.test(hash)
    ? `https://hashscan.io/testnet/transaction/${hash}`
    : undefined;
}

export function safeMirrorLink(
  value: string | null | undefined,
  kind?: "contract" | "schedule" | "transaction",
) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== MIRROR_ORIGIN ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const transactionPath =
      /^\/api\/v1\/contracts\/results\/0x[a-fA-F0-9]{64}$/;
    const schedulePath = /^\/api\/v1\/schedules\/0\.0\.\d+$/;
    const contractPath = /^\/api\/v1\/contracts\/0x[a-fA-F0-9]{40}$/;
    const expected =
      kind === "transaction"
        ? transactionPath
        : kind === "schedule"
          ? schedulePath
          : kind === "contract"
            ? contractPath
            : null;
    if (expected && !expected.test(parsed.pathname)) return undefined;
    if (
      !expected &&
      !transactionPath.test(parsed.pathname) &&
      !schedulePath.test(parsed.pathname) &&
      !contractPath.test(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function mirrorTransaction(hash: string | null | undefined) {
  return hash && TRANSACTION_HASH.test(hash)
    ? `${MIRROR_ORIGIN}/api/v1/contracts/results/${hash}`
    : undefined;
}

export function mirrorSchedule(scheduleId: string | null | undefined) {
  return scheduleId && HEDERA_ID.test(scheduleId)
    ? `${MIRROR_ORIGIN}/api/v1/schedules/${scheduleId}`
    : undefined;
}

function scheduleIdForAddress(address: string) {
  const normalized = address.slice(2).toLowerCase();
  if (!/^0{24}[a-f0-9]{16}$/.test(normalized)) return undefined;
  return `0.0.${BigInt(`0x${normalized.slice(24)}`).toString()}`;
}

export function isTransactionProof(
  proof: ReferenceProof | null | undefined,
): proof is TransactionProof {
  return Boolean(
    proof &&
      proof.type === "transaction" &&
      proof.kind.trim().length > 0 &&
      proof.kind.length <= 80 &&
      TRANSACTION_HASH.test(proof.hash) &&
      CONSENSUS_TIMESTAMP.test(proof.consensusTimestamp) &&
      proof.result === "SUCCESS" &&
      safeMirrorLink(proof.mirror, "transaction") ===
        mirrorTransaction(proof.hash) &&
      safeHashScanLink(proof.hashScan, "transaction") ===
        hashScanTransaction(proof.hash),
  );
}

export function isScheduleProof(
  proof: ReferenceProof | null | undefined,
): proof is ScheduleProof {
  return Boolean(
    proof &&
      proof.type === "schedule" &&
      EVM_ADDRESS.test(proof.address) &&
      HEDERA_ID.test(proof.scheduleId) &&
      scheduleIdForAddress(proof.address) === proof.scheduleId &&
      (proof.executedTimestamp === null ||
        CONSENSUS_TIMESTAMP.test(proof.executedTimestamp)) &&
      safeMirrorLink(proof.mirror, "schedule") ===
        mirrorSchedule(proof.scheduleId) &&
      safeHashScanLink(proof.hashScan, "schedule") ===
        `https://hashscan.io/testnet/schedule/${proof.scheduleId}`,
  );
}

export function isStateProof(
  proof: ReferenceProof | null | undefined,
): proof is StateProof {
  let origin: string;
  if (
    !proof ||
    proof.type !== "state" ||
    !BLOCK_NUMBER.test(proof.blockNumber)
  ) {
    return false;
  }
  try {
    origin = new URL(proof.rpcOrigin).origin;
  } catch {
    return false;
  }
  const assertionsValid =
    typeof proof.assertions === "object" &&
    proof.assertions !== null &&
    !Array.isArray(proof.assertions) &&
    Object.keys(proof.assertions).length > 0 &&
    Object.keys(proof.assertions).length <= 100 &&
    Object.entries(proof.assertions).every(
      ([key, value]) =>
        key.length > 0 &&
        key.length <= 120 &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"),
    );
  return (
    origin === proof.rpcOrigin &&
    ALLOWED_STATE_ORIGINS.has(origin) &&
    assertionsValid
  );
}
