# Compatibility matrix

The repository pins exact package versions in its manifests and lockfile. This
document records the protocol surfaces that require an explicit compatibility
decision rather than a blind dependency update.

## Version 1 baseline

- Node.js: 22.x, with CI on Node 22
- Yarn: 3.2.3
- Foundry: v1.5.1 for release CI, plus weekly validation against `stable`
- Solidity: 0.8.24
- EVM execution target: Cancun, matching the pinned ATS v8 deployment
- Hedera network: testnet, chain ID 296
- Hiero SDK: 2.86.2
- Hiero contracts: 0.2.0
- Next.js, React, wagmi, viem, and Playwright: exact manifest versions
- ATS: `v.8.0.0-ats` reduced runtime surface
- ATS Factory: `0xd1F118A40f3b02883D35909eF2517e7EDd78379d`
- ATS Resolver: `0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a`
- Default oracle mode: `hedera-exchange-rate`
- HIP-475 exchange-rate system contract: `0x168`
- HIP-475 exchange-rate system file: `0.0.112`
- Optional Pyth contract: `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`
- Optional Pyth HBAR/USD feed:
  `0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd`
- Public evidence: schema version 3

## Upgrade policy

Patch updates may merge after the complete release gate passes. Minor or major
updates to ATS, Hiero contracts, HSS, HIP-475, Pyth, viem, wagmi, or the evidence
schema also require:

1. an upstream source review;
2. an updated compatibility finding;
3. regression coverage for changed call or response semantics;
4. a clean generated-project run;
5. a new funded testnet lifecycle before release.

Dependabot proposes immutable GitHub Action and JavaScript package updates,
with Hiero packages isolated from ordinary JavaScript updates. The committed
Renovate configuration is restricted to Foundry and ATS release discovery and
labels both for manual compatibility review when the repository app is enabled.
The weekly compatibility canary tests the complete gate against current stable
Foundry, checks chain ID plus deployed Factory and Resolver bytecode, calls the
HIP-475 system contract for a positive default-mode conversion, and confirms
optional Pyth bytecode. The pinned ATS ABI fixture makes reviewed ATS surface
changes explicit. None of these automations makes a live transaction or
replaces the funded lifecycle gate.
