# Submission readiness

This is the mechanical release gate for the Scaffold-HBAR template. Passing
tests in the source repository is necessary but not sufficient. The generated
project and the public testnet proof must also pass.

## Repository gate

- `template.json` has a valid name, description, version, requirements, and
  Scaffold-HBAR defaults.
- The license is MIT and third-party notices remain intact.
- No environment file, key, mnemonic, keystore, or funded credential is tracked.
- Immutable installation, formatting, linting, type checking, compilation,
  tests, production build, route checks, ABI checks, and secret scans pass.
- Browser tests start their own isolated server and pass at desktop and mobile
  viewports.
- Harness recipe validation passes without requiring funded credentials.

Run the complete local gate from an immutable install:

```sh
yarn install --immutable
yarn release:validate
```

## Generated-project gate

After merging to `main`, run the Fresh scaffold gate. It must generate the
public template into an empty directory, install it, repeat the repository gate,
boot the application without an environment file, and load `/`, `/facility`,
and `/verify`.

Inspect the generated outro as a user would see it. No step may require a wallet
to enter reference mode.

## Hedera evidence gate

The committed reference record is publishable only when:

- schema validation succeeds;
- the network is Hedera testnet and the recipe is `term-credit`;
- all public dependencies and deployed contracts are confirmed;
- every transaction proof is successful and Mirror-confirmed;
- every transaction and schedule proof carries an exact allowlisted Mirror URL;
- HSS proof names a real schedule, and an HSS terminal path has an execution
  timestamp plus a later terminal state read;
- a permissionless terminal path names its successful settlement transaction;
- two distinct ATS holds produce one repaid and one defaulted position;
- both ATS hold details have opening proofs and final-block deletion proofs;
- ATS roles, KYC, Clearing mode, decimals, nominal configuration, maturity,
  free balances, and held balances are read live;
- funding, acceptance, repayment, and fallback labels are bound to decoded
  receipt events from the expected contracts;
- typed oracle data, source-specific proof, immutable policy, liabilities,
  reserves, and solvency are complete;
- HIP-475 evidence contains the network-rate caveat and no Pyth update
  transaction, while Pyth evidence contains its matching update transaction;
- the candidate contains no private material and passes the secret scan.

Until that gate passes, the committed record must stay visibly pending.

### HSS release assurance

The version 1 gate distinguishes network observation from recovery assurance:

- **Observed on testnet:** the committed reference lifecycle contains an HSS
  default with a Mirror-confirmed schedule execution and a later `DEFAULTED`
  state read.
- **Established by adversarial tests:** non-success HSS responses preserve the
  hold and leave public settlement available. Invariant handlers exercise the
  fallback and prove terminal exclusivity, hold drainage, and solvency. Runner
  and evidence tests require a successful receipt and matching default event
  before a permissionless path can be published.

This is sufficient for the version 1 release. A second funded lifecycle that
artificially forces HSS failure is not required. If HSS executes first, neither
the runner nor a maintainer may submit a redundant `settle` call or relabel the
terminal path. The detailed acceptance record is in
[`2026-09-27-hss-observation-and-fallback-assurance.md`](findings/2026-09-27-hss-observation-and-fallback-assurance.md).

## Release gate

1. Confirm source CI is green.
2. Publish and manually inspect the testnet evidence.
3. Confirm every public HashScan and Mirror link.
4. Merge to `main` and pass the public Fresh scaffold gate.
5. Record dated setup, validation, and lifecycle measurements.
6. Confirm the submitted commit matches the reviewed commit.
7. Tag `v1.0.0` only after every item above is green.
