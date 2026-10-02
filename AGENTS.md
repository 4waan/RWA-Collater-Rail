# Agent rules

## Product boundary

RWA Credit Rail is a bilateral HBAR financing scaffold. It is not an exchange,
an order book, a pooled lender, or a valuation engine. The configured oracle
converts the USD cash terms to HBAR. HIP-475 is the default and exposes a network
settlement conversion rate, not a live market price. Pyth is optional and must
be explicitly configured. Neither source prices the ATS security.

Financing flexibility belongs in validated recipe definitions. Do not duplicate
the facility interface or weaken the custody, solvency, oracle, automation, or
terminal-state rules to add a product label.

## Evidence discipline

- Never infer Hedera behavior solely from Ethereum conventions.
- Label protocol claims as source-read, measured, derived, or assumed.
- Verify deployed state with Mirror Node and contract reads. A simulated address
  is never deployment evidence.
- HashScan verification proves runtime code. It does not prove live roles,
  constructor inputs, or current KYC state.
- Treat HTTP 200 responses and partial Mirror Node pages as transport outcomes,
  not proof that the requested entity or complete result set exists.
- Preserve the distinction between transaction, HSS schedule, and block-anchored
  state proofs. Never substitute a later no-op transaction for an earlier HSS
  execution.
- Replace the public reference record only after schema validation, proof
  relationship checks, and secret scanning all pass.

## Invariant model

Treat an invariant as a property plus every call stack that can mutate the
property. A passing happy-path test is not an invariant proof.

### Maintained mutation matrix

Keep this matrix synchronized with the contract and invariant handler. Any new
or changed mutating selector must update the matrix, its adversarial callback
tests, the targeted handler selector set, and the exact ghost assertions in the
same change.

```text
Selector                    | Protected properties                          | External surfaces
fundOffer                   | offer, sequence, balance, cash liability       | ATS KYC and maturity, oracle
cancelOffer                 | offer, lender credit                           | none
acceptOffer                 | offer, position, credit, hold, HSS reserve     | ATS reads and create, oracle, self-call, HSS
repay                       | position, credit, liability, hold, balance     | ATS reads and release
settle, public              | position, HSS reserve, hold                    | ATS KYC and reads, execute
settle, scheduled HSS       | position, HSS reserve, hold                    | HSS callback, ATS KYC and reads, execute
withdraw                    | caller credit, liability, balance              | recipient receive callback
fundAutomation              | balance                                       | none
withdrawUnusedAutomation    | unreserved balance                            | recipient receive callback
schedulePosition, self only | external HSS schedule                         | self-call gate, HSS system contract
receive                     | balance                                       | must always revert
```

Maintain a machine-checked mapping from every matrix row to at least one
targeted handler selector. Fail when the mutating contract selector inventory,
declared coverage map, or `targetSelector` list drifts. Do not use broad handler
targeting that silently includes helper or setup selectors.

### Accounting and conservation

- Preserve `address(this).balance >= cashLiabilities + reservedAutomation`
  after funding, cancellation, acceptance, repayment, settlement, withdrawal,
  automation funding, and unused-reserve withdrawal.
- Every HBAR credited to a user increases `cashLiabilities` by the same amount.
  Every successful withdrawal reduces both by the same amount.
- HSS reserves move only in whole `HSS_RESERVE_TINYBAR` units. A pending
  schedule owns exactly one reserve. Completing its scheduled or public
  terminal path releases that reserve once.
- Hedera JSON RPC values are weibar. Contract accounting is tinybar. Convert
  only at the transport boundary and reject fractional tinybar results.
- Maintain ghost state independently of production storage. After every
  successful or reverted handler call, assert these exact equalities:
  - `cashLiabilities == offerPrincipal + credits`
  - `reservedAutomation == pendingSchedules * HSS_RESERVE_TINYBAR`
  - `railHoldsCreated == accepted`
  - `terminalActions == repaid + defaulted`
  - `open == accepted - repaid - defaulted`
- The terms on the right are ghost values, never values derived from the state
  under test. Solvency is an inequality. Do not weaken the other equalities to
  inequalities.

### Custody and ATS holds

- One accepted offer creates one position and one position-tagged ATS hold.
- Re-read the hold immediately before release or execution. ATS balance
  adjustments can change its amount after acceptance. Drain the current amount,
  validate holder, partition, escrow, destination, and position data again, and
  require the terminal read to show no live hold.
