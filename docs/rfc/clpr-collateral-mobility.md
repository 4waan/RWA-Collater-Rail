# RFC: CLPR collateral mobility

Status: experimental implementation

## Objective

Allow ATS collateral to remain held on Hedera while a separately governed cash
leg settles on another participating ledger. This RFC defines the safety bar for
an experiment. It does not authorize a production integration.

## Required proof model

The Hedera rail may recognize remote settlement only through a
protocol-defined, independently verifiable state proof. A relayer may transport
proof bytes but cannot decide their validity or independently release
collateral.

Every remote obligation requires a unique domain, source ledger, destination
ledger, remote transaction identifier, local position identifier, amount,
asset, beneficiary, expiry, and monotonic replay nonce.

## State transitions

1. Fund a remote cash offer and deliver its state-proven message to Hedera.
2. Lock ATS collateral and record a retryable `COLLATERAL_LOCKED` outbox item.
3. Credit and withdraw principal remotely only after the lock proof arrives.
4. Activate the Hedera position only after a verified principal-withdrawal
   message. Derive maturity from the proven withdrawal time.
5. Accept either a verified repayment-escrow message or the local default path.
6. Record terminal messages in a local outbox and dispatch them separately.

## Failure requirements

- Duplicate, reordered, expired, or wrong-domain proofs fail closed.
- Remote success without local activation remains retryable from the same proof.
- Local activation cannot be replayed against another position.
- A relayer outage cannot block any public timeout or default action.
- A peer ledger or proof-service outage freezes an ambiguous position when cash
  may have moved. A timeout alone never unlocks the collateral.
- A ledger reorganization inside the remote finality window cannot activate the
  local position.
- Proof verifier upgrades require a new rail version or an explicit delayed
  governance boundary. They cannot silently reinterpret existing positions.

## Prototype exit criteria

The maintained prototype remains isolated until a stable public proof
specification, bidirectional Hiero test environment, verifier interface,
finality definition, and recovery model exist. It must include adversarial
replay, invalid-finality, timeout, relayer-censorship, and asymmetric-failure
tests before any public demo claim.

## Demonstration boundary

The pinned upstream harness currently implements QBFT proof delivery from Besu
into Solo. Its Solo-to-Besu state-proof case is skipped because the referenced
Block Node does not implement the required ProofService. The first acceptance
target is therefore a bidirectional two-Besu lifecycle plus an observed
Besu-to-Solo delivery. Bidirectional Hedera claims require a later supported
environment and separate evidence.
