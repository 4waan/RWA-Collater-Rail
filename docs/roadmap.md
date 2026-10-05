# Maintenance roadmap

## Immutable HBAR fallback

Version 1.0 is the tagged HBAR settlement template: one ATS security, one
partition, one bilateral obligation, internal ATS KYC, HIP-475 cash conversion
by default, explicitly configured Pyth conversion, HSS liveness, and typed
public evidence. It remains the submission fallback and is not generalized in
place.

## Version 1.1 candidate: HTS settlement

The separate `AtsCollateralRailHts` contract is implemented on
`feat/hts-settlement-rail`. It binds one HTS fungible settlement token, rejects
custom fees, measures exact transfer deltas, keeps token liabilities apart from
HBAR automation reserves, and preserves the ATS terminal guarantees.

Deterministic, fuzz, invariant, Audit Box regression, independent arithmetic,
recipe, ABI, and evidence-schema tests are implemented. The controlled-token
and Circle USDC runners publish separate records. Both funded testnet records,
manual link audits, clean-scaffold validation, and the release decision remain
gates. The HBAR contract is unchanged.

The accepted accounting and compliance design is recorded in the
[HTS settlement rail RFC](rfc/hts-settlement-rail.md).

## Later: external KYC reference

The current ATS external KYC read interface is confirmed. Implementation remains
gated until after version 1. The adapter will be separate from the version 1
rail, fail closed, support authorization expiry, restrict mutation to a
compliance role, and carry an explicit non-production warning.

The confirmed interface and proposed safety boundary are recorded in the
[external KYC reference RFC](rfc/external-kyc-reference.md).

## Experimental CLPR mobility

The implementation is isolated from both settlement rails and pins the LFDT
CLPR specification, contract, and endpoint commits. It keeps ATS collateral on
Hedera while a controlled test-token cash leg is escrowed on a peer EVM ledger.
Every remote transition requires a protocol-verified message, and no trusted
relayer may unlock ATS collateral by itself.

The release gate requires a bidirectional two-Besu lifecycle and the currently
supported Besu-to-Solo proof path. Solo-to-Besu and hosted testnet behavior stay
explicitly `not-demonstrated` until the upstream proof service and environment
support them. A permanent peer proof outage freezes ambiguous collateral rather
than choosing an unsafe timeout release.

## Deliberate exclusions

HCS event duplication, direct Block Streams consumption, pools, order books,
margin engines, auctions, privacy systems, and secondary markets are not on the
maintained core roadmap. They require separately scoped extensions.
