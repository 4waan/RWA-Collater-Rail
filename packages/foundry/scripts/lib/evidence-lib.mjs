import { setTimeout as delay } from "node:timers/promises";

const TESTNET_CHAIN_ID = 296;
export const TINYBAR_PER_HBAR = 100_000_000n;
const MAX_SIGNER_HBAR = 250n;
export const MIN_EXECUTION_RESERVE_HBAR = 25n;
export const DEFAULT_RPC_URL = "https://testnet.hashio.io/api";
export const DEFAULT_MIRROR_URL = "https://testnet.mirrornode.hedera.com";
export const DEFAULT_HERMES_URL = "https://hermes.pyth.network";
const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const EXCHANGE_RATE_ADDRESS = "0x0000000000000000000000000000000000000168";
const EXCHANGE_RATE_SYSTEM_FILE = "0.0.112";
export const HBAR_USD_PRICE_ID =
  "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const BYTES_RE = /^0x(?:[a-fA-F0-9]{2})*$/;
const ACCOUNT_ID_RE = /^0\.0\.\d+$/;
const CONSENSUS_TIMESTAMP_RE = /^\d+\.\d{1,9}$/;
const FORBIDDEN_EVIDENCE_KEYS = /private|mnemonic|secret|calldata|operatorKey/i;
const MAX_RESPONSE_BYTES = 2_000_000;
const POLICY_FIELDS = [
  "maximumAdvanceBps",
  "maximumAnnualRateBps",
  "maximumQuoteMovementBps",
  "minimumTermSeconds",
  "maximumTermSeconds",
  "maximumOfferLifetimeSeconds",
];
const DEFAULT_PARTITION = `0x${"0".repeat(63)}1`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const LIFECYCLE_TRANSACTION_KINDS = {
  atsBondDeployment: /^ats-bond-deployment-\d+$/,
  ssiAndKycConfiguration: /^kyc-grant-\d+$/,
  collateralIssuance: /^collateral-issuance-\d+$/,
  fundedOffer: /^fund-offer-1$/,
  holdCreation: /^accept-offer-1$/,
  repaidFacility: /^repay-position$/,
};

const ENDPOINT_POLICIES = {
  rpc: { origin: "https://testnet.hashio.io", pathname: "/api" },
  mirror: { origin: DEFAULT_MIRROR_URL, pathname: "/" },
  hermes: { origin: DEFAULT_HERMES_URL, pathname: "/" },
};

export function validatedEndpoint(kind, candidate) {
  const policy = ENDPOINT_POLICIES[kind];
  if (!policy) throw new Error(`Unknown endpoint policy: ${kind}.`);
  const parsed = new URL(candidate);
  if (
    parsed.origin !== policy.origin ||
    parsed.pathname.replace(/\/$/, "") !== policy.pathname.replace(/\/$/, "") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${kind} endpoint is outside the Hedera testnet allowlist.`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export function readHarnessSigner(environment = process.env) {
  const accountId = environment.HARNESS_SIGNER_ACCOUNT_ID?.trim();
  const evmAddress = environment.HARNESS_SIGNER_EVM_ADDRESS?.trim();
  const privateKey = environment.HARNESS_SIGNER_PRIVATE_KEY?.trim();
  if (!ACCOUNT_ID_RE.test(accountId ?? "")) {
    throw new Error(
      "HARNESS_SIGNER_ACCOUNT_ID must be a Hedera testnet account ID.",
    );
  }
  if (!ADDRESS_RE.test(evmAddress ?? "")) {
    throw new Error(
      "HARNESS_SIGNER_EVM_ADDRESS must be a 20-byte EVM address.",
    );
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey ?? "")) {
    throw new Error(
      "HARNESS_SIGNER_PRIVATE_KEY must be a raw 32-byte ECDSA key.",
    );
  }
  return { accountId, evmAddress, privateKey };
}

export function assertFundingBudget({
  signerTinybar,
  actorFundingTinybar,
  executionReserveTinybar = 0n,
}) {
  const cap = MAX_SIGNER_HBAR * TINYBAR_PER_HBAR;
  if (signerTinybar <= 0n || signerTinybar > cap) {
    throw new Error(
      `Harness signer balance must be between 0 and ${MAX_SIGNER_HBAR} HBAR.`,
    );
  }
  if (
    actorFundingTinybar < 0n ||
    executionReserveTinybar < 0n ||
    actorFundingTinybar + executionReserveTinybar > signerTinybar
  ) {
    throw new Error(
      "Temporary actor funding and the execution reserve exceed the Harness signer balance.",
    );
  }
}

export async function confirmMirrorAccountIdentity({
  mirrorOrigin,
  accountId,
  evmAddress,
  fetchImpl = fetch,
  indexingDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000],
}) {
  if (
    !ACCOUNT_ID_RE.test(accountId ?? "") ||
    !ADDRESS_RE.test(evmAddress ?? "")
  ) {
    throw new Error("Invalid Harness signer identity.");
  }
  const origin = new URL(mirrorOrigin).origin;
  let payload;
  for (let attempt = 0; attempt <= indexingDelaysMs.length; attempt += 1) {
    try {
      payload = await fetchAllowedJson(
        new URL(`/api/v1/accounts/${accountId}`, origin),
        origin,
        fetchImpl,
      );
      break;
    } catch (error) {
      const canRetry =
        error instanceof Error &&
        error.message === "Remote request returned HTTP 404." &&
        attempt < indexingDelaysMs.length;
      if (!canRetry) throw error;
      await delay(indexingDelaysMs[attempt]);
    }
  }
  if (!payload) {
    throw new Error("Mirror did not index the Harness signer account.");
  }
  if (
    typeof payload?.evm_address !== "string" ||
    payload.evm_address.toLowerCase() !== evmAddress.toLowerCase()
  ) {
    throw new Error(
      "Harness signer account ID does not match its EVM address.",
    );
  }
  const balance = payload?.balance?.balance;
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new Error("Mirror returned an invalid Harness signer balance.");
  }
  return { accountId, evmAddress, balanceTinybar: BigInt(balance) };
}

export async function assertDependencyBytecode({ publicClient, dependencies }) {
  for (const [name, address] of Object.entries(dependencies)) {
    if (!ADDRESS_RE.test(address ?? "")) {
      throw new Error(`Invalid ${name} dependency address.`);
    }
    const bytecode = await publicClient.getBytecode({ address });
    if (!bytecode || bytecode === "0x") {
      throw new Error(`${name} dependency has no bytecode on Hedera testnet.`);
    }
  }
}

export async function assertHip475Availability({ publicClient }) {
  const oneHbarInTinybar =
    "0000000000000000000000000000000000000000000000000000000005f5e100";
  const result = await publicClient.call({
    to: EXCHANGE_RATE_ADDRESS,
    data: `0x43a88229${oneHbarInTinybar}`,
  });
  if (!/^0x[a-fA-F0-9]{64}$/.test(result?.data ?? "")) {
    throw new Error("HIP-475 returned a malformed settlement conversion.");
  }
  const tinycentsPerHbar = BigInt(result.data);
  if (tinycentsPerHbar <= 0n) {
    throw new Error("HIP-475 returned a zero settlement conversion.");
  }
  return tinycentsPerHbar;
}

export async function assertHssCapacity({
  publicClient,
  startSecond,
  gasLimit,
  attempts = 4,
}) {
  const abi = [
    {
      type: "function",
      name: "hasScheduleCapacity",
      stateMutability: "view",
      inputs: [
        { name: "expirySecond", type: "uint256" },
        { name: "gasLimit", type: "uint256" },
      ],
      outputs: [{ name: "hasCapacity", type: "bool" }],
    },
  ];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const expirySecond = BigInt(startSecond + attempt * 5);
    const available = await publicClient.readContract({
      address: HSS_ADDRESS,
      abi,
      functionName: "hasScheduleCapacity",
      args: [expirySecond, BigInt(gasLimit)],
    });
    if (available) return expirySecond;
  }
  throw new Error("HSS has no schedule capacity in the preflight window.");
}

export function parseHermesUpdate(payload) {
  const values = payload?.binary?.data;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Hermes returned no binary Pyth update payload.");
  }
  return values.map((value) => {
    if (typeof value !== "string" || !/^[a-fA-F0-9]+$/.test(value)) {
      throw new Error("Hermes returned malformed binary update data.");
    }
    return `0x${value}`;
  });
}

export function classifyDefaultPath(
  positionBeforeFallback,
  positionAfterFallback,
  fallbackReceiptEmittedDefault = false,
) {
  const beforeState = Number(positionBeforeFallback.state);
  const afterState = Number(positionAfterFallback.state);
  if (afterState !== 3) {
    throw new Error("The overdue position did not reach DEFAULTED.");
  }
  if (beforeState === 3) {
    if (fallbackReceiptEmittedDefault) {
      throw new Error(
        "Fallback evidence conflicts with an earlier HSS default.",
      );
    }
    return "hss";
  }
  if (beforeState !== 1) {
    throw new Error("Default evidence did not start from an open position.");
  }
  return fallbackReceiptEmittedDefault ? "permissionless-fallback" : "hss";
}

function solidityAddressToEntityId(address) {
  if (!ADDRESS_RE.test(address)) throw new Error("Invalid schedule address.");
  const raw = address.slice(2).toLowerCase();
  if (!/^0{24}[a-f0-9]{16}$/.test(raw)) {
    throw new Error(
      "Schedule address is not a Hedera long-zero entity address.",
    );
  }
  return `0.0.${BigInt(`0x${raw.slice(24)}`).toString()}`;
}

export function hashScanTransaction(hash) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid transaction hash.");
  return `https://hashscan.io/testnet/transaction/${hash}`;
}

export function mirrorTransaction(hash) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid transaction hash.");
  return `${DEFAULT_MIRROR_URL}/api/v1/contracts/results/${hash}`;
}

