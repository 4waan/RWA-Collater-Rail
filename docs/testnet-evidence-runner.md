# Testnet evidence runner

`yarn demo:testnet --recipe term-credit` is the single command used by the
Harness Tier 3.5 recipe. It is intentionally testnet-only and completes a real
multi-actor lifecycle before it writes a candidate record.

## Harness inputs

Harness creates an ephemeral ECDSA account and supplies these process environment values:

- `HARNESS_SIGNER_ACCOUNT_ID`: Hedera account ID for the ephemeral issuer and deployer.
- `HARNESS_SIGNER_EVM_ADDRESS`: public EVM alias for that account.
- `HARNESS_SIGNER_PRIVATE_KEY`: raw ECDSA key used only in process memory.

The default runner uses HIP-475 and needs no oracle credential. When
`DEMO_ORACLE_KIND=pyth` is explicitly selected, the runner also requires
`PYTH_API_KEY`. It uses that value only as a bearer header when fetching the
signed Hermes update payload.

The private key is never placed in a command argument, deployment record,
frontend variable, or repository file. The Foundry script reads it from the
environment and starts the broadcast in process. Forge output is captured with
a size limit and redacts the hexadecimal, raw, and decimal key forms before any
text reaches the terminal.

The Tier 3.5 recipe itself requires these host values so Harness can fund and later sweep its signer:

- `HEDERA_OPERATOR_ID`: funded Hedera testnet ECDSA account ID.
- `HEDERA_OPERATOR_KEY`: matching ECDSA private key.

Do not place either value in a project environment file. Export them only in the shell that starts Harness.

## Public configuration

The runner supports these public settings:

- `HEDERA_NETWORK`, which must equal `testnet` when present.
- `HEDERA_TESTNET_RPC_URL`, fixed by policy to `https://testnet.hashio.io/api`.
- `HEDERA_MIRROR_URL`, fixed by policy to `https://testnet.mirrornode.hedera.com`.
- `DEMO_ORACLE_KIND`, defaulting to `hedera-exchange-rate`. The only other
  accepted value is `pyth`.
- `ATS_FACTORY_ADDRESS`, defaulting to the pinned testnet Factory.
- `ATS_RESOLVER_ADDRESS`, defaulting to the pinned testnet Resolver.
- `PYTH_HERMES_URL`, fixed by policy to `https://hermes.pyth.network` and used
  only in Pyth mode.
- `PYTH_ADDRESS`, defaulting to the pinned Hedera Pyth contract and used only
  in Pyth mode.

The fixed origin checks prevent a configured URL from turning the runner into an internal or credential-bearing request proxy. Address overrides remain public and are validated as EVM addresses.

Pyth mode fails before spending HBAR when `PYTH_API_KEY` is absent or malformed.
The runner never writes the key to evidence, command arguments, logs, or
repository files. HIP-475 mode does not fetch Hermes data, check Pyth bytecode,
or submit a Pyth update transaction.

## Lifecycle

Before spending HBAR, the command verifies that the signer key, account ID, and
EVM address agree. It also enforces the 250 HBAR signer cap, preserves an
execution reserve, checks the exact RPC and Mirror origins, confirms Factory,
Resolver, selected oracle, and HSS availability, checks the required local
tools, and verifies that the ignored candidate path is writable. The Hermes
origin, Pyth bytecode, and a signed update payload are checked only in Pyth mode.

After preflight, the command performs these operations:

1. Confirms the Harness signer balance is no greater than 250 HBAR.
2. Creates temporary ECDSA lender and borrower accounts with 25 HBAR each.
3. Deploys an ATS bond with Clearing disabled, configures SSI and internal KYC, and issues collateral.
4. Deploys the selected oracle adapter, financing rail, and acceptance verifier,
   then reserves HBAR for two HSS schedules. The default adapter reads HIP-475
   system contract `0x168`.
5. In Pyth mode only, fetches and submits a fresh HBAR/USD update from Hermes.
6. Funds and accepts two small facilities with a two-minute term.
7. Reads both ATS holds at their acceptance blocks and verifies their holder,
   partition, ID, amount, expiration, escrow, destination, data, operator data,
   and third-party type.
8. Withdraws the borrower's cash credit, repays one position, releases its hold, and withdraws the lender's credit.
9. Waits for the other position to mature. If HSS already defaulted it, the
   runner requires a Mirror-confirmed execution and submits no redundant
   transaction. If it remains open after the grace window, the runner invokes
   public `settle`, requires a successful receipt, and labels the permissionless
   fallback.
