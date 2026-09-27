import { spawnSync } from "node:child_process";
import { workingTreeSnapshot } from "./lib/working-tree-snapshot.mjs";

const scripts = [
  "format:check",
  "lint",
  "typecheck",
  "recipe:check",
  "check:dead-code",
  "foundry:build",
  "test:hts",
  "foundry:test",
  "foundry:fuzz",
  "foundry:invariant",
  "test:runner",
  "test:e2e",
  "test:e2e:live",
  "next:build",
  "test:e2e:production",
  "check:routes",
  "check:ats-abi",
  "check:secrets",
  "harness:validate",
];
const yarnCommand = process.platform === "win32" ? "yarn.cmd" : "yarn";

const initialSnapshot = workingTreeSnapshot();
let failedScript = null;

for (const script of scripts) {
  process.stdout.write(`\n[release] yarn ${script}\n`);
  const result = spawnSync(yarnCommand, [script], {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error || result.status !== 0) {
    failedScript = script;
    if (result.error) console.error(result.error.message);
    break;
  }
}

const finalSnapshot = workingTreeSnapshot();

if (initialSnapshot !== finalSnapshot) {
  console.error(
    "Release validation changed tracked files. Review the diff and run it again.",
  );
  process.exit(1);
}

if (failedScript) {
  console.error(`Release validation stopped at yarn ${failedScript}.`);
  process.exit(1);
}

console.log("Release validation passed without changing tracked files.");
