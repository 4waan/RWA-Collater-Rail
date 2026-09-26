# ADR 004: The oracle converts only the HBAR cash leg

- Status: accepted
- Protecting test: `testPreviewUsesHaircutConversionAndConservativeInterest`

## Decision

Use HIP-475 by default to convert a USD principal into exact tinybar from
Hedera's active network settlement conversion rate. Allow Pyth only through
explicit deployment configuration. Use a configured ATS nominal value and 70%
advance for collateral coverage in both modes.

## Alternatives considered

- Treat either HBAR/USD source as a bond price.
- Add an administrator-supplied security market price.
- Remove USD terms and quote only in HBAR.

## Why

The oracle supplies a load-bearing conversion for the actual cash asset.
HIP-475 is a network settlement rate, not a live market price. Optional Pyth is
a live cash feed with freshness and confidence checks. Keeping collateral
underwriting separate avoids implying that a liquid bond market or RWA oracle
exists.

## Sacrifice

There is no mark-to-market, margin call, or secondary valuation in version 1.

## Validation

The preview test checks the haircut and HBAR conversion separately. HIP-475
tests enforce system response validity. Pyth tests enforce fee, sign, age,
exponent, and confidence rules. Evidence tests require a state proof for
HIP-475 and a matching update transaction for Pyth.
