# ADR 005: HSS automation with public fallback

- Status: accepted, release criterion resolved 2026-09-27
- Protecting test: `testBadHssResponseDoesNotTrapCollateral`

## Decision

Attempt HSS settlement at maturity plus 2, 5, and 10 seconds, while keeping
`settle` public, idempotent, and independent of a keeper.

## Alternatives considered

- Require a keeper service.
- Revert acceptance when HSS has no capacity.
- Omit automation and rely only on manual calls.

## Why

HSS provides native liveness without becoming the correctness dependency.
Response codes, capacity, boundary timing, and funding can fail safely.

## Sacrifice

Automation can be unavailable, and a user may need to submit `settle`. Five HBAR
per pending schedule is isolated from user cash.

## Validation

Non-success responses produce `UNAVAILABLE`, preserve the hold, and leave public
settlement callable.

**Observed on testnet:** the committed reference lifecycle records default by
HSS schedule `0.0.10730732`, its execution timestamp, and a later `DEFAULTED`
state read.

**Established by adversarial tests:** unit tests inject non-success HSS response
codes, invariant handlers execute permissionless fallback, and evidence tests
reject fallback attribution without a successful receipt and matching event.

The version 1 release does not require a second funded run that manufactures an
HSS outage. The actual HSS result remains canonical. A future naturally
observed fallback can be published as separate evidence, but test coverage must
never be described as a testnet event.
