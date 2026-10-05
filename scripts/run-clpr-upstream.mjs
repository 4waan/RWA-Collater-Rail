import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
const commands = {
  besu: ["test:e2e:besu", "--", "--maxWorkers=1", "--no-file-parallelism"],
  "solo-inbound": ["test:e2e:besu:solo"],
};

if (mode === "hosted") {
  throw new Error(
    "Hosted CLPR execution is not configured. Record an organizer-supported environment in issue #15 before adding a credentialed driver.",
  );
}
if (!commands[mode])
  throw new Error(`Unsupported CLPR mode: ${mode ?? "none"}.`);

const upstreamRoot = process.env.CLPR_CONTRACTS_ROOT;
if (!upstreamRoot || !path.isAbsolute(upstreamRoot)) {
  throw new Error("Set CLPR_CONTRACTS_ROOT to an absolute pinned checkout.");
}

const manifest = JSON.parse(
  await readFile("packages/foundry/abi/clpr-upstream.json", "utf8"),
);
const expectedCommit = manifest.repositories.contracts.commit;
const actualCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: upstreamRoot,
  encoding: "utf8",
});
if (
  actualCommit.status !== 0 ||
  actualCommit.stdout.trim() !== expectedCommit
) {
  throw new Error(`CLPR checkout must be at ${expectedCommit}.`);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24)
  throw new Error("Upstream CLPR tests require Node 24 or newer.");

const result = spawnSync("npm", ["run", ...commands[mode]], {
  cwd: upstreamRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  throw result.error ?? new Error(`CLPR ${mode} run exited ${result.status}.`);
}
