import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventLogs } from "viem";
import type { TransactionReceipt } from "viem";
import { htsRailAbi } from "@collateral-rail/shared/abis";
import { CIRCLE_TESTNET_USDC_TOKEN_ID } from "@collateral-rail/shared/hedera";
import { redactSignerMaterial } from "./demo-runtime.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const foundryRoot = path.resolve(scriptDirectory, "../..");

export type HtsProfile = "controlled" | "usdc";

const inheritedFoundryEnvironmentKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "FOUNDRY_PROFILE",
  "NO_COLOR",
  "FORCE_COLOR",
  "RUST_LOG",
] as const;

const configuredFoundryEnvironmentKeys = new Set([
  "HARNESS_SIGNER_ACCOUNT_ID",
  "HARNESS_SIGNER_EVM_ADDRESS",
  "HARNESS_SIGNER_PRIVATE_KEY",
  "HEDERA_NETWORK",
  "HEDERA_TESTNET_RPC_URL",
  "HEDERA_MIRROR_URL",
  "ATS_FACTORY_ADDRESS",
  "ATS_RESOLVER_ADDRESS",
  "PYTH_ADDRESS",
  "SETTLEMENT_TOKEN_ADDRESS",
  "USE_FIXED_TEST_ORACLE",
  "HEDERA_OPERATOR_ADDRESS",
  "LENDER_ADDRESS",
  "BORROWER_ADDRESS",
  "RAIL_MAXIMUM_ADVANCE_BPS",
  "RAIL_MAXIMUM_ANNUAL_RATE_BPS",
  "RAIL_MAXIMUM_QUOTE_MOVEMENT_BPS",
  "RAIL_MINIMUM_TERM_SECONDS",
  "RAIL_MAXIMUM_TERM_SECONDS",
  "RAIL_MAXIMUM_OFFER_LIFETIME_SECONDS",
]);

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
export const HTS_PRINCIPAL_TOKEN_UNITS = 4_000_000n;
export const HTS_ACTOR_TOKEN_UNITS = 9_000_000n;
export const HTS_GAS = {
  initialize: 1_500_000n,
  automationFunding: 500_000n,
  oracleUpdate: 750_000n,
  tokenApproval: 1_500_000n,
  atsApproval: 500_000n,
  fundOffer: 1_500_000n,
  acceptOffer: 3_500_000n,
  withdrawal: 1_000_000n,
  repayment: 2_000_000n,
  settlement: 2_000_000n,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertCircleUsdcPreflight(
  metadata: Record<string, unknown>,
  relationshipPayload: Record<string, unknown>,
) {
  const fees = isRecord(metadata.custom_fees)
    ? metadata.custom_fees
    : undefined;
  if (
    metadata.token_id !== CIRCLE_TESTNET_USDC_TOKEN_ID ||
    metadata.name !== "USD Coin" ||
    metadata.symbol !== "USDC" ||
    metadata.type !== "FUNGIBLE_COMMON" ||
    metadata.decimals !== "6" ||
    metadata.deleted !== false ||
    metadata.freeze_default !== false ||
    !isRecord(metadata.freeze_key) ||
    metadata.kyc_key !== null ||
    metadata.pause_key !== null ||
    metadata.pause_status !== "NOT_APPLICABLE" ||
    metadata.fee_schedule_key !== null ||
    !Array.isArray(fees?.fixed_fees) ||
    fees.fixed_fees.length !== 0 ||
    !Array.isArray(fees?.fractional_fees) ||
    fees.fractional_fees.length !== 0
  ) {
    throw new Error("Circle testnet USDC metadata failed preflight.");
  }

  const relationships = relationshipPayload.tokens;
  if (
    !Array.isArray(relationships) ||
    relationships.length !== 1 ||
    !isRecord(relationships[0])
  ) {
    throw new Error("The funded operator is not associated with Circle USDC.");
  }
  const relationship = relationships[0];
  const balance = String(relationship.balance ?? "");
  if (
    relationship.token_id !== CIRCLE_TESTNET_USDC_TOKEN_ID ||
    relationship.kyc_status !== "NOT_APPLICABLE" ||
    relationship.freeze_status !== "UNFROZEN" ||
    !/^\d+$/.test(balance)
  ) {
    throw new Error(
      "The funded operator Circle USDC relationship failed preflight.",
    );
  }
  if (BigInt(balance) < HTS_ACTOR_TOKEN_UNITS * 2n) {
    throw new Error(
      "The funded operator needs at least 18 Circle testnet USDC for this lifecycle.",
    );
  }
}

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

export function htsFoundryEnvironment(
  ambient: NodeJS.ProcessEnv,
  configured: NodeJS.ProcessEnv,
) {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedFoundryEnvironmentKeys) {
    if (ambient[key] !== undefined) environment[key] = ambient[key];
  }
  for (const [key, value] of Object.entries(configured)) {
    if (!configuredFoundryEnvironmentKeys.has(key)) {
      throw new Error(`Unexpected HTS Foundry environment key: ${key}.`);
    }
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export async function writeHtsEvidenceCandidateAtomic(
  filePath: string,
  profile: HtsProfile,
  contents: string,
) {
  await assertWritableHtsArtifactPath(filePath, profile);
  const resolved = path.resolve(filePath);
  const temporaryPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, resolved);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function bestEffortSweepTokenBalance({
  accountId,
  readBalance,
  sweep,
}: {
  accountId: string;
  readBalance: () => Promise<bigint>;
  sweep: (amount: bigint) => Promise<unknown>;
}) {
  try {
    const amount = await readBalance();
    if (amount < 0n) throw new Error("Negative token balance.");
    if (amount > 0n) await sweep(amount);
    return { accountId, amountTokenUnits: amount.toString(), swept: true };
  } catch {
    return { accountId, amountTokenUnits: null, swept: false };
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
