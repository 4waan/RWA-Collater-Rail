# Collateral Rail

Finance an ATS security without rebuilding custody, compliance ordering, oracle
safety, maturity automation, or public proof.

Collateral Rail is a developer-first Scaffold-HBAR template for bilateral HBAR
financing against Asset Tokenization Studio securities. It gives a new project
one narrow, tested financing kernel and declarative recipes for changing product
policy without changing the safety model.

Use it to start a term facility, maturity bridge, treasury advance, receivables
facility, or another bilateral secured-credit pattern. The recipe can change.
The integration work that developers should not have to repeat stays in one
tested implementation:

- ATS-native collateral custody through partition holds;
- ATS internal KYC for both counterparties;
- exact HBAR cash accounting and pull-payment withdrawals;
- HBAR/USD cash conversion through HIP-475 by default, with an explicitly
  configured Pyth mode that enforces freshness and confidence bounds;
- HSS maturity scheduling with permissionless recovery;
- authoritative Mirror Node evidence and HashScan explorer references for every
  published lifecycle claim.

The committed reference lifecycle uses HIP-475. It exposes Hedera's active
network settlement conversion rate, not a live market price oracle. The optional
Pyth mode supplies a market feed with freshness, confidence, and update-fee
checks. Both modes convert the HBAR cash leg only. Neither mode prices the ATS
security. Collateral coverage remains a configured advance against ATS nominal
value.

## Scaffold it

Requirements: Node 22, Corepack, Foundry, and Git.

```sh
npm create scaffold-hbar@latest collateral-rail-app -- \
  --template 4waan/scaffold-hbar-ats-finance \
  --yes \
  --skip-hedera-skills
cd collateral-rail-app
yarn dev
```

Open <http://localhost:3000>. No account, key, or environment file is required
for reference mode.

The repository itself can be started with:

```sh
corepack enable
yarn install --immutable
yarn dev
```

## Inspect the pattern locally

1. Open `/` and choose a financing recipe.
2. Open `/facility?recipe=term-credit&mode=reference` and move through one step
   at a time.
3. Open `/verify?position=repaid`, then switch to the defaulted position.
4. Follow each authoritative Mirror proof to its exact transaction or HSS
   entity. HashScan remains available as a secondary explorer reference.
5. Notice that free ATS balance, held ATS balance, typed settlement conversion,
   cash liabilities, and HSS reserves are never collapsed into one status.

The publication gate keeps an incomplete testnet lifecycle visibly pending. The
current committed record is verified. The homepage reports its transaction
count, and the verification page links every claim to a typed transaction, HSS
schedule, or state proof. The interface never invents proof.

## Choose a recipe

List and validate the bundled recipes:

```sh
yarn recipe:list
yarn recipe:check
```

The template ships three:

- **Term Credit** is the canonical evidence recipe. The committed lifecycle
  demonstrates funding, a native hold, repayment, and an HSS default. The
  permissionless recovery path is established by adversarial contract, runner,
  fuzz, invariant, and evidence-validation tests.
- **Maturity Bridge** uses a tighter advance, shorter term, smaller quote
  movement, and shorter offer window.
- **Custom Facility** exposes the full safe policy envelope as a starting point
  for a product-specific recipe.

Every recipe uses the same ATS, HSS, HBAR, typed oracle, and evidence kernel. A
recipe changes allowed economics and starting terms. It cannot weaken the
kernel safety ceilings.

## Build your own recipe

Recipe files live in `packages/shared/recipes`. Start from the closest bundled
definition, give it a unique lowercase ID, and choose stricter values within the
kernel envelope.

```sh
yarn recipe:check
yarn foundry:test
yarn test:e2e
```

Read [Build a Financing Recipe](docs/build-a-financing-recipe.md) for the schema,
safe envelope, extension test requirements, and the line between configuration
and new contract behavior.

Use a contract extension, not another recipe, when you need staged drawdowns,
partial collateral releases, pooled liquidity, auctions, margin calls, several
cash assets, or more than one ATS security per position.

## Deploy a recipe to Hedera testnet

Privileged ATS setup stays in Foundry. The web application has no issuer-key
route and no secret-bearing server action.

