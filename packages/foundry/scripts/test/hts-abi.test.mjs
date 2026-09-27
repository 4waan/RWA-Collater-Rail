import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  fixedTestUsdOracleAbi,
  htsAcceptanceAbi,
  htsRailAbi,
  usdOracleAbi,
} from "@collateral-rail/shared/abis";

const foundryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function compiledAbi(relativeArtifact) {
  const artifact = JSON.parse(
    await readFile(path.join(foundryRoot, "out", relativeArtifact), "utf8"),
  );
  return artifact.abi;
}

function entryKey(entry) {
  return `${entry.type}:${entry.name ?? ""}:${(entry.inputs ?? [])
    .map((input) => input.type)
    .join(",")}`;
}

function normalized(entry) {
  const copy = JSON.parse(JSON.stringify(entry));
  const stripInternalTypes = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) stripInternalTypes(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    delete value.internalType;
    if (value.type === "event" && !("anonymous" in value)) {
      value.anonymous = false;
    }
    if (
      typeof value.type === "string" &&
      value.type !== "function" &&
      value.type !== "event" &&
      !("name" in value)
    ) {
      value.name = "";
    }
    for (const nested of Object.values(value)) stripInternalTypes(nested);
  };
  stripInternalTypes(copy);
  return copy;
}

function assertCanonicalSubset(exported, compiled) {
  const compiledByKey = new Map(
    compiled.map((entry) => [entryKey(entry), entry]),
  );
  for (const entry of exported) {
    const actual = compiledByKey.get(entryKey(entry));
    assert.ok(actual, `Compiled ABI is missing ${entryKey(entry)}.`);
    assert.deepEqual(normalized(entry), normalized(actual));
  }
}

test("HTS rail ABI export matches the compiled contract", async () => {
  const compiled = await compiledAbi(
    "AtsCollateralRailHts.sol/AtsCollateralRailHts.json",
  );
  assertCanonicalSubset(htsRailAbi, compiled);
});

test("generic USD oracle ABI export matches the compiled Pyth adapter", async () => {
  const compiled = await compiledAbi("PythUsdOracle.sol/PythUsdOracle.json");
  assertCanonicalSubset(usdOracleAbi, compiled);
});

test("fixed test oracle ABI export matches the compiled adapter", async () => {
  const compiled = await compiledAbi(
    "FixedTestUsdOracle.sol/FixedTestUsdOracle.json",
  );
  assertCanonicalSubset(fixedTestUsdOracleAbi, compiled);
});

test("HTS acceptance ABI export matches the compiled verifier", async () => {
  const compiled = await compiledAbi(
    "HtsRailAcceptance.sol/HtsRailAcceptance.json",
  );
  assertCanonicalSubset(htsAcceptanceAbi, compiled);
});

test("HTS mutation inventory stays explicitly covered", async () => {
  const compiled = await compiledAbi(
    "AtsCollateralRailHts.sol/AtsCollateralRailHts.json",
  );
  const actual = compiled
    .filter(
      (entry) =>
        entry.type === "function" &&
        entry.stateMutability !== "view" &&
        entry.stateMutability !== "pure",
    )
    .map((entry) => entry.name)
    .sort();
  const coverage = {
    acceptOffer: "fundAcceptRepayWithdraw",
    cancelOffer: "fundThenCancel",
    fundAutomation: "sponsorAutomation",
    fundOffer: "fundThenCancel",
    initializeSettlement: "deterministic setup tests",
    repay: "fundAcceptRepayWithdraw",
    schedulePosition: "hssDefault and publicFallback",
    settle: "hssDefault and publicFallback",
    withdraw: "fundAcceptRepayWithdraw",
    withdrawUnusedAutomation: "withdrawUnusedAutomation",
  };
  assert.deepEqual(actual, Object.keys(coverage).sort());
  assert.ok(Object.values(coverage).every((value) => value.length > 0));
});
