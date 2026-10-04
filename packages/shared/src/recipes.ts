import customFacility from "../recipes/custom-facility.json";
import htsUsdcTermCredit from "../recipes/hts-usdc-term-credit.json";
import maturityBridge from "../recipes/maturity-bridge.json";
import termCredit from "../recipes/term-credit.json";

export type RailPolicy = {
  maximumAdvanceBps: number;
  maximumAnnualRateBps: number;
  maximumQuoteMovementBps: number;
  minimumTermSeconds: number;
  maximumTermSeconds: number;
  maximumOfferLifetimeSeconds: number;
};

export type FacilityRecipe = {
  id: string;
  name: string;
  purpose: string;
  settlement:
    | { kind: "hbar" }
    | {
        kind: "hts";
        profile: "circle-usdc";
        tokenId: string;
        tokenAddress: `0x${string}`;
        symbol: string;
        decimals: number;
        oracle: "pyth-usdc-usd";
        priceFeedId: `0x${string}`;
      };
  policy: RailPolicy;
  defaultTerms: {
    collateralAmount: string;
    principalUsd: string;
    annualRateBps: number;
    termSeconds: number;
  };
  editableFields: string[];
  extensionNotes: string[];
};

function hbarRecipe<T extends Omit<FacilityRecipe, "settlement">>(recipe: T) {
  return { ...recipe, settlement: { kind: "hbar" as const } };
}

const htsRecipe = {
  ...htsUsdcTermCredit,
  settlement: {
    ...htsUsdcTermCredit.settlement,
    kind: "hts" as const,
    profile: "circle-usdc" as const,
    tokenAddress: htsUsdcTermCredit.settlement.tokenAddress as `0x${string}`,
    oracle: "pyth-usdc-usd" as const,
    priceFeedId: htsUsdcTermCredit.settlement.priceFeedId as `0x${string}`,
  },
};

export const facilityRecipes = [
  hbarRecipe(termCredit),
  hbarRecipe(maturityBridge),
  hbarRecipe(customFacility),
  htsRecipe,
] satisfies FacilityRecipe[];

export const defaultRecipe = facilityRecipes[0];

export function getRecipe(id: string | null | undefined): FacilityRecipe {
  return facilityRecipes.find((recipe) => recipe.id === id) ?? defaultRecipe;
}