1. Create and fund a Hedera testnet ECDSA account through the
   [Hedera Portal](https://portal.hedera.com/).
2. Import it into an encrypted Foundry keystore.
3. Copy the private local configuration file and fill only the documented
   values.
4. Deploy a selected recipe and verify the public result.

```sh
cast wallet import hedera-operator --interactive
cp packages/foundry/.env.example packages/foundry/.env
yarn bootstrap:testnet --recipe term-credit
yarn verify:deployment
```

The local bootstrap requires these public values:

- `HEDERA_OPERATOR_ADDRESS`;
- `LENDER_ADDRESS`;
- `BORROWER_ADDRESS`;
- the pinned or explicitly configured ATS Factory, Resolver, RPC, and Mirror
  endpoints;
- Pyth and Hermes configuration only when the Pyth oracle mode is selected.

With no keystore path, Foundry uses the named `hedera-operator` account and
prompts interactively. For unattended local use, set both
`HEDERA_KEYSTORE_PATH` and `HEDERA_KEYSTORE_PASSWORD_FILE`. Never place a raw
private key in this file or in a command argument.

The bootstrap deploys a checksum-valid ATS bond with Clearing disabled,
registers the SSI issuer, grants KYC in the required order, issues borrower
collateral, deploys the selected oracle adapter and recipe-configured rail,
funds HSS, and writes public addresses and transaction hashes only. HIP-475 is
the default. Set `USE_PYTH_ORACLE=1` only for an explicit local Pyth deployment.

Live browser mode uses the public rail, ATS token, and oracle addresses. It
defaults `NEXT_PUBLIC_ORACLE_KIND` to `hedera-exchange-rate`. Set that variable
to `pyth` only when the configured oracle address is a `PythHbarUsdOracle`.
Hermes browser access and the Pyth update control are enabled only in that mode.

## Understand the secure kernel

One rail deployment is immutable to one ATS token and one partition. The
facility state machine is deliberately small:

```text
funded offer
  | cancel
  +----------> lender withdrawal credit
  |
  | accept after policy checks and hold inspection
  v
OPEN
  | repay                              | settle at or after maturity
  v                                    v
REPAID                              DEFAULTED
  |                                    |
hold released to borrower           hold executed to lender
```

Every accepted offer creates one position and one hold. Before repayment or
default, the rail revalidates that hold and drains its current adjustment-aware
amount. A terminal position never reopens. HSS improves timing, but any account
can call `settle` after maturity. No keeper is a correctness dependency.

The central cash invariant is:

```text
contract HBAR balance >= cashLiabilities + reservedAutomation
```

Read [Architecture](docs/architecture.md) for custody, accounting, automation,
external calls, and trust boundaries. Read the
[Hedera Integration Field Guide](docs/hedera-integration-field-guide.md) for the
ATS, HSS, Mirror, HIP-475, optional Pyth, and Hedera EVM failure modes encoded as
guards and tests.

## Safe policy envelope

A deployed recipe can be stricter, but it cannot exceed:

- 70% maximum advance against configured nominal value;
- 100% maximum annual rate;
- 1% maximum quote movement between funding and acceptance;
- 24-hour maximum offer lifetime;
- terms from two minutes to 365 days;
- the ATS security maturity.

HIP-475 mode reads the active network settlement conversion rate from system
contract `0x168`. HIP-475 does not provide a publisher timestamp or confidence
band. Pyth mode requires a positive price no older than 120 seconds, a
confidence interval no wider than 2%, the exact update fee, and an authenticated
Hermes payload. Both modes apply the configured quote-movement bound between
funding and acceptance. HSS capacity is attempted at maturity plus 2, 5, and 10
seconds.

The complete immutable policy is exposed by `policy()` and included in every
verified evidence record.

## Repository map

```text
packages/foundry   contracts, reduced ATS interfaces, scripts, and tests
packages/nextjs    recipe workbench and proof ledger
packages/shared    recipes, chain constants, canonical ABIs, evidence types
docs               field guide, ADRs, extension guide, maintainer material
.harness           release Harness specifications and deterministic validators
```

The three application routes are intentionally narrow:

- `/` explains the promise, lets a developer choose a recipe, and leads to
  public proof.
- `/facility` provides reference replay and wallet execution through one active
  lifecycle step.
- `/verify` reconstructs one position as chronological claims with exact
  sources and proof links.

## Test and release gates

```sh
yarn install --immutable
yarn release:validate
```

Use the individual commands below when diagnosing a failed release step:

```sh
yarn format:check
yarn lint
yarn typecheck
yarn recipe:check
yarn check:dead-code
yarn foundry:build
yarn foundry:test
yarn foundry:fuzz
yarn foundry:invariant
yarn test:runner
yarn test:e2e
yarn test:e2e:live
yarn next:build
yarn test:e2e:production
yarn check:routes
yarn check:ats-abi
yarn check:secrets
yarn harness:validate
```

The contract suite covers policy bounds, conversion and rounding, HIP-475 and
Pyth oracle behavior, KYC, allowance, quote movement, hold inspection, ATS balance
adjustments, HSS response codes, timestamp boundaries, repayment, default,
reentrancy, and reserve solvency. The
runner suite covers endpoint restrictions, funding caps, actor failures, Mirror
pagination, retry safety, evidence completeness, and sweep-back failure.

CI also scaffolds the public repository into a clean directory and repeats the
install, test, build, boot, and route checks against the generated project.
The release validator runs every local gate in the required order and rejects a
run that changes tracked or nonignored untracked files.

## Reference evidence gate

`packages/foundry/deployments/reference-testnet.json` is the public evidence
ledger. Publication requires the `term-credit` recipe, its complete deployed
policy, two distinct ATS holds, one repaid position, one matured default, a real
Mirror-confirmed HSS schedule, typed oracle evidence, live ATS roles and KYC,
separate free and held balances, successful Mirror receipts, and solvent final
accounting. The current record names HIP-475 and therefore contains no Pyth
update transaction.

The evidence classes are deliberately separate. **Observed on testnet:** the
committed default was executed by HSS schedule `0.0.10730732` and confirmed by a
later terminal state read. **Established by adversarial tests:** if HSS is
unavailable or delayed, any account can call `settle` after maturity, and the
runner accepts that path only with a successful transaction and matching
`PositionDefaulted` event. Version 1 does not require a fabricated HSS outage or
a second funded lifecycle. See the
[HSS observation and fallback assurance finding](docs/findings/2026-09-27-hss-observation-and-fallback-assurance.md).

The [public proof link audit](docs/findings/2026-09-27-public-proof-link-audit.md)
opened all 23 transaction, schedule, and contract links. Mirror returned every
exact entity. HashScan deep links returned HTTP 404 during the dated audit, so
the interface marks the explorer unavailable without weakening the verified
Mirror or RPC evidence.

The direct lifecycle runner is:

```sh
yarn demo:testnet --recipe term-credit
yarn publish:testnet
```

It requires the documented ephemeral signer values and should be run only with
a capped, funded Hedera testnet account. It creates temporary lender and borrower
accounts and attempts best-effort sweep-back. See
[Testnet Evidence Runner](docs/testnet-evidence-runner.md).

Hedera Harness is optional for ordinary application development and required for
maintainers running the canonical release gate. Follow the committed
specifications in `.harness/` and the [Maintainer Guide](docs/maintainer-guide.md).

## Advanced references

- [ATS call surface](docs/ats-call-surface.md)
- [Architecture decisions](docs/adr/)
- [Maintainer guide](docs/maintainer-guide.md)
- [Submission readiness](docs/submission-readiness.md)
- [Compatibility matrix](docs/compatibility.md)
- [Maintenance roadmap](docs/roadmap.md)
- [Decision record template](docs/templates/decision-record.md)
- [Measured finding template](docs/templates/measured-finding.md)
- [2026-09-26 release and lifecycle timings](docs/findings/2026-09-26-release-validation.md)
- [2026-09-27 public proof link audit](docs/findings/2026-09-27-public-proof-link-audit.md)

Version 1 uses one HBAR cash leg, one ATS asset per rail, and ATS internal KYC.
The next maintained extension is a separately versioned HTS settlement rail.
An external KYC reference adapter and CLPR collateral-mobility experiment follow
only after compatibility and security review against their pinned upstream
interfaces. HCS event duplication,
direct Block Streams consumption, pooled lending, order books, margin calls,
auctions, and secondary markets remain outside the maintained core.

## Maintenance

Compatibility checks run weekly without funded credentials. A funded Harness
lifecycle is run manually after material ATS, Hiero, HSS, HIP-475, Pyth, or
Mirror Node changes. Releases follow semantic versioning, keep old evidence
schemas readable for one major version, and document any migration before
removing an interface.

See [CONTRIBUTING](CONTRIBUTING.md), [Security](SECURITY.md), and the
[Maintainer Guide](docs/maintainer-guide.md) for support and release policy.

## License

The original implementation is MIT licensed. Reduced ATS ABI declarations and
the official Hiero contract helper retain their Apache License 2.0 notices. See
[NOTICE](NOTICE).