- An ATS adjustment may change only the live quantity released or executed.
  Lender, borrower, principal, repayment, maturity, policy, schedule identity,
  liabilities, and reserves remain economically immutable. Test upward,
  downward, zero, and malformed adjustments.
- Holds are isolated by exact partition, holder, and hold ID. Snapshot unrelated
  sibling holds before a terminal action and prove their identities, amounts,
  and terminal states are unchanged afterward. An aggregate held balance is
  only a bound and can never identify the position hold.
- A hold reaches at most one terminal action. Repayment releases it to the
  borrower. Default executes it to the lender. No path may do both.
- Clearing must remain disabled because the maintained custody path is Holds.
- Keep a local reentrancy guard around every entry point that can reach an ATS
  read followed by mutation, an ATS mutation, or a native-value transfer.

### State and time

- Position state is monotonic: `NONE` to `OPEN`, then exactly one of `REPAID` or
  `DEFAULTED`. A terminal position never reopens.
- No direct, scheduled, reentrant, or raced call may default before maturity.
- Repayment and default remain mutually exclusive across borrower calls, HSS
  execution, permissionless settlement, and late scheduled no-ops.
- Loss of lender KYC may block execution, but must leave the position retryable
  after KYC is restored.

### Automation and fallback

- HSS is acceleration, not authority. A scheduling error, no-capacity response,
  malformed response, late execution, or reverted scheduled call must never trap
  collateral.
- `settle` stays permissionless and must reach the same terminal post-condition
  as HSS.
- Exercise both race orders: HSS wins before a public call, and a public call
  wins before a late HSS call. The loser must be a harmless no-op.
- Never add a keeper as a correctness dependency.
- Never add a relayer or frontend as a correctness dependency.

Maintain these exact automation states:

```text
State       | Schedule address | Reserved units | Permitted terminal path
NONE        | zero             | zero           | arm PENDING or record UNAVAILABLE
UNAVAILABLE | zero             | zero           | permissionless maturity settlement
PENDING     | nonzero          | one            | first maturity settlement completes it
COMPLETED   | retained nonzero | zero           | later settlements are harmless no-ops
```

Maintain these race results:

```text
First action                   | State afterward        | Reserve | Late rival
repay with schedule            | REPAID, PENDING        | one     | maturity call completes only automation
HSS default after maturity     | DEFAULTED, COMPLETED   | zero    | public settle is a no-op
public default after maturity  | DEFAULTED, COMPLETED   | zero    | late HSS settle is a no-op
scheduled call reverts         | terminal state unchanged, PENDING | one | public settle retries
```

Repayment before maturity may leave automation `PENDING`; the first scheduled
or public maturity call must release its one reserve and perform no ATS terminal
action. If HSS defaults first, the later public call is a no-op. If the public
call defaults first, the late HSS call is a no-op. If scheduled execution
reverts, the position and reserve stay retryable through permissionless
settlement.

Bind an HSS proof to the schedule body, not only its address or event. Resolve
the Mirror schedule ID and verify the target rail, exact `settle(positionId)`
calldata, zero call value, exact `HSS_GAS_LIMIT`, reserved execution second after
maturity, and the execution timestamp. A schedule for another position cannot
satisfy the proof or reserve ghost.

### External-call atomicity

- A failed oracle read, ATS read, ATS mutation, HSS call, or native transfer must
  not leave a partial offer, position, credit, liability, reserve, or hold state.
- State written before an external call is acceptable only when a revert rolls
  the complete transaction back and an adversarial callback test proves the
  reentrancy boundary.
- Treat every oracle read, ATS read, ATS mutation, rail self-call, HSS call, and
  native recipient receive function as a distinct callback surface. Exercise
  reentry into every mutation-matrix selector wherever the EVM permits it, plus
  short returns, malformed returns, explicit reverts, and successful calls with
  false or wrong response data. Assert both rollback and unchanged ghost state.

### Invariant test construction

- Name the protected state, each mutating entry point, each external callback,
  and every relevant ordering before writing the test.
- Make every intended handler transition reachable. Seed one successful example
  when a minimizer could otherwise reduce an anti-vacuity assertion to an
  unrelated one-call trace.
- Snapshot every coverage counter immediately after seeding. Require a positive
  post-seed delta for each critical selector, terminal race, callback, rejection,
  retry, adjustment, and no-op path. An absolute counter above zero proves only
  that setup ran and is not an anti-vacuity assertion.
