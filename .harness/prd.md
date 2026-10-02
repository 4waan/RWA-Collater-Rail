# RWA Credit Rail maintenance PRD

## Goal

Maintain a reusable Scaffold-HBAR template for bilateral HBAR financing against
an ATS-issued security. Preserve the difficult integration guards and make any
new behavior independently verifiable.

## Who it is for

- Hedera developers who need a focused ATS financing reference.
- Maintainers who need source, measurement, and assumption discipline.
- Reviewers who need to reconstruct a facility through contract and Mirror data.

## Existing app to preserve

- `/` architecture, integration health, setup, and honest reference status.
- `/facility` typed oracle, lender, borrower, collateral, repayment, and recovery actions.
- `/verify` live position, free and held balance, and Mirror receipt checks.
- Foundry unit, fuzz, and stateful invariant suites.
- Secret-free reference mode and encrypted-keystore bootstrap.

## Product rules

1. HIP-475 is the default HBAR cash conversion source and is a network
   settlement rate, not a live market price. Pyth is an explicit optional cash
   conversion source. Neither source prices the ATS security.
2. The rail performs complete local policy before calling ATS Holds.
3. Clearing stays disabled for the issued security.
4. HSS failure never removes the public recovery path.
5. User HBAR and automation reserves remain fully backed.
6. The web app never receives an issuer or operator key.
7. Testnet evidence is not marked verified until receipts and live reads pass.

## Non-goals

- Do not add an order book, pooled lending, auctions, privacy, HCS relay, or HTS cash.
- Do not switch from Foundry, Next.js, or Yarn.
- Do not add a keeper as a correctness dependency.
- Do not commit secrets or a generated `.env` file.

## Deterministic acceptance

All static, command, route, secret, ABI, and reference-record validators pass.
Contract tests preserve terminality and solvency. The production app builds and
all three routes render without credentials.
