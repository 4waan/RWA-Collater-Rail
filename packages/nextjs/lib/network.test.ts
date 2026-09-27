import assert from "node:assert/strict";
import test from "node:test";
import {
  isMirrorTransactionIdentifier,
  readJson,
  RemoteReadError,
} from "./network";
import {
  tinybarToWeibar,
  WEIBAR_PER_TINYBAR,
  weibarToTinybar,
} from "@collateral-rail/shared/hedera";
import {
  isScheduleProof,
  isStateProof,
  isTransactionProof,
  mirrorSchedule,
  mirrorTransaction,
  safeMirrorLink,
} from "./proofs";

const request = {
  origin: "https://testnet.mirrornode.hedera.com",
  pathPrefix: "/api/v1/transactions/",
  maxBytes: 64,
  timeoutMs: 20,
};

function response(
  text: string,
  options: {
    contentLength?: number;
    contentType?: string;
    redirected?: boolean;
    status?: number;
    url?: string;
  } = {},
) {
  const status = options.status ?? 200;
  return {
    body: null,
    headers: new Headers({
      "content-length": String(
        options.contentLength ?? new TextEncoder().encode(text).byteLength,
      ),
      "content-type": options.contentType ?? "application/json",
    }),
    ok: status >= 200 && status < 300,
    redirected: options.redirected ?? false,
    status,
    text: async () => text,
    url:
      options.url ??
      "https://testnet.mirrornode.hedera.com/api/v1/transactions/0xabc",
  } as unknown as Response;
}

function expectFailure(failure: RemoteReadError["failure"]) {
  return (error: unknown) =>
    error instanceof RemoteReadError && error.failure === failure;
}

test("Hedera JSON RPC values convert at the exact weibar boundary", () => {
  const tinybarValues = [0n, 1n, 123n, 100_000_000n, 2n ** 128n];
  for (const tinybar of tinybarValues) {
    const weibar = tinybarToWeibar(tinybar);
    assert.equal(weibar, tinybar * WEIBAR_PER_TINYBAR);
    assert.equal(weibarToTinybar(weibar), tinybar);
  }
  assert.throws(() => tinybarToWeibar(-1n), /negative/);
  assert.throws(() => weibarToTinybar(-1n), /negative/);
  assert.throws(() => weibarToTinybar(WEIBAR_PER_TINYBAR - 1n), /exact/);
});

test("bounded reads reject endpoint escape and redirects", async () => {
  await assert.rejects(
    readJson(
      "https://attacker.invalid/api/v1/transactions/0xabc",
      request,
      (async () => response("{}")) as typeof fetch,
    ),
    expectFailure("url"),
  );

  await assert.rejects(
    readJson(
      "https://testnet.mirrornode.hedera.com/api/v1/transactions/0xabc",
      request,
      (async () =>
        response("{}", {
          redirected: true,
          url: "https://testnet.mirrornode.hedera.com/api/v1/transactions/redirected",
        })) as typeof fetch,
    ),
    expectFailure("redirect"),
  );
});

test("bounded reads reject excessive and malformed responses", async () => {
  const url = "https://testnet.mirrornode.hedera.com/api/v1/transactions/0xabc";
  await assert.rejects(
    readJson(url, request, (async () =>
      response("{}", { contentLength: 65 })) as typeof fetch),
    expectFailure("size"),
  );
  await assert.rejects(
    readJson(url, request, (async () => response("not json")) as typeof fetch),
    expectFailure("malformed"),
  );
  await assert.rejects(
    readJson(url, request, (async () =>
      response("", { contentLength: 0 })) as typeof fetch),
    expectFailure("empty"),
  );
});

test("bounded reads expose a distinct timeout state", async () => {
  const fetchImpl = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    })) as typeof fetch;
  await assert.rejects(
    readJson(
      "https://testnet.mirrornode.hedera.com/api/v1/transactions/0xabc",
      { ...request, timeoutMs: 1 },
      fetchImpl,
    ),
    expectFailure("timeout"),
  );
});

test("Mirror transaction identifiers reject path and query injection", () => {
  assert.equal(isMirrorTransactionIdentifier(`0x${"a".repeat(64)}`), true);
  assert.equal(
    isMirrorTransactionIdentifier("0.0.123-1700000000-123456789"),
    true,
  );
  assert.equal(
    isMirrorTransactionIdentifier("0.0.123-1700000000-1/../../accounts"),
    false,
  );
  assert.equal(
    isMirrorTransactionIdentifier(`0x${"a".repeat(64)}?limit=100`),
    false,
  );
});

test("typed proof guards bind identifiers to their exact sources", () => {
  const hash = `0x${"a".repeat(64)}`;
  const transaction = {
    type: "transaction" as const,
    kind: "fund-offer-1",
    hash,
    consensusTimestamp: "1700000000.1",
    result: "SUCCESS",
    mirror: mirrorTransaction(hash)!,
    hashScan: `https://hashscan.io/testnet/transaction/${hash}`,
  };
  assert.equal(isTransactionProof(transaction), true);
  assert.equal(
    isTransactionProof({
      ...transaction,
      hashScan: `https://hashscan.io/testnet/transaction/0x${"b".repeat(64)}`,
    }),
    false,
  );
  assert.equal(
    isTransactionProof({
      ...transaction,
      mirror: `${transaction.mirror}?redirect=https://attacker.invalid`,
    }),
    false,
  );

  const schedule = {
    type: "schedule" as const,
    address: `0x${"0".repeat(39)}1`,
    scheduleId: "0.0.1",
    executedTimestamp: "1700000120.1",
    mirror: mirrorSchedule("0.0.1")!,
    hashScan: "https://hashscan.io/testnet/schedule/0.0.1",
  };
  assert.equal(isScheduleProof(schedule), true);
  assert.equal(isScheduleProof({ ...schedule, scheduleId: "0.0.2" }), false);

  assert.equal(
    safeMirrorLink(
      `https://testnet.mirrornode.hedera.com.attacker.invalid/api/v1/contracts/results/${hash}`,
      "transaction",
    ),
    undefined,
  );
  assert.equal(
    safeMirrorLink(
      `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash}/../accounts`,
      "transaction",
    ),
    undefined,
  );

  assert.equal(
    isStateProof({
      type: "state",
      blockNumber: "123",
      rpcOrigin: "https://testnet.hashio.io",
      assertions: { "rail.solvent": true },
    }),
    true,
  );
  assert.equal(
    isStateProof({
      type: "state",
      blockNumber: "123",
      rpcOrigin: "https://testnet.mirrornode.hedera.com",
      assertions: {},
    }),
    false,
  );
});
