import { spawn } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventLogs } from "viem";
import type { TransactionReceipt } from "viem";
import { htsRailAbi } from "@collateral-rail/shared/abis";
import { redactSignerMaterial } from "./demo-runtime.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const foundryRoot = path.resolve(scriptDirectory, "../..");

export type HtsProfile = "controlled" | "usdc";

export const htsAddressesPath = path.join(
  foundryRoot,
  "deployments",
  "latest-hts-addresses.json",
);
export const htsBroadcastPath = path.join(
  foundryRoot,
  "broadcast",
  "BootstrapHtsTestnet.s.sol",
  "296",
  "run-latest.json",
);
export const HTS_PRINCIPAL_TOKEN_UNITS = 50_000_000n;
export const HTS_ACTOR_TOKEN_UNITS = 120_000_000n;
export const HTS_GAS = {
  initialize: 1_500_000n,
  oracleUpdate: 750_000n,
  tokenApproval: 250_000n,
  atsApproval: 500_000n,
  fundOffer: 1_500_000n,
  acceptOffer: 3_500_000n,
  withdrawal: 1_000_000n,
  repayment: 2_000_000n,
  settlement: 2_000_000n,
} as const;

export function selectedHtsProfile(argv = process.argv.slice(2)): HtsProfile {
  const inline = argv.find((value) => value.startsWith("--profile="));
  const index = argv.indexOf("--profile");
  const profile = inline
    ? inline.slice("--profile=".length)
    : index >= 0
      ? argv[index + 1]
      : null;
  if (profile !== "controlled" && profile !== "usdc") {
    throw new Error("The HTS profile must be controlled or usdc.");
  }
  return profile;
}

export function htsOutputPath(profile: HtsProfile) {
  return path.join(
    foundryRoot,
    "deployments",
    profile === "controlled"
      ? "testnet-hts-controlled.json"
      : "testnet-hts-usdc.json",
  );
}

export async function assertWritableHtsArtifactPath(
  filePath: string,
  profile: HtsProfile,
) {
  const resolved = path.resolve(filePath);
  const expected = htsOutputPath(profile);
  if (resolved !== expected) {
    throw new Error("HTS evidence output must use its ignored candidate path.");
  }
  await access(path.dirname(resolved), fsConstants.W_OK);
  try {
    const existing = await lstat(resolved);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("HTS evidence candidate path must be a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function runHtsFoundry(environment: NodeJS.ProcessEnv) {
  await new Promise<void>((resolve, reject) => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    const child = spawn(
      "forge",
      [
        "script",
        "script/BootstrapHtsTestnet.s.sol:BootstrapHtsTestnet",
        "--rpc-url",
        "hedera_testnet",
        "--broadcast",
        "--skip-simulation",
        "--slow",
        "--non-interactive",
      ],
      {
        cwd: foundryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 4_000_000) {
        child.kill("SIGKILL");
        reject(new Error("HTS Foundry bootstrap output exceeded the limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(output, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(errors, chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const stdout = redactSignerMaterial(
        Buffer.concat(output).toString("utf8"),
        environment,
      );
      const stderr = redactSignerMaterial(
        Buffer.concat(errors).toString("utf8"),
        environment,
      );
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `HTS Foundry bootstrap failed with ${signal ?? `exit ${code}`}.`,
          ),
        );
    });
  });
}

function oneEvent(
  receipt: Pick<TransactionReceipt, "logs">,
  eventName: "OfferFunded" | "PositionOpened" | "PositionDefaulted",
) {
  const events = parseEventLogs({
    abi: htsRailAbi,
    eventName,
    logs: receipt.logs,
    strict: false,
  });
  if (events.length !== 1) {
    throw new Error(
      `Expected one ${eventName} event, received ${events.length}.`,
    );
  }
  return events[0].args;
}

export function htsOfferFundedArgs(receipt: Pick<TransactionReceipt, "logs">) {
  return oneEvent(receipt, "OfferFunded") as { offerId: `0x${string}` };
}

export function htsPositionOpenedArgs(
  receipt: Pick<TransactionReceipt, "logs">,
) {
  return oneEvent(receipt, "PositionOpened") as {
    positionId: `0x${string}`;
  };
}
