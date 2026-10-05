import { readFile } from "node:fs/promises";

const addressPattern = /^0x[0-9a-f]{40}$/iu;
const bytes32Pattern = /^0x[0-9a-f]{64}$/iu;
const commitPattern = /^[0-9a-f]{40}$/u;
const integerPattern = /^(?:0|[1-9][0-9]*)$/u;
const forbiddenFieldPattern =
  /(private|secret|mnemonic|seed|signature|rawtransaction|key)/iu;
const observations = new Set([
  "observed-local-besu",
  "observed-besu-to-solo",
  "observed-hosted-testnet",
]);
const pinnedManifestUrl = new URL(
  "../../abi/clpr-upstream.json",
  import.meta.url,
);

function rejectForbiddenFields(value, path = "record") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenFieldPattern.test(key)) {
      throw new Error(`CLPR evidence contains forbidden field ${path}.${key}.`);
    }
    rejectForbiddenFields(nested, `${path}.${key}`);
  }
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`CLPR evidence has an invalid ${label}.`);
  }
}

function requireAddress(value, label) {
  if (!addressPattern.test(value ?? "")) {
    throw new Error(`CLPR evidence has an invalid ${label}.`);
  }
}

export async function validateClprEvidenceRecord(record) {
  rejectForbiddenFields(record);
  if (
    record?.schemaVersion !== 1 ||
    record?.evidenceKind !== "clpr-collateral-mobility" ||
    record?.status !== "verified-experimental"
  ) {
    throw new Error("CLPR evidence has an invalid schema identity or status.");
  }
  requireIsoTimestamp(record.generatedAt, "generation timestamp");

  const manifest = JSON.parse(await readFile(pinnedManifestUrl, "utf8"));
  const expectedPins = {
    specificationCommit: manifest.repositories.spec.commit,
    contractsCommit: manifest.repositories.contracts.commit,
    endpointCommit: manifest.repositories.endpoint.commit,
  };
  for (const [name, expected] of Object.entries(expectedPins)) {
    if (
      !commitPattern.test(record.upstream?.[name] ?? "") ||
      record.upstream[name] !== expected
    ) {
      throw new Error(`CLPR evidence does not match the pinned ${name}.`);
    }
  }

  if (
    !Array.isArray(record.observations) ||
    !record.observations.includes("observed-local-besu")
  ) {
    throw new Error(
      "CLPR evidence is missing the bidirectional local Besu observation.",
    );
  }
  if (!record.observations.includes("observed-besu-to-solo")) {
    throw new Error("CLPR evidence is missing the observed Besu-to-Solo path.");
  }
  for (const observation of record.observations) {
    if (!observations.has(observation))
      throw new Error("CLPR evidence contains an unknown observation kind.");
  }

  if (!Array.isArray(record.ledgers) || record.ledgers.length < 2) {
    throw new Error("CLPR evidence must identify both ledgers.");
  }
  for (const ledger of record.ledgers) {
    if (!ledger.domain || !ledger.chainId)
      throw new Error("CLPR ledger identity is incomplete.");
    requireAddress(ledger.clprService, "CLPR service address");
    requireAddress(ledger.application, "CLPR application address");
  }

  if (!Array.isArray(record.messages) || record.messages.length < 8) {
    throw new Error(
      "CLPR evidence has too few state-proven lifecycle messages.",
    );
  }
  const directions = new Set();
  const kinds = new Set();
  const identities = new Set();
  for (const message of record.messages) {
    if (!observations.has(message.observation))
      throw new Error("CLPR message observation is invalid.");
    if (
      !bytes32Pattern.test(message.channelId) ||
      !bytes32Pattern.test(message.mobilityId)
    ) {
      throw new Error("CLPR message binding is invalid.");
    }
    requireAddress(message.sourceService, "source service");
    requireAddress(message.destinationService, "destination service");
    requireAddress(message.sourceApplication, "source application");
    requireAddress(message.destinationApplication, "destination application");
    requireAddress(message.proofVerifier, "proof verifier");
    if (
      !integerPattern.test(message.messageId) ||
      !bytes32Pattern.test(message.bundleHash)
    ) {
      throw new Error("CLPR message proof identity is invalid.");
    }
    if (
      !integerPattern.test(message.sourceBlock) ||
      !integerPattern.test(message.destinationBlock)
    ) {
      throw new Error("CLPR message blocks are invalid.");
    }
    requireIsoTimestamp(message.observedAt, "message observation timestamp");
    const identity = `${message.observation}:${message.direction}:${message.messageId}:${message.bundleHash}`;
    if (identities.has(identity))
      throw new Error("CLPR evidence contains a duplicate message proof.");
    identities.add(identity);
    directions.add(`${message.observation}:${message.direction}`);
    kinds.add(message.messageKind);
  }
  if (
    !directions.has("observed-local-besu:A-to-B") ||
    !directions.has("observed-local-besu:B-to-A") ||
    !directions.has("observed-besu-to-solo:besu-to-solo")
  ) {
    throw new Error(
      "CLPR evidence does not prove every required observed direction.",
    );
  }
  for (const kind of [
    "OFFER_FUNDED",
    "COLLATERAL_LOCKED",
    "PRINCIPAL_WITHDRAWN",
    "REPAYMENT_ESCROWED",
    "REPAYMENT_ACCEPTED",
    "DEFAULT_CONFIRMED",
  ]) {
    if (!kinds.has(kind)) throw new Error(`CLPR evidence is missing ${kind}.`);
  }

  if (
    !bytes32Pattern.test(record.lifecycle?.repaymentMobilityId ?? "") ||
    !bytes32Pattern.test(record.lifecycle?.defaultMobilityId ?? "") ||
    record.lifecycle.repaymentMobilityId ===
      record.lifecycle.defaultMobilityId ||
    record.lifecycle.repaymentTerminalState !== "REPAID" ||
    record.lifecycle.defaultTerminalState !== "DEFAULTED"
  ) {
    throw new Error("CLPR evidence lifecycle is incomplete.");
  }

  for (const value of Object.values(record.accounting ?? {})) {
    if (!integerPattern.test(value))
      throw new Error("CLPR evidence accounting is invalid.");
  }
  if (
    BigInt(record.accounting.remoteTokenBalance) <
    BigInt(record.accounting.remoteCashLiabilities)
  ) {
    throw new Error("CLPR remote cash escrow is insolvent.");
  }
  if (
    BigInt(record.accounting.hederaHbarBalanceTinybar) <
    BigInt(record.accounting.reservedAutomationTinybar)
  ) {
    throw new Error("CLPR Hedera automation reserve is insolvent.");
  }

  if (!Array.isArray(record.exactState) || record.exactState.length < 2) {
    throw new Error("CLPR evidence is missing exact-block state reads.");
  }
  for (const state of record.exactState) {
    if (
      state.type !== "state" ||
      !integerPattern.test(state.blockNumber) ||
      !state.rpcOrigin
    ) {
      throw new Error("CLPR exact-block state proof is invalid.");
    }
  }

  for (const url of Object.values(record.sourceUrls ?? {})) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["github.com", "raw.githubusercontent.com"].includes(parsed.hostname)
    ) {
      throw new Error("CLPR evidence contains an invalid source URL.");
    }
  }
  if (!Object.keys(record.sourceUrls ?? {}).length)
    throw new Error("CLPR evidence has no source URLs.");
  if (!record.notDemonstrated?.includes("solo-to-besu")) {
    throw new Error(
      "CLPR evidence must disclose the unsupported Solo-to-Besu path.",
    );
  }
  if (
    !Array.isArray(record.limitations) ||
    record.limitations.length === 0 ||
    !record.notice
  ) {
    throw new Error("CLPR evidence is missing limitations or notice text.");
  }
  return true;
}