export function hashScanContract(address) {
  if (!ADDRESS_RE.test(address)) throw new Error("Invalid contract address.");
  return `https://hashscan.io/testnet/contract/${address}`;
}

export function mirrorContract(address) {
  if (!ADDRESS_RE.test(address)) throw new Error("Invalid contract address.");
  return `${DEFAULT_MIRROR_URL}/api/v1/contracts/${address}`;
}

export function mirrorAccountBalance(address) {
  if (!ADDRESS_RE.test(address)) throw new Error("Invalid account address.");
  return `${DEFAULT_MIRROR_URL}/api/v1/accounts/${address.toLowerCase()}?transactions=false`;
}

export function hashScanSchedule(scheduleId) {
  if (!ACCOUNT_ID_RE.test(scheduleId)) throw new Error("Invalid schedule ID.");
  return `https://hashscan.io/testnet/schedule/${scheduleId}`;
}

export function mirrorSchedule(scheduleId) {
  if (!ACCOUNT_ID_RE.test(scheduleId)) throw new Error("Invalid schedule ID.");
  return `${DEFAULT_MIRROR_URL}/api/v1/schedules/${scheduleId}`;
}

function semanticBootstrapCategory(transaction) {
  const functionName = String(transaction?.function ?? "").toLowerCase();
  const contractName = String(transaction?.contractName ?? "").toLowerCase();
  if (functionName.startsWith("deploybond(")) return "ats-bond-deployment";
  if (functionName.startsWith("addissuer(")) return "issuer-configuration";
  if (functionName.startsWith("grantkyc(")) return "kyc-grant";
  if (functionName.startsWith("issue(")) return "collateral-issuance";
  if (functionName.startsWith("fundautomation(")) return "automation-funding";
  if (
    contractName === "pythhbarusdoracle" ||
    contractName === "hederaexchangerateoracle" ||
    contractName === "pythusdoracle" ||
    contractName === "fixedtestusdoracle"
  ) {
    return "oracle-deployment";
  }
  if (
    contractName === "atscollateralrail" ||
    contractName === "atscollateralrailhts"
  )
    return "rail-deployment";
  if (contractName === "railacceptance" || contractName === "htsrailacceptance")
    return "acceptance-deployment";
  return "bootstrap-call";
}

export function categorizeBootstrapTransactions(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw new Error("Foundry bootstrap emitted no transactions.");
  }
  const counts = new Map();
  const categorized = transactions.map((transaction) => {
    const hash = transaction?.hash ?? transaction?.transactionHash;
    if (!HASH_RE.test(hash ?? "")) {
      throw new Error(
        "Foundry bootstrap emitted a transaction without a mined hash.",
      );
    }
    const category = semanticBootstrapCategory(transaction);
    const count = (counts.get(category) ?? 0) + 1;
    counts.set(category, count);
    return {
      kind: `${category}-${count}`,
      hash,
    };
  });
  for (const required of [
    "ats-bond-deployment",
    "issuer-configuration",
    "kyc-grant",
    "collateral-issuance",
    "oracle-deployment",
    "rail-deployment",
    "automation-funding",
    "acceptance-deployment",
  ]) {
    if (!categorized.some(({ kind }) => kind.startsWith(`${required}-`))) {
      throw new Error(`Foundry bootstrap omitted semantic step ${required}.`);
    }
  }
  if (
    categorized.filter(({ kind }) => kind.startsWith("kyc-grant-")).length < 2
  ) {
    throw new Error("Foundry bootstrap omitted one or more KYC grants.");
  }
  return categorized;
}

