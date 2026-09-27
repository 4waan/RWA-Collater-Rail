# HSS observation and fallback assurance

- Date: 2026-09-27
- Status: accepted for the version 1 release
- Scope: HSS maturity execution and permissionless settlement recovery

## Decision

The verified HSS lifecycle and the adversarial fallback suites together satisfy
the version 1 automation acceptance criterion. A second funded lifecycle that
artificially forces HSS failure is not required.

This decision preserves two distinct evidence classes. Test coverage is not a
testnet event, and an HSS terminal action is not a permissionless fallback.

## Observed on testnet

The committed schema version 3 record at
`packages/foundry/deployments/reference-testnet.json` is verified and contains
17 Mirror-confirmed transactions across two positions:

- one position reached `REPAID` through repayment;
- one position reached `DEFAULTED` through HSS;
- the defaulted position names `terminalPath: hss`;
- schedule `0.0.10730732` has execution timestamp
  `1790433041.060326208`;
- final state was read at block `41012411` and asserts the defaulted position is
  `DEFAULTED`, both held balances are zero, and rail backing remains solvent.

No permissionless fallback transaction is present or claimed in this record.
The runner detected that HSS had already defaulted the position, required the
executed schedule proof, and did not submit a redundant `settle` transaction.

## Established by adversarial tests

Permissionless recovery is accepted through complementary test layers:

- `testBadHssResponseDoesNotTrapCollateral` injects non-success HSS response
  codes for every scheduling attempt. Acceptance completes, automation becomes
  `UNAVAILABLE`, and the collateral hold remains available to the terminal
  path.
- `RailSolvency.invariant.t.sol` drives post-maturity public settlement through
  `_settleAndRecord`, records `successfulFallbackDefaults`, and requires the
  `COVER_FALLBACK_DEFAULT` branch in its deterministic critical-path coverage
  test.
- The invariant suite preserves HBAR solvency, one hold per accepted position,
  no early default, terminal exclusivity, and at most one terminal collateral
  action while exercising the fallback.
- Runner and evidence tests reject fallback attribution without a successful
  receipt, bind `PositionDefaulted` to the expected rail and position, reject a
  mismatched terminal path, and independently require an execution timestamp
  for HSS attribution.
- `demo-testnet.ts` submits public `settle` only if the position is still open
  after maturity and the automation grace window. It then requires a successful
  receipt and matching default event before recording `permissionless`.

Run the assurance suites with:

```sh
yarn foundry:test
yarn foundry:invariant
yarn test:runner
yarn harness:validate
```

## Publication rule

A release record must describe the terminal action that actually occurred:

- HSS attribution requires a Mirror-confirmed schedule with a non-null
  execution timestamp and a later terminal state read.
- Permissionless attribution requires a successful settlement transaction, a
  matching `PositionDefaulted` event, and a later terminal state read.
- If HSS has already defaulted the position, no later no-op call can serve as
  fallback evidence.

A future run may naturally observe the permissionless path when HSS remains
unavailable through the grace window. That record should be published as
separate supporting evidence and must not overwrite or weaken the canonical HSS
lifecycle.

## Falsifiers

This acceptance decision must be reopened if any of these conditions occurs:

- a verified record labels fallback without its successful settlement proof;
- an HSS terminal path lacks a non-null schedule execution timestamp;
- a non-success HSS response can trap collateral or prevent public settlement;
- the fallback can execute before maturity, execute twice, leave a residual
  position-tagged hold, or violate backing;
- the runner relabels an HSS terminal action after a redundant call.
