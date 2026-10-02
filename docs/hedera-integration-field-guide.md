# Hedera Integration Field Guide

This guide contains only findings that change the RWA Credit Rail design. A
status tells you how strong the claim is:

- `source-read`: confirmed in the upstream implementation or official API.
- `measured`: reproduced against Hedera testnet behavior.
- `derived`: a conservative design consequence of source-read or measured facts.
- `pending-measurement`: encoded defensively but not yet reproduced by the
  submission lifecycle.

The committed reference record starts incomplete. A measurement that depends on
live infrastructure must be reproduced before the record is marked verified.

## 1. Holds and Clearing are mutually exclusive rails

**Status:** source-read

**Failure mode:** An ATS security configured for Clearing cannot also be treated
as a Holds instrument. Deploying both expectations produces a token that cannot
serve this workflow.

**Template consequence:** The bond bootstrap sets `clearingActive: false`. The
acceptance verifier, final evidence read, and publication verifier all require
Clearing to remain disabled. The template never calls a Clearing facet.

**Guard and test:** `.harness/validators/static.json` asserts the literal
configuration. `BootstrapTestnet.s.sol` is compiled in every Foundry build.

**Primary source:** ATS hold and clearing facets in the
[Asset Tokenization Studio repository](https://github.com/hashgraph/asset-tokenization-studio/tree/v.8.0.0-ats/packages/ats/contracts/contracts/facets).

## 2. Hold creation is not facility compliance

**Status:** source-read

**Failure mode:** Developers may infer that a successful hold creation proves
the borrower, lender, term, valuation policy, and cash quote were valid. The ATS
hold operation does not enforce this facility policy.

**Template consequence:** `acceptOffer` performs both KYC reads, coverage,
allowance, free balance, maturity, quote movement, self-dealing, and expiry checks
before the hold call.

**Guard and test:** `testLocalPolicyRejectsMissingBorrowerKycBeforeHold` asserts
that no hold is created when local policy fails.

**Primary source:** ATS
[hold implementation](https://github.com/hashgraph/asset-tokenization-studio/tree/v.8.0.0-ats/packages/ats/contracts/contracts/facets/holdByPartition).

## 3. Hold execution does not supply a trustworthy compliance amount

**Status:** source-read

**Failure mode:** An ATS compliance seam cannot be assumed to receive the exact
economic amount being executed from a hold.

**Template consequence:** The rail never delegates facility amount policy to an
ATS compliance callback. It stores the opening amount, then re-reads and
revalidates the position-tagged hold immediately before a terminal action. ATS
balance adjustments may change the live amount, so the rail drains the current
amount and requires a post-call read to show no residual hold.

**Guard and test:** Upward and downward adjustment tests cover repayment and
default. Residual-response tests prove that a nominally successful ATS call
reverts the complete rail transition when any hold remains.

**Primary source:** ATS hold execution path in the
[upstream contracts](https://github.com/hashgraph/asset-tokenization-studio/tree/v.8.0.0-ats/packages/ats/contracts/contracts/facets/hold).

## 4. Free and held balances are different values

**Status:** source-read

**Failure mode:** `balanceOfByPartition` excludes encumbered units. Presenting it
as a holder's complete position makes collateral appear to disappear.

**Template consequence:** `/verify` reads and labels free and held balances
independently. The ATS reduced ABI includes both reads.

**Guard and test:** `testFundAndAcceptCreatesOneValidatedHold` asserts that ten
units move from free to held without changing the economic position.

**Testnet evidence:** The reference lifecycle requires a free-and-held read at
hold creation before `liveConfigurationRead` may be populated.

## 5. ATS external calls need a local reentrancy guard

**Status:** derived

**Failure mode:** A large external contract surface should not be trusted to
preserve local call ordering, even when the current implementation has no known
callback at that point.

**Template consequence:** Every ATS mutation and every HBAR liability mutation
uses `ReentrancyLock`.

**Guard and test:** `testAtsCallbackCannotReenterAcceptance` installs an
adversarial mock callback and proves the second entry fails.

**Primary source:** Solidity's
[security guidance on reentrancy](https://docs.soliditylang.org/en/latest/security-considerations.html#reentrancy).

## 6. Internal KYC depends on SSI issuer ordering

**Status:** source-read

**Failure mode:** A KYC grant can fail when the credential issuer has not first
been registered or when the caller lacks `ROLE_KYC` and `ROLE_SSI_MANAGER`.

**Template consequence:** The factory assigns both roles. Bootstrap calls
`addIssuer(operator)` before either `grantKyc`, then issues collateral only after
both grants.

**Guard and test:** The static Harness validator asserts the call ordering and
`_validateLiveConfiguration` reads issuer membership and both KYC states.

**Primary sources:** ATS
[KYC interface](https://github.com/hashgraph/asset-tokenization-studio/blob/v.8.0.0-ats/packages/ats/contracts/contracts/facets/kyc/IKyc.sol) and
[SSI management interface](https://github.com/hashgraph/asset-tokenization-studio/blob/v.8.0.0-ats/packages/ats/contracts/contracts/facets/ssiManagement/ISsiManagement.sol).

## 7. Published ATS documentation can lag the live deployment

**Status:** source-read

**Failure mode:** A documented address may be stale, undeployed, or paired with
a different resolver configuration.

**Template consequence:** Bootstrap validates Resolver and Factory code before
spending HBAR. It validates Pyth code only when Pyth mode is explicitly
selected. The default lifecycle checks HIP-475 through the selected adapter. The
verifier checks deployed entities through Mirror Node rather than treating
documentation as evidence.

**Guard and test:** `verify-deployment.mjs` rejects missing Mirror entities and
empty transaction results. The reference record stays pending until it passes.

**Primary source:** Hedera
[Mirror Node REST API](https://docs.hedera.com/hedera/sdks-and-apis/rest-api).

## 8. HSS reports failures with response codes

**Status:** source-read

**Failure mode:** `scheduleCall` is not a normal revert-only interface. A failed
operation may return a non-success response and a zero address.

**Template consequence:** The rail inherits `HederaScheduleService` and accepts
a schedule only when response code is 22 and the address is nonzero. Every
failure becomes `UNAVAILABLE` without reverting acceptance.

**Guard and test:** `testBadHssResponseDoesNotTrapCollateral` returns a non-22
code for all attempts and proves the hold remains recoverable.

**Observed on testnet:** The committed reference lifecycle records HSS schedule
`0.0.10730732` executing the matured default. Permissionless recovery for the
failure mode above is established by adversarial tests, not presented as a
second observed network event.

**Primary source:** Official
[`HederaScheduleService.sol`](https://www.npmjs.com/package/@hiero-ledger/hiero-contracts) and
[HIP-1215](https://hips.hedera.com/hip/hip-1215).

## 9. Consensus time and EVM time can cross a second boundary

**Status:** pending-measurement

**Failure mode:** A schedule targeting the exact maturity second can execute in
that consensus second while the contract still observes an earlier
`block.timestamp`, causing a maturity check to fail.

**Template consequence:** Capacity is tried at maturity plus 2, 5, and 10
seconds. `settle` still checks maturity and remains retryable.

**Guard and test:** `testHssTriesTwoFiveAndTenSecondCapacitySlots` checks the
actual requested seconds. `testDefaultCannotExecuteBeforeMaturity` protects the
other side of the boundary.

**Testnet evidence:** A new release must reproduce the scheduled callback and
record both consensus timestamp and observed EVM timestamp in a measured finding.

## 10. Simulated entity addresses are not deployment evidence

**Status:** derived

**Failure mode:** A static call can return a predicted entity address without a
mined transaction, receipt, or durable entity.

**Template consequence:** The bootstrap writes addresses only after broadcast.
The public record builder uses mined transaction hashes, and the verifier requires
Mirror confirmation. The UI never persists a schedule address from simulation.

**Guard and test:** `check-reference-record.mjs` rejects a `verified` record with
missing receipts. `verify-deployment.mjs` rejects addresses without Mirror entities.

**Primary source:** Hedera's distinction between
[contract calls and contract call queries](https://docs.hedera.com/hedera/sdks-and-apis/sdks/smart-contracts/call-a-smart-contract-function).

## 11. HashScan verification proves code, not configuration

**Status:** derived

**Failure mode:** Matching runtime bytecode does not prove current roles, KYC,
constructor inputs, token maturity, partition, or oracle binding.

**Template consequence:** Deployment acceptance includes direct immutable,
role, Clearing, token-decimal, nominal-value, nominal-decimal, currency, and
counterparty KYC reads. HashScan links are supporting navigation, not the state
oracle.

**Guard and test:** `_validateLiveConfiguration` and `verify-deployment.mjs`
require role and immutable values before the lifecycle can be complete.

**Primary source:** Hedera
[smart contract verification documentation](https://docs.hedera.com/hedera/core-concepts/smart-contracts/verifying-smart-contracts-beta).

## 12. Mirror pagination and HTTP 200 need interpretation

**Status:** pending-measurement

**Failure mode:** HTTP 200 can contain an empty transaction list, and list
endpoints may represent only the first page.

**Template consequence:** `/verify` rejects a 200 response with no matching
transaction and exposes response link metadata. Scripted verification follows
`links.next` only on the fixed Mirror origin and enforces a page limit.

**Guard and test:** Playwright route coverage checks the verification warning.
`verify-deployment.mjs` tests both nonempty results and bounded pagination.

**Primary source:** Hedera
[Mirror Node API reference](https://docs.hedera.com/hedera/sdks-and-apis/rest-api).

## 13. Hedera EVM native units must be explicit

**Status:** source-read

**Failure mode:** Ethereum JSON RPC transaction values use 18-decimal weibars.
Hedera EVM `msg.value`, `address.balance`, and contract cash amounts use
8-decimal tinybars. Mirror account balances are already tinybars. Treating
these boundaries as one unit causes a 10,000,000,000-fold error.

**Template consequence:** Public fields and events use the `Tinybar` suffix. The
constants name both sides. Client writes multiply tinybars by
`WEIBAR_PER_TINYBAR`, and RPC balance reads require exact division. USD and
price values use an `E8` suffix.

**Guard and test:** `testFuzzConversionAndInterestRoundUp` checks cash
conversion and interest. Runner tests keep block-bound contract reads separate
from the current Mirror balance proof and reject malformed, unavailable, or
insolvent balance responses.

**Primary source:** Hedera
[Ethereum transaction unit reference](https://docs.hedera.com/hedera/sdks-and-apis/sdks/smart-contracts/ethereum-transaction).

## 14. Settlement conversion is not an RWA valuation feed

**Status:** derived

**Failure mode:** Using any HBAR/USD conversion to claim a market price for a
bond would combine unrelated facts and overstate the oracle's role. Describing
the HIP-475 network settlement conversion rate as a live market price would also
misstate what the system contract provides.

**Template consequence:** The default adapter uses HIP-475 to convert
`principalUsdE8` into tinybar from the active network settlement conversion
rate. The optional Pyth adapter performs the same cash conversion with a fresh,
confidence-bounded market feed. Collateral coverage uses configured ATS nominal
value and a recipe-selected advance that cannot exceed 70%. The evidence kind
controls the public label, caveat, and proof source.

**Guard and test:** `testPreviewUsesHaircutConversionAndConservativeInterest`
checks both calculations as separate outputs. HIP-475 tests enforce conversion,
zero and malformed response handling, and the network-rate boundary. Pyth tests
enforce freshness, positive value, exponent normalization, exact update fee,
and confidence width. Evidence tests reject cross-mode proof claims.

**Primary sources:** [HIP-475](https://hips.hedera.com/hip/hip-475) and Pyth
[price feed documentation](https://docs.pyth.network/price-feeds/core/use-real-time-data/evm).
