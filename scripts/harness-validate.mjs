import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function harnessSpec(hasTemplateManifest) {
  return hasTemplateManifest
    ? ".harness/spec.yaml"
    : ".harness/generated-spec.yaml";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const modulePath = fileURLToPath(import.meta.url);

if (invokedPath === modulePath) {
  const spec = harnessSpec(existsSync("template.json"));
  const result = spawnSync("hedera-harness", ["validate", spec], {
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
