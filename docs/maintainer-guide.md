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

For the HTS rail, add these non-substitutable requirements:

- HTS balance covers `cashTokenLiabilities`.
- HBAR balance covers `reservedAutomation` independently.
- Every inbound and outbound HTS transfer produces the exact requested balance
  delta.
- Fixed, fractional, and royalty fee schedules fail closed at initialization
  and every later transfer.
- Empty returndata, facade bytecode, and low-level success never replace an HTS
  success response and the expected return shape.
- An ATS failure after an HTS transfer reverts the token movement and every rail
  state change in the same transaction.

For the experimental CLPR extension, preserve these separate requirements:

- Remote token balance covers remote cash liabilities.
- Hedera HBAR balance covers HSS automation reserves independently.
- The CLPR service, channel, stamped peer application, ledger domains, message
  version, terms hash, expiry, and semantic replay key are checked before state
  mutation.
- Financial state never depends on `onClprResponse`.
- Repayment release, default execution, and locked-offer cancellation are the
  only terminal ATS hold actions and are mutually exclusive per hold.
- An endpoint or relayer outage leaves outbox dispatch retryable. Unavailable
  peer proofs freeze ambiguous collateral instead of authorizing a timeout
  release.

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
11. Open every transaction, schedule, and contract link. Record the result in a
    dated finding. Mirror must identify the exact entity. Record HashScan
    availability separately from proof validity.

Keep two assurance classes explicit in every release note and public claim:

- **Observed on testnet** means the committed record contains the corresponding
  transaction or executed schedule plus its state proof.
- **Established by adversarial tests** means deterministic contract, runner,
  invariant, or evidence tests prove the recovery behavior without claiming a
  public network event.

The version 1 reference observed HSS execution on testnet. Permissionless
fallback is accepted through adversarial tests. Do not force HSS failure merely
to produce another record, do not cite a terminal no-op as fallback proof, and
do not replace the canonical HSS lifecycle with a synthetic outage scenario.

### HTS evidence profiles

The HTS extension uses two separate candidate and publication paths. Never copy
either record over `reference-testnet.json`.

- `controlled-test` creates a six-decimal token and exercises association, KYC,
  freeze, pause, allowance, recovery, repayment, and HSS default. Its fixed
  oracle is evidence of mechanics only.
- `circle-usdc` revalidates Circle testnet USDC `0.0.429274`, provisions small
  balances from the authorized operator, and uses the pinned live Pyth USDC/USD
  feed. This is the only stablecoin settlement demonstration.

Each record must bind native HTS transactions separately from EVM contract
transactions, prove exact token transfers through Mirror, verify one repayment
and one observed HSS default, show zero terminal token liabilities, and show the
rail's token balance and HBAR reserve independently. Current Mirror token
relationship proofs cover the lender, borrower, and rail. They must not make a
mutable operator balance part of long-lived verification.

An `eth_call` result is never an entity receipt. HashScan code verification is
not a substitute for live constructor, role, KYC, or hold reads.

## Frontend safety

The web app has no state-changing server route. Wallets sign user actions in the
browser. Issuer setup stays in Foundry. Only public addresses and the public RPC
URL may use `NEXT_PUBLIC_` names.

Keep external requests pinned to the Hedera testnet RPC, Hedera testnet Mirror
Node, and the configured wallet transport. Permit Pyth Hermes requests only in
explicit Pyth mode. Validate transaction IDs, hashes, addresses, and response
shapes before rendering links or evidence. Construct Mirror and HashScan paths
only after identifier validation. Never trust a stored origin, query string,
redirect, or path suffix.

## Consensus Node v0.77

`AccountBalanceQuery` is removed in Consensus Node v0.77. Keep the JavaScript
SDK pinned at 2.88.0 or a separately reviewed successor. Canonical evidence
continues to use direct Mirror REST account and token reads because those reads
include the identity and provenance fields required by the evidence schema.

Run `yarn check:balance-query-compat` after changing any SDK helper. Project
code may not call `AccountBalanceQuery`, `getAccountBalance`, `Client.ping`, or
`Client.pingAll`.

## CLPR compatibility and evidence

Run `yarn clpr:check-upstream` weekly and before changing a CLPR claim. This
checks pinned LFDT source digests but never advances a commit automatically.
Use the manual CLPR workflow for the heavy two-Besu and Besu-to-Solo jobs.

Do not copy an upstream run artifact into the repository. First convert it into
the typed CLPR evidence record, scan it for secrets, and run
`yarn clpr:verify-evidence <candidate-path>`. Publish only after both directions
of the local Besu lifecycle and the one supported Besu-to-Solo path are present.
Keep Solo-to-Besu in `notDemonstrated` until the upstream ProofService path is
actually observed.

## Release checklist

Run `yarn release:validate` from a clean checkout. Then scaffold the public
repository into a new temporary directory and run the same install, test,
build, Playwright, route, and secret gates there. Finally inspect the generated
README outro and reference mode with no environment file present.

Never publish a release while the committed evidence is pending, a workflow is
red, or the validation run changes a tracked or nonignored untracked repository
file.

For HSS assurance, the release passes when the verified record honestly proves
the terminal path that occurred and the adversarial fallback suites are green.
A separate funded fallback run is optional. It becomes public evidence only if
HSS naturally remains unavailable through the grace window and the runner
records a successful permissionless settlement receipt.

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

The HBAR rail remains the version 1.0 reference and immutable fallback. The
isolated HTS settlement rail is the version 1.1 candidate. CLPR is an isolated
experimental implementation and merges only after its deterministic and
upstream proof gates pass. An external KYC adapter follows only after
compatibility and security review of the confirmed upstream interface.
