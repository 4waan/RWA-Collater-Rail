# Finding: Release and lifecycle timings are measured

- Status: measured
- Observation dates: local release validation on 2026-09-26; clean generated
  workflow on 2026-09-27; funded Hedera testnet lifecycle completed on
  2026-09-26
- Measured commit:
  `2c3a274013af1f19a9d2da76d806dfa697cccbe5`
- Clean workflow:
  [Fresh scaffold gate run 36294077129](https://github.com/4waan/scaffold-hbar-ats-finance/actions/runs/36294077129)
- Clean workflow environment: GitHub hosted `ubuntu-24.04`, Ubuntu 24.04.5,
  runner image `20260920.314.1`, North Central US
- Clean workflow versions: Node.js 22.23.2, npm 10.9.8, Yarn 3.2.3,
  `create-scaffold-hbar` 0.4.0, Foundry 1.5.1, Solidity 0.8.24,
  Next.js 15.2.8, Playwright 1.61.1
- Local environment: arm64, macOS 26.5.1, Node.js 22.16.0, Yarn 3.2.3,
  Foundry 1.5.1
- Enforcing commands: the public scaffold command in
  `.github/workflows/fresh-scaffold.yml` followed by `yarn release:validate`

## Measurement meaning

`Clean` means the `gate-check` destination did not exist before the scaffold
command, the generator created a new project, and the workflow did not restore
a repository-level JavaScript dependency cache. It does not claim that a
GitHub hosted runner has empty operating-system or network caches.

The scaffold command performs the first dependency installation itself. That
initial installation is the cold generated-project install measurement below.
The separate `yarn install --immutable` workflow step ran after generation and
reported 904 cached packages. It is recorded only as a warm idempotence check,
not as the cold install value.

## Falsifiable probe

Run the `Fresh scaffold gate` workflow from the measured commit. It must create
a new `gate-check` project from the public template, complete its initial
dependency install, pass the explicit immutable reinstall, build the production
application, render all three required routes without browser console errors,
pass every release stage, and leave the generated project snapshot unchanged.
Any failed stage or changed snapshot disproves the finding for that run.

## Clean generated-project evidence

The durations below are differences between timestamped log boundaries from
the successful workflow. Millisecond precision describes that observation
only. It is not a benchmark guarantee.

- Scaffold command:
  `npm create scaffold-hbar@latest gate-check -- --template 4waan/scaffold-hbar-ats-finance --yes --skip-hedera-skills`.
  The generator invokes Yarn internally for the initial dependency-install
  interval.
- Public scaffold: 84.432 seconds. Boundary: scaffold command invocation at
  `2026-09-27T04:21:48.978142Z` through its final success output at
  `2026-09-27T04:23:13.410062Z`. This includes project creation, the initial
  dependency install, formatting, Git initialization, and Foundry library
  installation.
- Initial generated-project dependency install: 67.589 seconds. Boundary:
  the generator's first `Installing packages` output at
  `2026-09-27T04:21:54.046101Z` through its successful dependency-install
  completion at `2026-09-27T04:23:01.635065Z`.
- Warm immutable reinstall: 1.524 seconds. Boundary: the explicit generated
  project `yarn install --immutable` invocation at
  `2026-09-27T04:23:13.466548Z` through Yarn's completion at
  `2026-09-27T04:23:14.990330Z`. Yarn reported 904 cached packages, so this is
  not used as the initial install claim.
- Production build: 28.246 seconds. Boundary: the release gate's
  `yarn next:build` marker at `2026-09-27T04:25:26.652658Z` through the next
  release-stage marker at `2026-09-27T04:25:54.898169Z`. The build produced
  `/`, `/facility`, `/verify`, and `/icon.svg` successfully.
- Production server readiness: 432 milliseconds, as reported by Next.js from
  process start to its ready signal on the isolated Harness port. Command:
  `yarn workspace @collateral-rail/nextjs start -p 3211 -H 127.0.0.1`.
- Required-route verification after readiness: 1.465 seconds. Boundary: the
  ready log at `2026-09-27T04:27:03.171858Z` through Harness validation
  completion at `2026-09-27T04:27:04.636253Z`. Harness observed `/`,
  `/facility`, and `/verify` with zero findings.
- Complete generated release validation: 206.909 seconds. Boundary:
  `yarn release:validate` invocation at `2026-09-27T04:23:37.806865Z` through
  `Release validation passed without changing tracked files` at
  `2026-09-27T04:27:04.715122Z`.
- Scaffold invocation through complete validation: 315.737 seconds. Boundary:
  the scaffold command invocation through the final release success output.
  This includes the scaffold, the warm immutable reinstall, Chromium setup,
  and complete generated validation.

The Harness repeated production build inside its own validation in 20.951
seconds. This is kept separate from the release gate's production-build value
because it is a second build in the same generated workspace.

## Funded Hedera testnet evidence

The committed schema version 3 record in
`packages/foundry/deployments/reference-testnet.json` reports:

- Lifecycle elapsed time: 558.580 seconds.
- Mirror-confirmed transactions: 17.
- Lifecycle completion: `2026-09-26T14:30:58.014Z`.
- Record status: `verified`.

The lifecycle command was `yarn demo:testnet --recipe term-credit`; publication
then passed the atomic `yarn publish:testnet` validation path.

The lifecycle value covers the runner's recorded start through completion of
the two-position testnet lifecycle. It is a network observation and is not a
promise about future Hedera consensus, Mirror ingestion, or HSS execution
latency.

## Local release baseline

The earlier local run remains useful as a separate host observation:

- Full local release validation: 329.80 seconds.
- Harness production build: 13.696 seconds.
- Harness development server readiness: 1.510 seconds.
- First local route responses: `/` in 4.420 seconds, `/facility` in 1.071
  seconds, and `/verify` in 1.001 seconds.
- Result: zero Harness findings and no working-tree snapshot change.

These local route values are individual first-response observations. They are
not percentiles and should not be compared directly with the isolated
production readiness value from the GitHub workflow.

## Result

The clean public template produced an installable generated project. The
generated project passed formatting, linting, type checking, recipe validation,
dead-code checks, contract compilation, unit tests, fuzz tests, invariants,
runner tests, development browser tests, live-fixture browser tests, production
build and browser tests, route checks, ATS interface verification, secret
scanning, and Harness validation.

No completed measurement remains marked pending. Raw workflow logs were
inspected through GitHub Actions and were not copied into the repository.

## Consequence

Use these numbers as dated reproducibility observations only. Any public speed
claim must cite the measured commit, environment, workflow, and boundary. A new
release may replace these observations only after another clean generated
workflow and, for network timing, another funded lifecycle.

## Regression protection

`scripts/release-gate.mjs` defines the ordered validation and rejects tracked
snapshot changes. `.github/workflows/fresh-scaffold.yml` creates the project
from the public template on `main`, performs the immutable reinstall, and runs
the complete release gate. The schema version 3 evidence validator requires
the lifecycle elapsed time and Mirror-confirmed transaction count.
