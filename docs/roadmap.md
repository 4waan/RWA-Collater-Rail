# Maintenance roadmap

## Submission core

Version 1 is the HBAR settlement template being prepared for submission: one ATS
security, one partition, one bilateral obligation, internal ATS KYC, HIP-475
cash conversion by default, explicitly configured Pyth conversion, HSS
liveness, and typed public evidence. Security invariants take priority over
feature count.

## Next extension: HTS settlement

After the HBAR release is tagged and submitted, develop a separate
`AtsCollateralRailHts` contract. It will bind one HTS fungible settlement token,
reject custom fees, measure exact transfer deltas, keep token liabilities apart
from HBAR automation reserves, and preserve the same ATS terminal guarantees.
It will have independent tests, deployment scripts, UI support, and evidence.

The HBAR contract will not be generalized in place.

The accepted accounting and compliance design is recorded in the
[HTS settlement rail RFC](rfc/hts-settlement-rail.md).

## External KYC reference

The current ATS external KYC read interface is confirmed. Implementation remains
gated until after version 1. The adapter will be separate from the version 1
rail, fail closed, support authorization expiry, restrict mutation to a
compliance role, and carry an explicit non-production warning.

The confirmed interface and proposed safety boundary are recorded in the
[external KYC reference RFC](rfc/external-kyc-reference.md).

## Experimental CLPR mobility

Start with an architecture and threat-model RFC. Any prototype must verify
protocol-defined remote state, prevent replay, handle timeouts and asymmetric
failure, and keep a local permissionless recovery path. No trusted relayer may
unlock ATS collateral by itself. CLPR will not become a core dependency while
its public interface or test environment remains unstable.

## Deliberate exclusions

HCS event duplication, direct Block Streams consumption, pools, order books,
margin engines, auctions, privacy systems, and secondary markets are not on the
maintained core roadmap. They require separately scoped extensions.
