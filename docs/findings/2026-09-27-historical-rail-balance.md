# Finding: Historical rail balance is not an exact-block Hashio proof

- Status: measured and resolved
- Observed at: 2026-09-27
- Network: Hedera testnet
- Rail: `0xBb038155597b01D38eb61Af8A2d6117f79A14cB5`
- Recorded block: `41012411`
- Related issues: #17 blocks the immutable release in #12

## Finding

Contract calls at block `41012411` reproduced the recorded ATS, rail, oracle,
position, and hold state. `eth_getBalance` at that same Hashio block returned
zero. The latest Hashio balance returned `9366035290000000000` weibar, which is
`936603529` tinybar and matches the lifecycle record.

A timestamped Mirror account query was not a substitute for an exact block.
The official Mirror OpenAPI specification states that historical account
balance information is accurate within a 15-minute snapshot window. The query
for the lifecycle timestamp returned a zero snapshot from before the rail was
created. The current account query returned account `0.0.10730723`, the exact
rail EVM address, balance `936603529` tinybar, and balance timestamp
`1790433041.060326208`.

The source-read behavior is pinned to Hiero Mirror Node commit
[`f12b12c`](https://github.com/hiero-ledger/hiero-mirror-node/blob/f12b12c256435abf67a323f08e4aa211af8243e6/rest/api/v1/openapi.yml#L28-L40).
The same specification recommends the account endpoint for current account
balance and describes the 15-minute granularity of timestamped balance
snapshots.

## Resolution

Schema version 3 now preserves two distinct proofs:

1. The state proof contains only contract assertions read at the recorded
   Hashio block.
2. The balance proof uses the current Mirror account endpoint and records the
   account ID, EVM address, tinybar balance, balance timestamp, check time, and
   exact source URL.

The validator binds recorded accounting balance to the balance proof and checks
that it covers exact-block liabilities plus automation reserves. The live
verifier re-queries both current Mirror balance and current contract accounting,
then evaluates solvency again. A changed balance is reported honestly and
accepted only when it still covers current required backing. An unavailable,
malformed, misidentified, or insolvent response fails closed.

## Regression boundary

- Final contract verification never calls historical `eth_getBalance`.
- A missing or malformed current Mirror response is rejected.
- A zero current balance is rejected whenever required backing is nonzero.
- A changed current balance is not required to equal the dated record, but it
  must satisfy current solvency.
- Public copy never describes the current Mirror balance as exact-block state.