- Target only declared handler selectors. Track successful transitions and
  rejected boundaries separately so a suite cannot pass while doing nothing.
- Include borrower repayment, permissionless default, successful HSS execution,
  unavailable HSS, late HSS no-op, KYC loss and retry, ATS balance adjustment,
  withdrawal, and both terminal races.
- For any suspected exploit path, record its preconditions and the shortest
  reachable call sequence. Do not describe a path as covered until the handler
  actually reaches it and the post-state is asserted.

## Integration maintenance

- Pin the exact upstream release or commit and record the artifact digest. A
  local ABI compared with another local artifact is not an upstream
  compatibility proof.
- Pin runtime implementation provenance as well as source provenance. Record the
  network, Factory and Resolver addresses, resolver configuration key and
  version, deployed token address and code hash, selector-to-implementation
  routing, and every reached implementation or facet code hash. Reject missing
  code, unknown routes, or any drift before publishing evidence. Re-resolve this
  graph after an upstream deployment or resolver change. An outer proxy code
  hash alone is not implementation provenance.
- For every ATS surface change, update the reduced interface,
  `docs/ats-call-surface.md`, the pinned signature fixture, mocks, adversarial
  tests, acceptance reads, evidence schema, live verifier, and compatibility
  finding in the same change.
- Read the upstream implementation for call ordering and state projection. Run
  its complete relevant suite when proposing an upstream fix. Preserve upstream
  license headers and never copy code whose license is incompatible with MIT.
- Verify deployed bytecode and live configuration independently. Bind internal
  KYC, Clearing disabled, token decimals, nominal value, nominal decimals,
  currency, maturity, roles, and both counterparty statuses.
- Use the official `HederaScheduleService` helper. Require response code 22, a
  nonzero schedule address, a Mirror-confirmed schedule ID, and an execution
  timestamp before attributing a terminal action to HSS.
- Never persist an address returned by a simulation as a real schedule address.
- Keep HSS funds separate from user cash liabilities.
- Name contract values as tinybar and JSON RPC values as weibar. Test the exact
  conversion independently of the production helper.
- Mirror queries must enforce the exact origin, timeouts, response-size limits,
  redirect rejection, response shape, complete pagination, and nonempty entity
  semantics.
- Bind lifecycle labels to successful receipts, emitting contract addresses,
  decoded event arguments, schedule execution, and exact final-block state.
- A material ATS, Hiero, HSS, HIP-475, Pyth, Mirror, RPC, or evidence-schema
  change requires local gates, a clean generated scaffold, the compatibility
  canary, and a fresh funded testnet lifecycle before release.
- When adding a recipe, validate its schema, deploy its exact immutable policy,
  and keep `term-credit` as the committed public evidence recipe.

## Key safety

- Privileged issuer setup belongs in Foundry scripts and encrypted keystores.
- Never place operator, issuer, or treasury keys in Next.js server routes.
- Never place a secret in a `NEXT_PUBLIC_` variable.
- Never commit `.env`, deployment keys, mnemonics, keystores, or funded account
  credentials.

## Interface discipline

- Keep one primary action in the active facility step.
- Keep free ATS balance, held ATS balance, cash liabilities, automation reserves,
  typed settlement conversion, and HSS status as separate facts.
- Derive oracle labels, caveats, and proof links from evidence `oracle.kind`.
  HIP-475 uses block state and must never cite a Pyth update receipt. Pyth uses
  its matching update transaction and must remain explicit configuration.
- Never label pending, simulated, or unverified data as public evidence.
- Preserve shareable recipe, mode, and position query parameters.
- Keep raw protocol data inside a technical disclosure unless it is the subject
  of the current task.

## Completion gate

Run formatting, lint, type checking, Foundry tests, invariant tests, the Next.js
production build, reference and live Playwright suites, route checks, and secret
scanning. Then run the fresh-scaffold job in a clean directory before declaring
the template complete. The release validation command must leave tracked and
nonignored untracked repository files unchanged. A tag is not allowed while public
evidence is pending or any required workflow is red.

## Extension order

- Keep the version 1 HBAR rail focused and immutable.
- Add HTS settlement as a separate contract only after the HBAR release is
  tagged and submitted.
- Reject custom-fee settlement assets unless a future accounting model proves
  their exact liability behavior.
- Keep external KYC and CLPR work isolated until their pinned upstream
  interfaces, compatibility, and proof semantics pass review.
