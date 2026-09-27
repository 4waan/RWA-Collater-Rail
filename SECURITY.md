# Security policy

Collateral Rail publishes a verified Hedera testnet lifecycle and passes unit,
fuzz, invariant, runner, browser, fresh-scaffold, and Harness gates. Those are
concrete assurance layers. They do not constitute an independent production
audit or approval to custody valuable assets.

Do not operate a production credit facility from this template without an
independent audit, deployment review, operational controls, and legal review.
The maintained reference deployment and its public evidence are limited to
Hedera testnet.

## Assurance model

- **Tested:** deterministic unit, fuzz, invariant, runner, and browser tests
  establish behavior inside their modeled and adversarial call sequences. A
  passing test is not presented as a public network event.
- **Verified on testnet:** the committed evidence record proves a dated,
  two-position Hedera testnet lifecycle through typed Mirror, schedule, and
  exact-block state evidence. It does not prove future network availability or
  mainnet behavior.
- **Independently audited:** no independent production audit is claimed.
  Internal review, automated analysis, and invariant coverage remain distinct
  from a third-party audit opinion.
- **Production approved:** no production approval is claimed. A production
  deployment requires its own audit, configuration review, operational and key
  controls, legal analysis, and acceptance by the deploying organization.

Public claims must preserve these distinctions. Use observed testnet evidence
for network events and adversarial tests for modeled recovery properties. Never
use either one to imply an independent audit or production authorization.

## Reporting

Report a suspected vulnerability privately through GitHub Security Advisories.
Do not open a public issue containing an exploit, signer material, funded account
credentials, or an unpatched vulnerability.

Include the affected commit, impact, reproduction steps, and any known limits.
Maintainers will acknowledge a complete report within five business days and
will publish a remediation timeline after reproducing it.

## Supported versions

Only the latest tagged major version receives security fixes. Evidence records
remain readable for one major version after a schema change, but old contracts
are not upgradeable and are never silently redirected.

## Key and network boundary

- Issuer and operator actions remain in Foundry or the Harness runner.
- Raw keys must never enter frontend variables, URLs, command arguments, logs,
  evidence records, fixtures, or committed files.
- The browser accepts only public testnet addresses and approved public origins.
- Reference mode requires no wallet or account.
- A failed or unconfirmed wallet transaction must not advance application state.
