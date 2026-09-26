# Maintainer guide

## Before changing a Hedera integration

Write down whether the behavior is source-read, measured on testnet, derived
from those facts, or still assumed. Ethereum intuition is not evidence for
Hedera system contracts, timestamps, native value units, or Mirror responses.

If an ATS method is added, update `docs/ats-call-surface.md`, the reduced
interface, the pinned ABI list, and its regression test in the same change.

## Invariants that may not move

- HBAR balance covers cash liabilities and HSS reserves.
- One accepted offer creates one position and one hold.
- A hold has at most one terminal action.
- Every terminal path revalidates the adjustment-aware hold and leaves no
  position-tagged amount behind.
- Terminal positions never reopen.
- Default cannot execute before maturity.
- Failed HSS scheduling leaves public settlement available.
- Failed ATS calls leave no partial rail state.
- Owner recovery never touches lender or borrower funds.

## Testnet evidence procedure

1. Supply the capped funded operator only to the manual Harness testnet run.
2. Let Harness create and expose its ephemeral signer in process memory. Never
   place either key in an argument, file, log, or evidence field.
3. Preserve the Foundry broadcast artifact outside Git.
4. Confirm every transaction through Mirror Node.
5. Read ATS roles, KYC, Clearing mode, decimals, nominal configuration,
   maturity, free balance, held balance, both opening hold details, and both
   terminal hold deletions at exact blocks.
6. Read the immutable policy, typed oracle source and values, liabilities, HSS
   reserve, and final backing at the recorded verification block. HIP-475 must
   use a state proof and must not cite a Pyth update transaction. Pyth mode must
   bind its update transaction, feed, price, confidence, and publish time.
7. Confirm the real schedule address through Mirror Node. Require a non-null
   execution timestamp before attributing a terminal action to HSS.
8. Bind funding, acceptance, repayment, and fallback claims to decoded receipt
   events from the expected rail and ATS token.
9. Populate a typed lifecycle proof only after the corresponding probe passes.
10. Publish through the atomic candidate validator. Never copy a partial record
    by hand.

An `eth_call` result is never an entity receipt. HashScan code verification is
not a substitute for live constructor, role, KYC, or hold reads.

## Frontend safety

The web app has no state-changing server route. Wallets sign user actions in the
browser. Issuer setup stays in Foundry. Only public addresses and the public RPC
URL may use `NEXT_PUBLIC_` names.

Keep external requests pinned to the Hedera testnet RPC, Hedera testnet Mirror
Node, and the configured wallet transport. Permit Pyth Hermes requests only in
explicit Pyth mode. Validate transaction IDs, hashes, addresses, and response
shapes before rendering links or evidence.

## Release checklist

Run `yarn release:validate` from a clean checkout. Then scaffold the public
repository into a new temporary directory and run the same install, test,
build, Playwright, route, and secret gates there. Finally inspect the generated
README outro and reference mode with no environment file present.

Never publish a release while the committed evidence is pending, a workflow is
red, or the validation run changes a tracked or nonignored untracked repository
file.

## Versioning and compatibility

Use semantic versioning. A recipe addition that stays inside the existing
policy envelope is a minor change. A bug fix that preserves public interfaces is
a patch. Any contract ABI, recipe schema, evidence schema, or trust-boundary
change requires a documented migration and is normally a major change.

Keep an evidence reader compatible with the previous major schema for one major
release. Contracts are immutable, so never present a newly deployed address as
an in-place upgrade of an older rail.

Review the compatibility matrix before updating ATS, Hiero contracts, HSS,
HIP-475 handling, Pyth, viem, wagmi, Foundry, or Solidity. These updates require
a fresh funded testnet lifecycle after local and generated-project gates pass.

## Maintenance cadence

- Run the credential-free compatibility canary weekly.
- Triage reproducible installation and integration defects within five business
  days.
- Run a funded Harness lifecycle after material integration changes and before
  every tagged release.
- Convert Hedera-specific surprises into a measured finding, regression test,
  and upstream issue when appropriate.
- Deprecate an interface in documentation before removing it in the next major
  version.

Long-lived funded keys are not stored in CI. Live validation uses a capped
operator supplied only to the manual Harness run.

## Extension order

The HBAR rail remains the version 1 reference. After its tagged submission, the
next contract is an isolated HTS settlement rail. An external KYC adapter follows
only after compatibility and security review of the confirmed upstream
interface. CLPR remains an experimental RFC
until its proof and recovery contracts are stable.
