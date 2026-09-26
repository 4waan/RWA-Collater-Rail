import { facilityRecipes } from "@collateral-rail/shared/recipes";
import {
  ATS_FACTORY_ADDRESS,
  ATS_RESOLVER_ADDRESS,
  PYTH_ADDRESS,
} from "@collateral-rail/shared/hedera";
import {
  DEFAULT_HERMES_URL,
  DEFAULT_MIRROR_URL,
  DEFAULT_RPC_URL,
  readHarnessSigner,
  validatedEndpoint,
} from "./evidence-lib.mjs";
import { requireAddress, selectedRecipeId } from "./demo-runtime.ts";
import type { Address, Hex } from "viem";

export function readDemoConfiguration(
  environment = process.env,
  argv = process.argv.slice(2),
) {
  if ((environment.HEDERA_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("The evidence runner permits Hedera testnet only.");
  }

  const rawSigner = readHarnessSigner(environment);
  const recipeId = selectedRecipeId(argv);
  const recipe = facilityRecipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) {
    throw new Error(
      `Unknown recipe ${recipeId}. Available recipes: ${facilityRecipes.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  const signer = {
    accountId: rawSigner.accountId as string,
    evmAddress: rawSigner.evmAddress as Address,
    privateKey: rawSigner.privateKey as Hex,
  };
  const oracleKind =
    environment.DEMO_ORACLE_KIND?.trim() ?? "hedera-exchange-rate";
  if (!["hedera-exchange-rate", "pyth"].includes(oracleKind)) {
    throw new Error("DEMO_ORACLE_KIND must be hedera-exchange-rate or pyth.");
  }
  const pythApiKey = environment.PYTH_API_KEY?.trim() ?? null;
  const pythMode = oracleKind === "pyth";
  if (
    pythMode &&
    (!pythApiKey ||
      pythApiKey.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(pythApiKey))
  ) {
    throw new Error(
      "PYTH_API_KEY must contain a valid Pyth Hermes API key when the Pyth oracle is selected.",
    );
  }

  return {
    recipe,
    signer,
    rpcUrl: validatedEndpoint(
      "rpc",
      environment.HEDERA_TESTNET_RPC_URL ?? DEFAULT_RPC_URL,
    ),
    mirrorUrl: validatedEndpoint(
      "mirror",
      environment.HEDERA_MIRROR_URL ?? DEFAULT_MIRROR_URL,
    ),
    hermesUrl: pythMode
      ? validatedEndpoint(
          "hermes",
          environment.PYTH_HERMES_URL ?? DEFAULT_HERMES_URL,
        )
      : DEFAULT_HERMES_URL,
    pythApiKey,
    oracleKind: oracleKind as "hedera-exchange-rate" | "pyth",
    factory: requireAddress(
      "ATS Factory",
      environment.ATS_FACTORY_ADDRESS ?? ATS_FACTORY_ADDRESS,
    ),
    resolver: requireAddress(
      "ATS Resolver",
      environment.ATS_RESOLVER_ADDRESS ?? ATS_RESOLVER_ADDRESS,
    ),
    pyth: pythMode
      ? requireAddress("Pyth", environment.PYTH_ADDRESS ?? PYTH_ADDRESS)
      : (PYTH_ADDRESS as Address),
  };
}
