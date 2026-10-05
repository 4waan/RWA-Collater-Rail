---
name: clpr-collateral-mobility
description: Design, implement, test, or review Collateral Rail workflows that keep ATS collateral on Hedera while a cash leg settles through CLPR on a peer ledger. Use for CLPR application callbacks, state-proof messaging, replay safety, asymmetric failures, or the experimental mobility evidence flow. Do not use for the standalone HBAR or HTS rails.
---

# CLPR Collateral Mobility

Treat CLPR as ordered, state-proven message transport. Asset custody, escrow,
accounting, timeouts, and terminal choices remain application responsibilities.

Before changing code or claims:

1. Run `yarn clpr:check-upstream` and inspect the pinned compatibility result.
2. Read [protocol mechanics](references/protocol-mechanics.md) for CLPR API or
   transport work.
3. Read [collateral mobility](references/collateral-mobility.md) for contract,
   test, evidence, or recovery work.
4. Read [upstream compatibility](references/upstream-compatibility.md) before
   changing a pin, toolchain, verifier, endpoint, or supported-path claim.

Keep the extension isolated from `AtsCollateralRail` and
`AtsCollateralRailHts`. A CLPR outage must not affect their behavior.

## Non-negotiable safety rules

- Accept application messages only from the immutable CLPR service and channel,
  and the one-time sealed peer application configured for the deployment.
- Authenticate the source application from CLPR-stamped sender bytes. Never
  trust an address claimed only inside the application payload.
- Bind every message to protocol version, source and destination domains,
  terms hash, expiry, mobility ID, kind, and attempt.
- Make duplicate delivery idempotent and reject conflicting semantic replays.
- Keep financial correctness independent of `onClprResponse`; it is a
  best-effort notification.
- Record financial transitions before dispatching a durable local outbox item.
  Message transport failure must not roll back a local ATS terminal action.
- A relayer outage is recoverable through permissionless proof submission. A
  peer ledger or proof-system outage freezes an ambiguous position.
- Never unlock ATS collateral from a timeout, trusted relayer assertion, or
  response callback after remote cash may have moved.

Describe evidence as `observed-local-besu`, `observed-besu-to-solo`, or
`observed-hosted-testnet`. Mark unsupported directions `not-demonstrated`.
