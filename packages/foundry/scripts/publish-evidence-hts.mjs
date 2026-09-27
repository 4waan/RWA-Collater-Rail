import { spawn } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateHtsEvidenceRecord } from "./lib/hts-evidence-lib.mjs";

const profile = process.argv[2];
const profileConfig = {
  controlled: {
    settlementProfile: "controlled-test",
    candidate: "testnet-hts-controlled.json",
    reference: "reference-testnet-hts-controlled.json",
  },
  usdc: {
    settlementProfile: "circle-usdc",
    candidate: "testnet-hts-usdc.json",
    reference: "reference-testnet-hts-usdc.json",
  },
};
const selected = profileConfig[profile];
if (!selected) {
  throw new Error("HTS publication profile must be controlled or usdc.");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const foundryRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(foundryRoot, "../..");
const deploymentsDirectory = path.join(foundryRoot, "deployments");
const candidatePath = path.join(deploymentsDirectory, selected.candidate);
const referencePath = path.join(deploymentsDirectory, selected.reference);
const gitleaksConfigPath = path.join(repositoryRoot, ".gitleaks.toml");

async function run(command, args, failureMessage) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: foundryRoot,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", (error) => {
      reject(new Error(`${failureMessage}: ${error.message}`));
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(failureMessage));
    });
  });
}

const candidateText = await readFile(candidatePath, "utf8");
const candidate = validateHtsEvidenceRecord(JSON.parse(candidateText));
if (candidate.settlementProfile !== selected.settlementProfile) {
  throw new Error("HTS publication profile does not match the candidate.");
}
if (
  !candidate.positions.some(
    (position) =>
      position.state === "DEFAULTED" && position.terminalPath === "hss",
  )
) {
  throw new Error(
    "Published HTS evidence must include an observed HSS default.",
  );
}

const temporaryPath = path.join(
  deploymentsDirectory,
  `.${selected.reference}.${process.pid}.${Date.now()}.tmp`,
);
try {
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(scriptDirectory, "verify-deployment-hts.mjs"),
      candidatePath,
    ],
    "Live HTS verification rejected the evidence candidate.",
  );
  await run(
    "gitleaks",
    [
      "detect",
      "--config",
      gitleaksConfigPath,
      "--no-git",
      "--source",
      deploymentsDirectory,
      "--redact",
      "--exit-code",
      "1",
    ],
    "Gitleaks rejected the HTS evidence candidate.",
  );
  await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, referencePath);
} catch (error) {
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

console.log(`Published verified HTS evidence to ${referencePath}.`);