10. Refreshes every nonzero schedule after maturity and requires each scheduled
    terminal position to have a Mirror execution timestamp.
11. Reads final ATS roles, KYC, Clearing mode, token decimals, nominal value,
    nominal decimals, currency, free balances, held balances, both exact
    terminal hold records, rail liabilities, automation reserves, backing, and
    both terminal position states at one block.
12. Confirms transaction results and real schedule entities through Mirror
    Node, then records lifecycle duration and the confirmed transaction count.
13. Deletes the temporary accounts and transfers their remaining HBAR to the Harness signer on a best-effort basis.

The runner rejects an unknown or missing recipe value. It passes the selected
policy into Foundry, reads `policy()` after deployment, and refuses to write
evidence if the onchain values differ. Publication additionally requires
`recipeId: term-credit` so the public reference remains stable.

The committed version 1 lifecycle was observed on testnet with HSS executing
the matured default. It does not contain a permissionless fallback transaction.
That fallback is established by adversarial contract, invariant, runner, and
evidence-validation tests. A second funded run is not required for release, and
the runner must never force an outage, submit a redundant terminal call, or
relabel the path that actually occurred.

HIP-475 mode uses the active Hedera network settlement conversion rate. It is
not a live market price oracle. Pyth mode uses a fresh market feed. Both sources
convert the HBAR cash leg only. The collateral limit remains a configured
advance against ATS nominal value.

## Local encrypted-keystore path

`yarn bootstrap:testnet` remains available to developers who prefer an encrypted Foundry account. It uses `HEDERA_OPERATOR_ADDRESS`, `LENDER_ADDRESS`, and `BORROWER_ADDRESS`. With no keystore environment values it selects the named `hedera-operator` account and allows Foundry to prompt. For unattended use, set both `HEDERA_KEYSTORE_PATH` and `HEDERA_KEYSTORE_PASSWORD_FILE`. The keystore path never crosses into the frontend.

This local bootstrap produces initial deployment evidence only. The Harness
command proves both terminal facilities and attempts best-effort temporary
account cleanup after the evidence candidate is complete.

## Evidence publication

The runner writes `packages/foundry/deployments/testnet.json` with mode `0600`. The file is ignored by git. It contains public identifiers and verification results only.

`yarn publish:testnet` refuses to copy the candidate unless:

- every required address and actor identity is public and valid;
- every lifecycle checkpoint has a successful Mirror-confirmed transaction;
- there are exactly two distinct positions and exact hold state proofs;
- the terminal states include one repaid and one defaulted facility;
- at least one HSS schedule is Mirror-confirmed;
- every scheduled terminal position has a refreshed execution timestamp;
- lifecycle transaction labels match decoded events from the expected rail or
  ATS token, including offer, hold, repayment, and fallback identifiers;
- both terminal hold reads prove that no position-tagged collateral remains;
- the typed oracle values and final state reads are complete;
- HIP-475 evidence names system contract `0x168`, system file `0.0.112`, carries
  the network-rate caveat, and contains no Pyth update transaction;
- Pyth evidence names its feed, price, confidence, publish time, and matching
  Mirror-confirmed update transaction;
- the recipe ID and all six immutable policy values are complete, safe, and
  bound to the final state proof;
- the live verifier re-queries Mirror and RPC successfully;
- gitleaks passes over the deployment candidate directory.

Schema version 3 never treats every claim as a transaction. A transaction proof
contains its hash, consensus timestamp, result, exact Mirror source URL, and
secondary HashScan URL. A schedule proof contains its EVM address, Hedera
schedule ID, execution timestamp when executed, exact Mirror source URL, and
secondary HashScan URL. A state proof contains the verified block number,
approved RPC origin, and assertions read at that block.

The runner records Mirror URLs directly from validated identifiers. It marks
HashScan as unchecked until a maintainer completes the manual release audit.
Explorer failure does not downgrade Mirror-confirmed evidence. The current
[public proof link audit](findings/2026-09-27-public-proof-link-audit.md) records
all 23 destinations and the explicit HashScan unavailable state.

Publication first validates the ignored candidate, runs the live Mirror and RPC
verifier, and scans the deployment directory. Only then does it write a
temporary public record and atomically rename it over `reference-testnet.json`.
A failed run leaves the pending or previously verified public record untouched.
Run the repository history and staged secret scans again before a public push.

The exact boundary between the observed HSS path and the tested permissionless
recovery is documented in the
[HSS observation and fallback assurance finding](findings/2026-09-27-hss-observation-and-fallback-assurance.md).
