# Increment: bounty evidence runner

Build a secure, repeatable Hedera testnet lifecycle command for Collateral Rail.

## Outcome

`yarn demo:testnet --recipe term-credit` must use the Harness-provided ephemeral signer as issuer and deployer, create temporary ECDSA lender and borrower accounts, deploy the configured ATS bond, oracle, rail, and acceptance verifier, and complete two financing positions. One position must be repaid and one must mature into default through HSS or the public fallback.

## Required behavior

1. Reject every network except Hedera testnet and allow only the documented Hashio and Mirror Node endpoints. Allow Hermes only in explicit Pyth mode.
2. Read `HARNESS_SIGNER_ACCOUNT_ID`, `HARNESS_SIGNER_EVM_ADDRESS`, and `HARNESS_SIGNER_PRIVATE_KEY` from the process environment. Never print, serialize, or pass a private key in command arguments.
3. Keep the existing encrypted Foundry keystore path available for local operators. The Harness path must use an in-process key and a secret-free command line.
4. Create lender and borrower ECDSA accounts in memory, fund them within a 250 HBAR total signer cap, and delete or sweep them after the run.
5. Honor configured ATS Factory, Resolver, oracle mode, RPC, and Mirror values after strict testnet validation. HIP-475 is the default.
6. In explicit Pyth mode only, validate Pyth and fetch a fresh HBAR/USD update from Hermes. Both oracle modes convert the HBAR cash leg only.
7. Open and accept two small, two-minute facilities with separate ATS holds.
8. Repay one facility. Let the other mature and record whether HSS or the public fallback settled it.
9. Confirm every transaction through Mirror Node. Confirm every real schedule from mined state and Mirror Node, never from a simulation.
10. Write only public account IDs, addresses, position IDs, hold IDs, schedule IDs, receipts, timestamps, results, state reads, and explorer links to the ignored run record.
11. Provide a publication command that verifies completeness, scans the candidate for secrets, and only then replaces `reference-testnet.json`.
12. Add deterministic tests for account-creation failure, funding caps, HIP-475 and Pyth evidence consistency, Pyth failures, HSS failure classification, Mirror pagination, duplicate transaction safety, and sweep failure.

## Acceptance

The normal unit, fuzz, invariant, ABI, formatting, type, build, route, secret, and browser gates remain green. The evidence runner tests pass without network credentials. A real Tier 3.5 run is allowed only through `.harness/testnet-spec.yaml` with a funded ECDSA testnet operator.
