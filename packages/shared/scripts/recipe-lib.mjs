import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const recipesDirectory = path.join(packageRoot, "recipes");

export const HARD_POLICY_LIMITS = Object.freeze({
  maximumAdvanceBps: 7_000,
  maximumAnnualRateBps: 10_000,
  maximumQuoteMovementBps: 100,
  minimumTermSeconds: 120,
  maximumTermSeconds: 365 * 24 * 60 * 60,
  maximumOfferLifetimeSeconds: 24 * 60 * 60,
});

const policyKeys = Object.keys(HARD_POLICY_LIMITS);
const termKeys = [
  "collateralAmount",
  "principalUsd",
  "annualRateBps",
  "termSeconds",
];

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer.`);
  }
  return value;
}

export function validateRecipe(recipe, source = "recipe") {
  requirePlainObject(recipe, source);
  if (!/^[a-z][a-z0-9-]{2,48}$/.test(recipe.id ?? "")) {
    throw new Error(`${source}.id must be a lowercase recipe identifier.`);
  }
  for (const key of ["name", "purpose"]) {
    if (typeof recipe[key] !== "string" || recipe[key].trim().length < 3) {
      throw new Error(`${source}.${key} must be a descriptive string.`);
    }
  }

  const settlement = requirePlainObject(
    recipe.settlement,
    `${source}.settlement`,
  );
  if (settlement.kind === "hbar") {
    if (Object.keys(settlement).join(",") !== "kind") {
      throw new Error(`${source}.settlement contains unsupported HBAR fields.`);
    }
  } else if (settlement.kind === "hts") {
    const requiredKeys = [
      "decimals",
      "kind",
      "oracle",
      "priceFeedId",
      "profile",
      "symbol",
      "tokenAddress",
      "tokenId",
    ];
    if (Object.keys(settlement).sort().join(",") !== requiredKeys.join(",")) {
      throw new Error(
        `${source}.settlement must contain the complete HTS identity and oracle binding.`,
      );
    }
    if (
      settlement.profile !== "circle-usdc" ||
      settlement.tokenId !== "0.0.429274" ||
      settlement.tokenAddress.toLowerCase() !==
        "0x0000000000000000000000000000000000068cda" ||
      settlement.symbol !== "USDC" ||
      settlement.decimals !== 6 ||
      settlement.oracle !== "pyth-usdc-usd" ||
      settlement.priceFeedId.toLowerCase() !==
        "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a"
    ) {
      throw new Error(
        `${source}.settlement must match the pinned Circle testnet USDC and Pyth profile.`,
      );
    }
  } else {
    throw new Error(`${source}.settlement.kind must be hbar or hts.`);
  }

  const policy = requirePlainObject(recipe.policy, `${source}.policy`);
  if (
    Object.keys(policy).sort().join(",") !== [...policyKeys].sort().join(",")
  ) {
    throw new Error(
      `${source}.policy must contain exactly the supported policy fields.`,
    );
  }
  for (const key of policyKeys) {
    requireInteger(policy[key], `${source}.policy.${key}`);
  }
  if (
    policy.maximumAdvanceBps <= 0 ||
    policy.maximumAdvanceBps > HARD_POLICY_LIMITS.maximumAdvanceBps
  ) {
    throw new Error(
      `${source}.policy.maximumAdvanceBps is outside the safe envelope.`,
    );
  }
  if (
    policy.maximumAnnualRateBps < 0 ||
    policy.maximumAnnualRateBps > HARD_POLICY_LIMITS.maximumAnnualRateBps
  ) {
    throw new Error(
      `${source}.policy.maximumAnnualRateBps is outside the safe envelope.`,
    );
  }
  if (
    policy.maximumQuoteMovementBps < 0 ||
    policy.maximumQuoteMovementBps > HARD_POLICY_LIMITS.maximumQuoteMovementBps
  ) {
    throw new Error(
      `${source}.policy.maximumQuoteMovementBps is outside the safe envelope.`,
    );
  }
  if (policy.minimumTermSeconds < HARD_POLICY_LIMITS.minimumTermSeconds) {
    throw new Error(
      `${source}.policy.minimumTermSeconds is below the kernel minimum.`,
    );
  }
  if (
    policy.maximumTermSeconds < policy.minimumTermSeconds ||
    policy.maximumTermSeconds > HARD_POLICY_LIMITS.maximumTermSeconds
  ) {
    throw new Error(
      `${source}.policy.maximumTermSeconds is outside the safe envelope.`,
    );
  }
  if (
    policy.maximumOfferLifetimeSeconds <= 0 ||
    policy.maximumOfferLifetimeSeconds >
      HARD_POLICY_LIMITS.maximumOfferLifetimeSeconds
  ) {
    throw new Error(
      `${source}.policy.maximumOfferLifetimeSeconds is outside the safe envelope.`,
    );
  }

  const terms = requirePlainObject(
    recipe.defaultTerms,
    `${source}.defaultTerms`,
  );
  if (Object.keys(terms).sort().join(",") !== [...termKeys].sort().join(",")) {
    throw new Error(
      `${source}.defaultTerms must contain exactly the supported term fields.`,
    );
  }
  for (const key of ["collateralAmount", "principalUsd"]) {
    if (!/^\d+(\.\d+)?$/.test(terms[key] ?? "") || Number(terms[key]) <= 0) {
      throw new Error(
        `${source}.defaultTerms.${key} must be a positive decimal string.`,
      );
    }
  }
  requireInteger(terms.annualRateBps, `${source}.defaultTerms.annualRateBps`);
  requireInteger(terms.termSeconds, `${source}.defaultTerms.termSeconds`);
  if (
    terms.annualRateBps < 0 ||
    terms.annualRateBps > policy.maximumAnnualRateBps
  ) {
    throw new Error(
      `${source}.defaultTerms.annualRateBps exceeds the recipe policy.`,
    );
  }
  if (
    terms.termSeconds < policy.minimumTermSeconds ||
    terms.termSeconds > policy.maximumTermSeconds
  ) {
    throw new Error(
      `${source}.defaultTerms.termSeconds exceeds the recipe policy.`,
    );
  }

  if (
    !Array.isArray(recipe.editableFields) ||
    recipe.editableFields.length === 0 ||
    recipe.editableFields.some((field) => !termKeys.includes(field))
  ) {
    throw new Error(
      `${source}.editableFields must name supported term fields.`,
    );
  }
  if (
    !Array.isArray(recipe.extensionNotes) ||
    recipe.extensionNotes.length === 0 ||
    recipe.extensionNotes.some(
      (note) => typeof note !== "string" || note.length < 10,
    )
  ) {
    throw new Error(`${source}.extensionNotes must contain useful guidance.`);
  }
  return recipe;
}

export async function loadRecipes() {
  const filenames = (await readdir(recipesDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const recipes = [];
  const ids = new Set();
  for (const filename of filenames) {
    const source = path.join(recipesDirectory, filename);
    const recipe = validateRecipe(
      JSON.parse(await readFile(source, "utf8")),
      filename,
    );
    if (ids.has(recipe.id))
      throw new Error(`Duplicate recipe id: ${recipe.id}.`);
    ids.add(recipe.id);
    recipes.push(recipe);
  }
  if (recipes.length === 0)
    throw new Error("At least one financing recipe is required.");
  return recipes;
}

export async function loadRecipe(id = "term-credit") {
  const recipes = await loadRecipes();
  const recipe = recipes.find((candidate) => candidate.id === id);
  if (!recipe) {
    throw new Error(
      `Unknown recipe ${id}. Available recipes: ${recipes.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  return recipe;
}
