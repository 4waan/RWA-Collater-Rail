# ADR 006: Mirror verification without an HCS relay

- Status: accepted
- Protecting test: Playwright `/verify` route and `verify-deployment.mjs`

## Decision

Reconstruct evidence from contract reads, transaction receipts, and exact
Mirror Node sources. Keep HashScan as a secondary explorer reference with an
independent availability status. Do not relay lifecycle events through HCS.

## Alternatives considered

- Mirror every state change into an HCS topic.
- Trust frontend transaction toasts.
- Use HashScan verification as complete deployment evidence.

## Why

The rail already emits canonical EVM events and stores current obligations.
Adding HCS would duplicate evidence without improving correctness for this
workflow.

## Sacrifice

There is no separate ordered observer stream. Consumers must interpret receipts,
pagination, and live state explicitly.

## Validation

The verifier rejects empty successful responses, keeps free and held balances
separate, requires direct configuration reads, and binds every rendered Mirror
URL to its validated identifier and allowlisted origin. Explorer failure does
not invalidate Mirror or RPC evidence.
