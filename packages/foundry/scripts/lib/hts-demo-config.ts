import { facilityRecipes } from "@collateral-rail/shared/recipes";
import {
  ATS_FACTORY_ADDRESS,
  ATS_RESOLVER_ADDRESS,
  PYTH_ADDRESS,
} from "@collateral-rail/shared/hedera";
import type { Address, Hex } from "viem";
import {
  DEFAULT_HERMES_URL,
  DEFAULT_MIRROR_URL,
  DEFAULT_RPC_URL,
  readHarnessSigner,
  validatedEndpoint,
} from "./evidence-lib.mjs";
import { requireAddress } from "./demo-runtime.ts";
import { selectedHtsProfile } from "./hts-demo-runtime.ts";

export function readHtsDemoConfiguration(
  environment = process.env,
  argv = process.argv.slice(2),
) {
  if ((environment.HEDERA_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("The HTS evidence runner permits Hedera testnet only.");
  }
  const profile = selectedHtsProfile(argv);
  const rawSigner = readHarnessSigner(environment);
  const pythApiKey = environment.PYTH_API_KEY?.trim() ?? null;
  if (
    profile === "usdc" &&
    (!pythApiKey ||
      pythApiKey.length > 1_024 ||
      /[\u0000-\u001f\u007f]/u.test(pythApiKey))
  ) {
    throw new Error(
      "PYTH_API_KEY must contain a valid Hermes API key for Circle USDC.",
    );
  }
  const recipe = facilityRecipes.find(
    (candidate) => candidate.id === "hts-usdc-term-credit",
  );
  if (!recipe || recipe.settlement.kind !== "hts") {
    throw new Error("The canonical HTS USDC recipe is unavailable.");
  }
  return {
    profile,
    recipe,
    signer: {
      accountId: rawSigner.accountId as string,
      evmAddress: rawSigner.evmAddress as Address,
      privateKey: rawSigner.privateKey as Hex,
    },
    rpcUrl: validatedEndpoint(
      "rpc",
      environment.HEDERA_TESTNET_RPC_URL ?? DEFAULT_RPC_URL,
    ),
    mirrorUrl: validatedEndpoint(
      "mirror",
      environment.HEDERA_MIRROR_URL ?? DEFAULT_MIRROR_URL,
    ),
    hermesUrl: validatedEndpoint(
      "hermes",
      environment.PYTH_HERMES_URL ?? DEFAULT_HERMES_URL,
    ),
    pythApiKey,
    factory: requireAddress(
      "ATS Factory",
      environment.ATS_FACTORY_ADDRESS ?? ATS_FACTORY_ADDRESS,
    ),
    resolver: requireAddress(
      "ATS Resolver",
      environment.ATS_RESOLVER_ADDRESS ?? ATS_RESOLVER_ADDRESS,
    ),
    pyth: requireAddress("Pyth", environment.PYTH_ADDRESS ?? PYTH_ADDRESS),
  };
}