export function proofForSemanticKind(proofs, category, selection = "first") {
  const matches = proofs.filter(({ kind }) => kind.startsWith(`${category}-`));
  if (matches.length === 0) {
    throw new Error(`Missing verified bootstrap proof for ${category}.`);
  }
  return selection === "last" ? matches.at(-1) : matches[0];
}

async function safeJson(response, label) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the size limit.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeded the size limit.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function fetchAllowedJson(
  url,
  expectedOrigin,
  fetchImpl = fetch,
  headers = {},
) {
  const parsed = new URL(url);
  if (parsed.origin !== expectedOrigin || parsed.username || parsed.password) {
    throw new Error("Remote request escaped the configured testnet origin.");
  }
  const response = await fetchImpl(parsed, {
    headers: { Accept: "application/json", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Remote request returned HTTP ${response.status}.`);
  }
  return safeJson(response, parsed.pathname);
}

export async function readCurrentMirrorBalance({
  mirrorOrigin,
  evmAddress,
  fetchImpl = fetch,
  checkedAt = new Date().toISOString(),
}) {
  if (!ADDRESS_RE.test(evmAddress ?? "")) {
    throw new Error("Invalid rail address for Mirror balance verification.");
  }
  const origin = new URL(mirrorOrigin).origin;
  const mirror = new URL(
    `/api/v1/accounts/${evmAddress.toLowerCase()}?transactions=false`,
    origin,
  );
  const payload = await fetchAllowedJson(mirror, origin, fetchImpl);
  const accountId = payload?.account;
  const returnedAddress = payload?.evm_address;
  const balance = payload?.balance?.balance;
  const balanceTimestamp = payload?.balance?.timestamp;
  if (
    !ACCOUNT_ID_RE.test(accountId ?? "") ||
    typeof returnedAddress !== "string" ||
    returnedAddress.toLowerCase() !== evmAddress.toLowerCase() ||
    payload?.deleted !== false ||
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    !CONSENSUS_TIMESTAMP_RE.test(balanceTimestamp ?? "") ||
    !Number.isFinite(Date.parse(checkedAt))
  ) {
    throw new Error("Mirror returned an invalid current rail balance.");
  }
  return {
    type: "balance",
    basis: "current-mirror-account",
    accountId,
    evmAddress: evmAddress.toLowerCase(),
    balanceTinybar: String(balance),
    balanceTimestamp,
    checkedAt,
    mirror: mirror.toString(),
  };
}

export function assertRailSolvency({ balanceTinybar, requiredBackingTinybar }) {
  const balance = BigInt(balanceTinybar);
  const requiredBacking = BigInt(requiredBackingTinybar);
  if (balance < requiredBacking) {
    throw new Error(
      "Current Mirror balance does not cover liabilities and reserves.",
    );
  }
  return {
    balanceTinybar: balance,
    requiredBackingTinybar: requiredBacking,
  };
}

export async function fetchMirrorPages({
  mirrorOrigin,
  pathname,
  collectionKey,
  fetchImpl = fetch,
  maxPages = 20,
}) {
  const origin = new URL(mirrorOrigin).origin;
  let next = new URL(pathname, origin).toString();
  const collected = [];
  const seen = new Set();
  for (let page = 0; next && page < maxPages; page += 1) {
    if (seen.has(next)) throw new Error("Mirror pagination loop detected.");
    seen.add(next);
    const url = new URL(next, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/v1/")) {
      throw new Error("Mirror pagination escaped the testnet API allowlist.");
    }
    const payload = await fetchAllowedJson(url, origin, fetchImpl);
    const values = payload?.[collectionKey];
    if (!Array.isArray(values)) {
      throw new Error(`Mirror response omitted ${collectionKey}.`);
    }
    collected.push(...values);
    const candidate = payload?.links?.next;
    next = candidate ? new URL(candidate, origin).toString() : "";
  }
  if (next) throw new Error("Mirror pagination exceeded the page limit.");
  return collected;
}

export async function waitForMirrorTransaction({
  mirrorOrigin,
  hash,
  fetchImpl = fetch,
  timeoutMs = 120_000,
  intervalMs = 2_000,
}) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid transaction hash.");
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await fetchAllowedJson(
        new URL(
          `/api/v1/contracts/results/${encodeURIComponent(hash)}`,
          mirrorOrigin,
        ),
        new URL(mirrorOrigin).origin,
        fetchImpl,
      );
      if (String(result?.hash ?? "").toLowerCase() !== hash.toLowerCase()) {
        throw new Error(
          `Mirror returned a different contract result for ${hash}.`,
        );
      }
      if (result.status !== "0x1" || result.error_message !== null) {
        throw new Error(`Mirror reports a non-success result for ${hash}.`);
      }
      if (!CONSENSUS_TIMESTAMP_RE.test(result.timestamp ?? "")) {
        throw new Error(`Mirror omitted the consensus timestamp for ${hash}.`);
      }
      return {
        type: "transaction",
        hash,
        consensusTimestamp: result.timestamp,
        result: "SUCCESS",
        mirror: mirrorTransaction(hash),
        hashScan: hashScanTransaction(hash),
      };
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `Mirror did not confirm ${hash}: ${lastError instanceof Error ? lastError.message : "timeout"}`,
  );
}

export async function confirmMirrorSchedule({
  mirrorOrigin,
  scheduleAddress,
  fetchImpl = fetch,
}) {
  const scheduleId = solidityAddressToEntityId(scheduleAddress);
  const origin = new URL(mirrorOrigin).origin;
  const payload = await fetchAllowedJson(
    new URL(`/api/v1/schedules/${scheduleId}`, origin),
    origin,
    fetchImpl,
  );
  if (payload?.schedule_id !== scheduleId) {
    throw new Error(`Mirror did not confirm schedule ${scheduleId}.`);
  }
  return {
    type: "schedule",
    address: scheduleAddress,
    scheduleId,
    executedTimestamp: payload.executed_timestamp ?? null,
    mirror: mirrorSchedule(scheduleId),
    hashScan: hashScanSchedule(scheduleId),
  };
}

export class EvidenceJournal {
  #transactions = new Map();

  add(kind, transaction) {
    if (!HASH_RE.test(transaction?.hash ?? "")) {
      throw new Error(`Invalid transaction hash for ${kind}.`);
    }
    const existing = this.#transactions.get(transaction.hash.toLowerCase());
    const next = { kind, ...transaction };
    if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
      throw new Error(`Conflicting evidence for ${transaction.hash}.`);
    }
    this.#transactions.set(transaction.hash.toLowerCase(), next);
    return next;
  }

  values() {
    return [...this.#transactions.values()];
  }
}

export async function createTemporaryActor({
  sdk,
  client,
  label,
  initialHbar,
  busyRetryDelaysMs = [15_000, 30_000, 60_000, 90_000],
}) {
  const privateKey = sdk.PrivateKey.generateECDSA();
  let response;
  let lastError;
  for (let attempt = 0; attempt <= busyRetryDelaysMs.length; attempt += 1) {
    try {
      response = await new sdk.AccountCreateTransaction()
        .setECDSAKeyWithAlias(privateKey)
        .setInitialBalance(new sdk.Hbar(initialHbar))
        .execute(client);
      break;
    } catch (error) {
      lastError = error;
      const retryDelay = busyRetryDelaysMs[attempt];
      if (retryDelay === undefined || !/\bBUSY\b/i.test(String(error))) break;
      console.log(
        `Hedera is busy while creating the temporary ${label}; retrying in ${retryDelay / 1_000} seconds.`,
      );
      await delay(retryDelay);
    }
  }
  if (!response) {
    throw new Error(
      `Could not create temporary ${label} account: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  let receipt;
  for (let attempt = 0; attempt <= busyRetryDelaysMs.length; attempt += 1) {
    try {
      receipt = await response.getReceipt(client);
      break;
    } catch (error) {
      lastError = error;
      const retryDelay = busyRetryDelaysMs[attempt];
      if (retryDelay === undefined || !/\bBUSY\b/i.test(String(error))) break;
      await delay(retryDelay);
    }
  }
  if (!receipt) {
    throw new Error(
      `Could not confirm temporary ${label} account: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  const accountId = receipt.accountId?.toString();
  if (!ACCOUNT_ID_RE.test(accountId ?? "")) {
    throw new Error("Account creation returned no account ID.");
  }
  return {
    label,
    accountId,
    evmAddress: `0x${privateKey.publicKey.toEvmAddress()}`,
    privateKey,
    privateKeyHex: `0x${privateKey.toStringRaw()}`,
  };
}

export async function sweepTemporaryActor({
  sdk,
  client,
  actor,
  destinationId,
}) {
  try {
    const frozen = await new sdk.AccountDeleteTransaction()
      .setAccountId(sdk.AccountId.fromString(actor.accountId))
      .setTransferAccountId(sdk.AccountId.fromString(destinationId))
      .freezeWith(client);
    const signed = await frozen.sign(actor.privateKey);
    await (await signed.execute(client)).getReceipt(client);
    return { accountId: actor.accountId, swept: true };
  } catch (error) {
    return {
      accountId: actor.accountId,
      swept: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function visitEvidence(value, path = "record") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVIDENCE_KEYS.test(key)) {
      throw new Error(`Evidence contains forbidden field ${path}.${key}.`);
    }
    visitEvidence(child, `${path}.${key}`);
  }
}

export function validateRailPolicyEvidence(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Evidence is missing the deployed rail policy.");
  }
  if (
    POLICY_FIELDS.some(
      (field) => !Number.isSafeInteger(policy[field]) || policy[field] < 0,
    )
  ) {
    throw new Error("Evidence rail policy contains a non-integer value.");
  }
  if (
    policy.maximumAdvanceBps === 0 ||
    policy.maximumAdvanceBps > 7_000 ||
    policy.maximumAnnualRateBps > 10_000 ||
    policy.maximumQuoteMovementBps > 100 ||
    policy.minimumTermSeconds < 120 ||
    policy.maximumTermSeconds < policy.minimumTermSeconds ||
    policy.maximumTermSeconds > 365 * 24 * 60 * 60 ||
    policy.maximumOfferLifetimeSeconds === 0 ||
    policy.maximumOfferLifetimeSeconds > 24 * 60 * 60
  ) {
    throw new Error(
      "Evidence rail policy is outside the kernel safety envelope.",
    );
  }
  return policy;
}

function validateTransactionProof(proof) {
  if (
    proof?.type !== "transaction" ||
    typeof proof?.kind !== "string" ||
    proof.kind.length === 0 ||
    !HASH_RE.test(proof?.hash ?? "") ||
    proof?.result !== "SUCCESS" ||
    !CONSENSUS_TIMESTAMP_RE.test(proof?.consensusTimestamp ?? "") ||
    proof?.mirror !== mirrorTransaction(proof.hash) ||
    proof?.hashScan !== hashScanTransaction(proof.hash)
  ) {
    throw new Error("Evidence contains an unverified transaction proof.");
  }
  return proof;
}

function validateScheduleProof(proof) {
  if (
    proof?.type !== "schedule" ||
    !ADDRESS_RE.test(proof?.address ?? "") ||
    !ACCOUNT_ID_RE.test(proof?.scheduleId ?? "") ||
    solidityAddressToEntityId(proof.address) !== proof.scheduleId ||
    (proof.executedTimestamp !== null &&
      !CONSENSUS_TIMESTAMP_RE.test(proof.executedTimestamp)) ||
    proof?.mirror !== mirrorSchedule(proof.scheduleId) ||
    proof?.hashScan !== hashScanSchedule(proof.scheduleId)
  ) {
    throw new Error("Evidence contains an invalid HSS schedule proof.");
  }
  return proof;
}

function validateStateProof(proof) {
  if (
    proof?.type !== "state" ||
    !/^[1-9]\d*$/.test(proof?.blockNumber ?? "") ||
    BigInt(proof.blockNumber) <= 0n ||
    proof?.rpcOrigin !== new URL(DEFAULT_RPC_URL).origin ||
    !proof.assertions ||
    typeof proof.assertions !== "object" ||
    Array.isArray(proof.assertions) ||
    Object.keys(proof.assertions).length === 0 ||
    Object.values(proof.assertions).some(
      (value) => !["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    throw new Error("Evidence contains an incomplete state proof.");
  }
  return proof;
}

function validateBalanceProof(proof, railAddress) {
  if (
    proof?.type !== "balance" ||
    proof?.basis !== "current-mirror-account" ||
    !ACCOUNT_ID_RE.test(proof?.accountId ?? "") ||
    !ADDRESS_RE.test(proof?.evmAddress ?? "") ||
    proof.evmAddress.toLowerCase() !== railAddress.toLowerCase() ||
    !isCanonicalUnsignedInteger(proof?.balanceTinybar) ||
    !CONSENSUS_TIMESTAMP_RE.test(proof?.balanceTimestamp ?? "") ||
    !Number.isFinite(Date.parse(proof?.checkedAt ?? "")) ||
    proof?.mirror !== mirrorAccountBalance(railAddress)
  ) {
    throw new Error("Evidence contains an invalid current balance proof.");
  }
  return proof;
}

function proofMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCanonicalUnsignedInteger(value, positive = false) {
  return (
    typeof value === "string" &&
    (positive ? /^[1-9]\d*$/.test(value) : /^(?:0|[1-9]\d*)$/.test(value))
  );
}

export function validateEvidenceRecord(record) {
  visitEvidence(record);
  if (
    record?.schemaVersion !== 3 ||
    record?.network !== "hedera-testnet" ||
    record?.chainId !== TESTNET_CHAIN_ID ||
    record?.status !== "verified"
  ) {
    throw new Error("Evidence record is not a verified Hedera testnet record.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.recipeId ?? "")) {
    throw new Error("Evidence is missing a valid recipe ID.");
  }
  if (!Number.isFinite(Date.parse(record.generatedAt ?? ""))) {
    throw new Error("Evidence is missing its generation timestamp.");
  }
  validateRailPolicyEvidence(record.policy);
  const oracleEvidence =
    record.oracle ??
    (record.pyth
      ? {
          kind: "pyth",
          ...record.pyth,
          observedAt: record.pyth.publishTime,
        }
      : null);
  if (
    !oracleEvidence ||
    !["pyth", "hedera-exchange-rate"].includes(oracleEvidence.kind)
  ) {
    throw new Error(
      "Evidence is missing a supported HBAR settlement oracle source.",
    );
  }
  for (const name of [
    "factory",
    "resolver",
    "atsToken",
    "oracle",
    "rail",
    "acceptance",
  ]) {
    if (!ADDRESS_RE.test(record.addresses?.[name] ?? "")) {
      throw new Error(`Evidence is missing ${name}.`);
    }
  }
  if (
    (oracleEvidence.kind === "pyth" &&
      !ADDRESS_RE.test(record.addresses?.pyth ?? "")) ||
    (oracleEvidence.kind === "hedera-exchange-rate" &&
      record.addresses?.exchangeRateSystem?.toLowerCase() !==
        EXCHANGE_RATE_ADDRESS)
  ) {
    throw new Error(
      "Evidence oracle dependency does not match its declared source.",
    );
  }
  for (const actor of ["issuer", "lender", "borrower"]) {
    if (
      !ACCOUNT_ID_RE.test(record.actors?.[actor]?.accountId ?? "") ||
      !ADDRESS_RE.test(record.actors?.[actor]?.evmAddress ?? "")
    ) {
      throw new Error(`Evidence is missing public ${actor} identity data.`);
    }
  }
  const actorValues = Object.values(record.actors);
  if (
    new Set(actorValues.map(({ accountId }) => accountId)).size !== 3 ||
    new Set(actorValues.map(({ evmAddress }) => evmAddress.toLowerCase()))
      .size !== 3
  ) {
    throw new Error("Evidence actor identities must be distinct.");
  }
  if (!Array.isArray(record.transactions) || record.transactions.length < 10) {
    throw new Error("Evidence has too few verified transactions.");
  }
  const verifiedTransactions = new Map();
  for (const transaction of record.transactions) {
    validateTransactionProof(transaction);
    const normalizedHash = transaction.hash.toLowerCase();
    if (verifiedTransactions.has(normalizedHash)) {
      throw new Error("Evidence contains a duplicate transaction proof.");
    }
    verifiedTransactions.set(normalizedHash, transaction);
  }
  const lifecycle = record.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object") {
    throw new Error("Evidence lifecycle is incomplete.");
  }
  for (const [key, kindPattern] of Object.entries(
    LIFECYCLE_TRANSACTION_KINDS,
  )) {
    const proof = validateTransactionProof(lifecycle[key]);
    const canonical = verifiedTransactions.get(proof.hash.toLowerCase());
    if (
      !kindPattern.test(proof.kind) ||
      !canonical ||
      !proofMatches(proof, canonical)
    ) {
      throw new Error(
        `Evidence lifecycle ${key} is not bound to its semantic transaction proof.`,
      );
    }
  }
  if (oracleEvidence.kind === "pyth") {
    if (lifecycle.pythPriceUpdate?.type !== "transaction") {
      throw new Error(
        "Pyth evidence must claim its Mirror-confirmed update transaction.",
      );
    }
    const proof = validateTransactionProof(lifecycle.pythPriceUpdate);
    const canonical = verifiedTransactions.get(proof.hash.toLowerCase());
    if (
      !/^pyth-price-refresh$/.test(proof.kind) ||
      !canonical ||
      !proofMatches(proof, canonical)
    ) {
      throw new Error(
        "Evidence lifecycle Pyth update is not bound to its semantic transaction proof.",
      );
    }
  } else if (lifecycle.pythPriceUpdate !== null) {
    throw new Error(
      "HIP-475 evidence must not claim a Pyth update transaction.",
    );
  }
  validateScheduleProof(lifecycle.hssScheduleCreation);
  if (lifecycle.maturedDefault?.type === "transaction") {
    const proof = validateTransactionProof(lifecycle.maturedDefault);
    const canonical = verifiedTransactions.get(proof.hash.toLowerCase());
    if (!canonical || !proofMatches(proof, canonical)) {
      throw new Error(
        "Evidence default lifecycle is not bound to its transaction proof.",
      );
    }
  } else {
    validateScheduleProof(lifecycle.maturedDefault);
  }
  const lifecycleState = validateStateProof(lifecycle.liveConfigurationRead);
  if (!Array.isArray(record.positions) || record.positions.length !== 2) {
    throw new Error("Evidence must contain exactly two positions.");
  }
  const states = new Set(record.positions.map((position) => position.state));
  if (!states.has("REPAID") || !states.has("DEFAULTED")) {
    throw new Error(
      "Evidence must contain repaid and defaulted terminal states.",
    );
  }
  const holdIds = new Set(
    record.positions.map((position) => String(position.holdId)),
  );
  const positionIds = new Set(
    record.positions.map((position) => String(position.id).toLowerCase()),
  );
  if (holdIds.size !== 2 || holdIds.has("0")) {
    throw new Error("Evidence must contain two distinct ATS holds.");
  }
  if (positionIds.size !== 2) {
    throw new Error("Evidence must contain two distinct positions.");
  }
  for (const position of record.positions) {
    if (
      !HASH_RE.test(position?.id ?? "") ||
      !ADDRESS_RE.test(position?.lender ?? "") ||
      !ADDRESS_RE.test(position?.borrower ?? "") ||
      !isCanonicalUnsignedInteger(position?.holdId, true) ||
      !ADDRESS_RE.test(position?.scheduleAddress ?? "") ||
      !isCanonicalUnsignedInteger(position?.collateralAmount, true) ||
      !isCanonicalUnsignedInteger(position?.principalTinybar, true) ||
      !isCanonicalUnsignedInteger(position?.repaymentTinybar, true) ||
      BigInt(position.repaymentTinybar) < BigInt(position.principalTinybar) ||
      !Number.isSafeInteger(position?.openedAt) ||
      !Number.isSafeInteger(position?.maturity) ||
      position.maturity <= position.openedAt ||
      !["PENDING", "COMPLETED", "UNAVAILABLE", "NONE"].includes(
        position?.automation,
      ) ||
      position.lender.toLowerCase() !==
        record.actors.lender.evmAddress.toLowerCase() ||
      position.borrower.toLowerCase() !==
        record.actors.borrower.evmAddress.toLowerCase()
    ) {
      throw new Error("Evidence contains an incomplete position proof.");
    }
    if (
      (position.state === "REPAID" && position.terminalPath !== "repayment") ||
      (position.state === "DEFAULTED" &&
        !["hss", "permissionless-fallback"].includes(position.terminalPath))
    ) {
      throw new Error("Evidence position terminal path contradicts its state.");
    }
  }
  if (!Array.isArray(record.holds) || record.holds.length !== 2) {
    throw new Error("Evidence must contain two exact ATS hold inspections.");
  }
  const holdsByPosition = new Map();
  for (const hold of record.holds) {
    const position = record.positions.find(
      (candidate) =>
        candidate.id.toLowerCase() === String(hold?.positionId).toLowerCase(),
    );
    if (
      !position ||
      holdsByPosition.has(position.id.toLowerCase()) ||
      !HASH_RE.test(hold?.positionId ?? "") ||
      !ADDRESS_RE.test(hold?.holder ?? "") ||
      !HASH_RE.test(hold?.partition ?? "") ||
      !ADDRESS_RE.test(hold?.escrow ?? "") ||
      !ADDRESS_RE.test(hold?.destination ?? "") ||
      !HASH_RE.test(hold?.data ?? "") ||
      !BYTES_RE.test(hold?.operatorData ?? "") ||
      hold.holdId !== position.holdId ||
      hold.holder.toLowerCase() !== position.borrower.toLowerCase() ||
      hold.partition.toLowerCase() !== DEFAULT_PARTITION ||
      hold.amount !== position.collateralAmount ||
      !isCanonicalUnsignedInteger(hold.expirationTimestamp, true) ||
      BigInt(hold.expirationTimestamp) <= BigInt(position.maturity) ||
      hold.escrow.toLowerCase() !== record.addresses.rail.toLowerCase() ||
      hold.destination.toLowerCase() !== ZERO_ADDRESS ||
      hold.data.toLowerCase() !== position.id.toLowerCase() ||
      hold.operatorData !== "0x" ||
      !Number.isSafeInteger(hold.thirdPartyType) ||
      hold.thirdPartyType < 0
    ) {
      throw new Error("Evidence contains an invalid ATS hold inspection.");
    }
    const holdState = validateStateProof(hold.state);
    const expectedHoldAssertions = {
      "hold.positionId": hold.positionId,
      "hold.holdId": hold.holdId,
      "hold.holder": hold.holder,
      "hold.partition": hold.partition,
      "hold.amount": hold.amount,
      "hold.expirationTimestamp": hold.expirationTimestamp,
      "hold.escrow": hold.escrow,
      "hold.destination": hold.destination,
      "hold.data": hold.data,
      "hold.operatorData": hold.operatorData,
      "hold.thirdPartyType": hold.thirdPartyType,
    };
    for (const [key, expected] of Object.entries(expectedHoldAssertions)) {
      if (holdState.assertions[key] !== expected) {
        throw new Error(`Evidence hold proof is missing assertion ${key}.`);
      }
    }
    const terminalState = validateStateProof(hold.terminalState);
    const expectedTerminalAssertions = {
      "hold.positionId": hold.positionId,
      "hold.holdId": hold.holdId,
      "hold.holder": hold.holder,
      "hold.partition": hold.partition,
      "hold.remainingAmount": "0",
      "hold.deleted": true,
    };
    if (
      terminalState.blockNumber !== lifecycleState.blockNumber ||
      terminalState.rpcOrigin !== lifecycleState.rpcOrigin
    ) {
      throw new Error(
        "Terminal hold proof must use the final verification block.",
      );
    }
    for (const [key, expected] of Object.entries(expectedTerminalAssertions)) {
      if (terminalState.assertions[key] !== expected) {
        throw new Error(
          `Evidence terminal hold proof is missing assertion ${key}.`,
        );
      }
    }
    holdsByPosition.set(position.id.toLowerCase(), hold);
  }
  if (!Array.isArray(record.schedules) || record.schedules.length === 0) {
    throw new Error("Evidence has no Mirror-confirmed HSS schedule proof.");
  }
  const verifiedSchedules = new Map();
  for (const schedule of record.schedules) {
    validateScheduleProof(schedule);
    const normalizedAddress = schedule.address.toLowerCase();
    if (verifiedSchedules.has(normalizedAddress)) {
      throw new Error("Evidence contains a duplicate HSS schedule proof.");
    }
    verifiedSchedules.set(normalizedAddress, schedule);
  }
  const scheduledPositionAddresses = record.positions
    .filter((position) => position.scheduleAddress !== ZERO_ADDRESS)
    .map((position) => position.scheduleAddress.toLowerCase());
  const scheduledPositions = new Set(scheduledPositionAddresses);
  if (
    scheduledPositions.size === 0 ||
    scheduledPositions.size !== scheduledPositionAddresses.length ||
    verifiedSchedules.size !== scheduledPositions.size ||
    [...scheduledPositions].some(
      (scheduleAddress) => !verifiedSchedules.has(scheduleAddress),
    ) ||
    !proofMatches(
      lifecycle.hssScheduleCreation,
      verifiedSchedules.get(
        lifecycle.hssScheduleCreation.address.toLowerCase(),
      ),
    )
  ) {
    throw new Error("Evidence schedule is not bound to either position.");
  }
  for (const position of record.positions) {
    const hasSchedule = position.scheduleAddress !== ZERO_ADDRESS;
    if (hasSchedule) {
      const schedule = verifiedSchedules.get(
        position.scheduleAddress.toLowerCase(),
      );
      if (
        position.automation !== "COMPLETED" ||
        schedule?.executedTimestamp === null
      ) {
        throw new Error(
          "Terminal position schedule execution contradicts its automation state.",
        );
      }
    } else if (position.automation !== "UNAVAILABLE") {
      throw new Error(
        "Terminal position without a schedule must record unavailable automation.",
      );
    }
  }
  const defaultedPosition = record.positions.find(
    (position) => position.state === "DEFAULTED",
  );
  if (defaultedPosition.terminalPath === "hss") {
    if (
      lifecycle.maturedDefault.type !== "schedule" ||
      lifecycle.maturedDefault.address.toLowerCase() !==
        defaultedPosition.scheduleAddress.toLowerCase() ||
      lifecycle.maturedDefault.executedTimestamp === null ||
      defaultedPosition.automation !== "COMPLETED" ||
      !proofMatches(
        lifecycle.maturedDefault,
        verifiedSchedules.get(defaultedPosition.scheduleAddress.toLowerCase()),
      )
    ) {
      throw new Error("HSS terminal path lacks an executed schedule proof.");
    }
  } else if (
    lifecycle.maturedDefault.type !== "transaction" ||
    lifecycle.maturedDefault.kind !== "permissionless-default" ||
    !["COMPLETED", "UNAVAILABLE"].includes(defaultedPosition.automation)
  ) {
    throw new Error(
      "Fallback terminal path lacks a settlement transaction proof.",
    );
  }
  if (!record.verification?.complete) {
    throw new Error("Evidence is missing final verification data.");
  }
  if (oracleEvidence.kind === "pyth") {
    if (
      oracleEvidence.feedId !== HBAR_USD_PRICE_ID ||
      !Number.isSafeInteger(oracleEvidence.observedAt) ||
      oracleEvidence.observedAt <= 0 ||
      !/^[1-9]\d*$/.test(oracleEvidence.priceUsdE8 ?? "") ||
      !isCanonicalUnsignedInteger(oracleEvidence.confidenceUsdE8) ||
      typeof oracleEvidence.purpose !== "string" ||
      oracleEvidence.purpose.length === 0 ||
      record.pyth?.feedId !== oracleEvidence.feedId ||
      record.pyth?.priceUsdE8 !== oracleEvidence.priceUsdE8 ||
      record.pyth?.confidenceUsdE8 !== oracleEvidence.confidenceUsdE8 ||
      record.pyth?.publishTime !== oracleEvidence.observedAt ||
      record.pyth?.purpose !== oracleEvidence.purpose
    ) {
      throw new Error("Evidence is missing Pyth oracle data.");
    }
  } else if (
    oracleEvidence.systemContract?.toLowerCase() !== EXCHANGE_RATE_ADDRESS ||
    oracleEvidence.systemFile !== EXCHANGE_RATE_SYSTEM_FILE ||
    !Number.isSafeInteger(oracleEvidence.observedAt) ||
    oracleEvidence.observedAt <= 0 ||
    !/^[1-9]\d*$/.test(oracleEvidence.priceUsdE8 ?? "") ||
    oracleEvidence.confidenceUsdE8 !== "0" ||
    typeof oracleEvidence.purpose !== "string" ||
    oracleEvidence.purpose.length === 0 ||
    typeof oracleEvidence.caveat !== "string" ||
    !oracleEvidence.caveat.includes("not a live market price oracle") ||
    record.pyth !== null
  ) {
    throw new Error(
      "Evidence is missing Hedera exchange-rate data or its safety caveat.",
    );
  }
  if (record.verification.mirrorOrigin !== DEFAULT_MIRROR_URL) {
    throw new Error(
      "Evidence verification did not use the public testnet Mirror Node.",
    );
  }
  for (const name of ["atsToken", "oracle", "rail", "acceptance"]) {
    if (
      record.verification.contractLinks?.[name] !==
      hashScanContract(record.addresses[name])
    ) {
      throw new Error(`Evidence has an invalid ${name} proof link.`);
    }
    if (
      record.verification.contractMirrorLinks?.[name] !==
      mirrorContract(record.addresses[name])
    ) {
      throw new Error(`Evidence has an invalid ${name} Mirror source link.`);
    }
  }
  const expectedHashScanLinks =
    record.transactions.length + record.schedules.length + 4;
  const expectedMirrorLinks = expectedHashScanLinks + 1;
  const linkAudit = record.verification.linkAudit;
  if (
    !linkAudit ||
    !["available", "unavailable", "mixed", "unchecked"].includes(
      linkAudit.hashScanStatus,
    ) ||
    !["verified", "unavailable", "unchecked"].includes(
      linkAudit.mirrorStatus,
    ) ||
    !Number.isSafeInteger(linkAudit.hashScanChecked) ||
    linkAudit.hashScanChecked < 0 ||
    !Number.isSafeInteger(linkAudit.mirrorChecked) ||
    linkAudit.mirrorChecked < 0 ||
    (linkAudit.hashScanStatus === "unchecked" &&
      (linkAudit.checkedAt !== null || linkAudit.hashScanChecked !== 0)) ||
    (linkAudit.hashScanStatus !== "unchecked" &&
      (!Number.isFinite(Date.parse(linkAudit.checkedAt ?? "")) ||
        linkAudit.hashScanChecked !== expectedHashScanLinks)) ||
    (linkAudit.mirrorStatus === "verified" &&
      linkAudit.mirrorChecked !== expectedMirrorLinks) ||
    (linkAudit.finding !== null &&
      (typeof linkAudit.finding !== "string" ||
        !/^docs\/findings\/[a-z0-9-]+\.md$/.test(linkAudit.finding)))
  ) {
    throw new Error("Evidence has an invalid public link audit.");
  }
  if (
    !record.ats ||
    record.ats.internalKyc !== true ||
    record.ats.issuer !== true ||
    record.ats.kyc?.lender !== 1 ||
    record.ats.kyc?.borrower !== 1 ||
    record.ats.roles?.issuer !== true ||
    record.ats.roles?.kyc !== true ||
    record.ats.roles?.ssiManager !== true ||
    !isCanonicalUnsignedInteger(record.ats.assetMaturity, true) ||
    record.ats.clearingActive !== false ||
    record.ats.tokenDecimals !== 0 ||
    record.ats.nominalValue !== "10000" ||
    record.ats.nominalValueDecimals !== 2 ||
    record.ats.nominalValueCurrency?.toLowerCase() !== "0x555344"
  ) {
    throw new Error("Evidence is missing final ATS compliance assertions.");
  }
  for (const party of ["borrower", "lender"]) {
    for (const field of ["free", "held"]) {
      if (!isCanonicalUnsignedInteger(record.ats.balances?.[party]?.[field])) {
        throw new Error(`Evidence is missing ATS ${party} ${field} balance.`);
      }
    }
  }
  if (
    record.ats.balances.borrower.held !== "0" ||
    record.ats.balances.lender.held !== "0"
  ) {
    throw new Error("Terminal evidence retains an ATS held balance.");
  }
  for (const field of [
    "cashLiabilitiesTinybar",
    "reservedAutomationTinybar",
    "requiredBackingTinybar",
    "contractBalanceTinybar",
  ]) {
    if (!isCanonicalUnsignedInteger(record.accounting?.[field])) {
      throw new Error(`Evidence accounting is missing ${field}.`);
    }
  }
  const balanceProof = validateBalanceProof(
    record.verification?.balance,
    record.addresses.rail,
  );
  if (
    BigInt(record.accounting.requiredBackingTinybar) !==
      BigInt(record.accounting.cashLiabilitiesTinybar) +
        BigInt(record.accounting.reservedAutomationTinybar) ||
    balanceProof.balanceTinybar !== record.accounting.contractBalanceTinybar ||
    BigInt(record.accounting.contractBalanceTinybar) <
      BigInt(record.accounting.requiredBackingTinybar)
  ) {
    throw new Error("Evidence records an insolvent rail balance.");
  }
  const stateProof = validateStateProof(record.verification.state);
  if (!proofMatches(stateProof, lifecycleState)) {
    throw new Error("Evidence lifecycle and verification state proofs differ.");
  }
  const requiredAssertions = {
    "ats.internalKyc": true,
    "ats.issuer": true,
    "ats.lenderKyc": 1,
    "ats.borrowerKyc": 1,
    "ats.assetMaturity": record.ats.assetMaturity,
    "ats.clearingActive": false,
    "ats.tokenDecimals": record.ats.tokenDecimals,
    "ats.nominalValue": record.ats.nominalValue,
    "ats.nominalValueDecimals": record.ats.nominalValueDecimals,
    "ats.nominalValueCurrency": record.ats.nominalValueCurrency,
    "ats.borrowerFree": record.ats.balances.borrower.free,
    "ats.borrowerHeld": record.ats.balances.borrower.held,
    "ats.lenderFree": record.ats.balances.lender.free,
    "ats.lenderHeld": record.ats.balances.lender.held,
    "rail.cashLiabilitiesTinybar": record.accounting.cashLiabilitiesTinybar,
    "rail.reservedAutomationTinybar":
      record.accounting.reservedAutomationTinybar,
    "rail.requiredBackingTinybar": record.accounting.requiredBackingTinybar,
    "rail.policy.maximumAdvanceBps": record.policy.maximumAdvanceBps,
    "rail.policy.maximumAnnualRateBps": record.policy.maximumAnnualRateBps,
    "rail.policy.maximumQuoteMovementBps":
      record.policy.maximumQuoteMovementBps,
    "rail.policy.minimumTermSeconds": record.policy.minimumTermSeconds,
    "rail.policy.maximumTermSeconds": record.policy.maximumTermSeconds,
    "rail.policy.maximumOfferLifetimeSeconds":
      record.policy.maximumOfferLifetimeSeconds,
    "positions.repaidState": "REPAID",
    "positions.defaultedState": "DEFAULTED",
  };
  if (record.oracle) {
    requiredAssertions["oracle.kind"] = oracleEvidence.kind;
    requiredAssertions["oracle.priceUsdE8"] = oracleEvidence.priceUsdE8;
    requiredAssertions["oracle.confidenceUsdE8"] =
      oracleEvidence.confidenceUsdE8;
    requiredAssertions["oracle.observedAt"] = oracleEvidence.observedAt;
  } else {
    requiredAssertions["pyth.priceUsdE8"] = record.pyth.priceUsdE8;
    requiredAssertions["pyth.confidenceUsdE8"] = record.pyth.confidenceUsdE8;
    requiredAssertions["pyth.publishTime"] = record.pyth.publishTime;
  }
  for (const [key, expected] of Object.entries(requiredAssertions)) {
    if (stateProof.assertions[key] !== expected) {
      throw new Error(`Evidence state proof is missing assertion ${key}.`);
    }
  }
  if (
    !record.metrics ||
    !Number.isFinite(Date.parse(record.metrics.startedAt ?? "")) ||
    !Number.isFinite(Date.parse(record.metrics.completedAt ?? "")) ||
    !Number.isSafeInteger(record.metrics.elapsedMilliseconds) ||
    record.metrics.elapsedMilliseconds < 0 ||
    Date.parse(record.metrics.startedAt) >
      Date.parse(record.metrics.completedAt) ||
    Date.parse(record.metrics.completedAt) -
      Date.parse(record.metrics.startedAt) !==
      record.metrics.elapsedMilliseconds ||
    record.generatedAt !== record.metrics.completedAt ||
    record.metrics.mirrorConfirmedTransactions !== record.transactions.length
  ) {
    throw new Error("Evidence is missing valid lifecycle metrics.");
  }
  return record;
}
