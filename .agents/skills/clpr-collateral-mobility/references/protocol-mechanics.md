# CLPR protocol mechanics

Compatibility baseline: LFDT CLPR commits recorded in
`packages/foundry/abi/clpr-upstream.json`.

## Trust path

1. A source application calls `sendMessage` on its local CLPR service.
2. The service stamps the actual source caller into the message. The payload
   cannot substitute another authenticated source.
3. An endpoint transports an ordered bundle plus a proof.
4. `submitBundle` is permissionless. The destination channel verifier, not the
   submitter, decides whether the bundle is valid.
5. The destination service invokes `onClprMessage` on the target application.
6. The returned bytes become a response message. Delivery to
   `onClprResponse` is best-effort and its revert is ignored.

A channel is permanently bound to a verifier and peer service context. A
connector authorizes outbound messages and funds destination execution. It is
an economic routing actor, not a custodian and not a source of proof truth.

## Application checks

The receiving application validates:

- `msg.sender` is its configured CLPR service;
- `channelId` is its configured channel;
- `sender` is the exact encoded peer application address;
- payload version and domains match this deployment;
- terms, expiry, message kind, position state, and replay key are valid.

Message callbacks should perform bounded state transitions and create credits
or outbox entries. User token transfers remain pull-based when an external
transfer could otherwise make bundle processing fragile.

## Current upstream boundary

The reviewed harness demonstrates QBFT proof delivery from Besu into Solo. Its
Solo-to-Besu state-proof test is skipped because the referenced Solo Block Node
does not implement the required ProofService. Do not present the public harness
as a bidirectional Hedera demonstration until this changes and is measured.
