import { readFile } from "node:fs/promises";
import { validateEvidenceRecord } from "../packages/foundry/scripts/lib/evidence-lib.mjs";

const path = "packages/foundry/deployments/reference-testnet.json";
const record = JSON.parse(await readFile(path, "utf8"));
const lifecycleValues = Object.values(record.lifecycle ?? {});
const deployedAddressValues = ["atsToken", "oracle", "rail", "acceptance"].map(
  (name) => record.addresses?.[name],
);
const actorValues = ["issuer", "lender", "borrower"].map(
  (name) => record.actors?.[name],
);

if (record.schemaVersion !== 3) {
  throw new Error("Reference evidence must use schema version 3.");
}
if (record.status === "verified") {
  validateEvidenceRecord(record);
} else if (
  record.status !== "awaiting-verified-publication" ||
  record.generatedAt !== null ||
  record.recipeId !== null ||
  record.policy !== null ||
  deployedAddressValues.some((value) => value !== null) ||
  actorValues.some((value) => value !== null) ||
  lifecycleValues.some((value) => value !== null) ||
  record.oracle !== null ||
  record.pyth !== null ||
  record.ats !== null ||
  record.accounting !== null ||
  record.verification?.complete !== false ||
  record.verification?.state !== null ||
  record.verification?.mirrorOrigin !==
    "https://testnet.mirrornode.hedera.com" ||
  Object.keys(record.verification?.contractLinks ?? {}).length !== 0 ||
  record.metrics !== null ||
  (record.transactions ?? []).length !== 0 ||
  (record.positions ?? []).length !== 0 ||
  (record.holds ?? []).length !== 0 ||
  (record.schedules ?? []).length !== 0
) {
  throw new Error(
    "Pending reference evidence must remain explicitly incomplete.",
  );
}

console.log(`Reference record status: ${record.status}`);
