# Upstream compatibility

The authoritative sources are the LFDT CLPR specification, smart contracts,
and endpoint repositories. The exact reviewed commits and file digests live in
`packages/foundry/abi/clpr-upstream.json`.

## Toolchain isolation

- Collateral Rail remains on Solidity 0.8.24 and Node 22.
- The reviewed CLPR contracts require Solidity 0.8.28 and Node 24 or newer.
- Do not import or compile upstream CLPR sources inside the Collateral Rail
  Foundry package. Maintain the minimal application-facing ABI locally.
- Run the upstream stack in a pinned temporary checkout or container.

## Compatibility procedure

1. Fetch only the pinned raw files with redirects rejected, response-size
   limits, and timeouts.
2. Verify every SHA-256 digest before using an upstream artifact.
3. Compare application callback and `sendMessage` signatures.
4. Run upstream unit tests, then the two-Besu integration.
5. Run the Besu-to-Solo test and record unsupported directions separately.
6. Review specification and implementation drift before changing a public
   claim or pin.

Known reviewed drift includes a specification ADR removing message redaction
while the Solidity surface still contains redaction behavior, plus older prose
that describes endpoint-gated bundle submission while the current interface
documents permissionless submission. Use measured implementation behavior and
record the discrepancy.
