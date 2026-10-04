# HTS arithmetic independent verification

Date: 2026-09-27

An untracked standalone verifier compared compiled `AtsCollateralRailHtsHarness` outputs with separately derived exact-integer formulas. The verifier lived outside the repository and did not import production arithmetic helpers or test formulas.

## Result

- Defects: none across 170 exact comparisons.
- Non-defect observations: the valid transfer domain ends at the signed 64-bit HTS amount limit enforced by the rail.
- Verified claims: debt valuation rounds upward, maximum token principal rounds downward, interest rounds upward, zero-rate repayment remains exact, and quote movement accepts the exact one percent boundary while rejecting a one-unit excess.
- Untested boundaries: amounts above the signed 64-bit HTS transfer limit were not treated as valid lifecycle inputs because the production rail rejects them before any precompile call.

## Constructed boundaries

- Settlement decimals: 0, 1, 6, 8, and 18.
- Prices: one USD E8 unit, values immediately below and above one dollar, exact one dollar, and a high bounded price.
- Token quantities: one smallest unit, exact decimal scale, one-unit remainder, and the maximum signed 64-bit transfer amount.
- Interest: zero rate, minimum nonzero interest, one-unit remainder, and maximum policy rate and term.
- Quote movement: exact negative and positive one percent boundaries and one-unit excesses on both sides.

The verification used a local-only Anvil process with an impersonated address. It used no private key, API key, network credential, or funded Hedera account.
