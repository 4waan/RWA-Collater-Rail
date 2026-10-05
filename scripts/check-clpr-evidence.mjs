import { readFile } from "node:fs/promises";
import { validateClprEvidenceRecord } from "../packages/foundry/scripts/lib/clpr-evidence-lib.mjs";

const evidencePath = process.argv[2];
if (!evidencePath) {
  throw new Error(
    "Provide a CLPR evidence candidate path. No public CLPR observation is published until the required upstream runs succeed.",
  );
}

const record = JSON.parse(await readFile(evidencePath, "utf8"));
await validateClprEvidenceRecord(record);
console.log(`Verified experimental CLPR evidence at ${evidencePath}.`);
