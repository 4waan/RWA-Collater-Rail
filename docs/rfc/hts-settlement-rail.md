# RFC: HTS settlement rail

Status: version 1.1 candidate implemented, funded testnet evidence pending

## Versioning decision

Do not generalize `AtsCollateralRail` in place. Add a separate
`AtsCollateralRailHts` contract so the published HBAR custody and solvency model
does not change underneath existing developers.

Every HTS rail binds one ATS token, one partition, and one fungible HTS cash
token. Principal, repayment, credits, and liabilities use the cash token's
smallest unit. The contract makes no claim that one token equals one US dollar.

## Accounting model

The contract maintains two independent backing requirements:

```text
HTS cash-token balance >= cashTokenLiabilities
HBAR balance >= reservedAutomation
```

Funding and repayment pull cash tokens through an allowance. Withdrawals push
only the caller's recorded credit. Every transfer measures the rail balance
before and after the HTS call and rejects a non-exact delta.

Tokens with fixed, fractional, or royalty fees are rejected during one-time
initialization. Exact liability accounting is more important than broad token
compatibility.

## Initialization and compliance

Initialization is permissionless but can target only the immutable settlement
token. It associates the rail through the HTS system contract and accepts only
success or already-associated response codes. It then validates fungible type,
decimals, and an empty custom-fee schedule.

The rail does not hold KYC, freeze, pause, fee, supply, or admin keys. The
separate `HtsRailAcceptance` verifier reports token policy, association, KYC,
freeze, allowance, and balance readiness without gaining mutation authority. A
later compliance change remains authoritative: an HTS transfer failure reverts
the complete rail transition.

## Lifecycle compatibility

Offer funding and repayment become nonpayable token transfers. ATS hold creation,
repayment release, matured execution, terminal idempotence, HSS scheduling, and
permissionless settlement preserve the HBAR rail semantics. HSS fees remain an
explicit HBAR reserve and cannot be paid from settlement-token liabilities.

The HTS rail has its own ABI, deployment script, acceptance verifier, recipe,
invariant suite, candidate runners, live verifier, and evidence schema. Its two
public evidence records remain separate from the canonical HBAR record.

The controlled profile creates a six-decimal test token with KYC, freeze, and
pause keys and no fee-schedule key. It uses `FixedTestUsdOracle` and proves only
mechanics. The Circle profile pins testnet USDC `0.0.429274` and Pyth feed
`0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a`.
Only that second profile supports market-valued settlement language.

## Required tests

- first association and already-associated initialization;
- invalid token, NFT token, invalid decimals, and custom-fee rejection;
- missing KYC, frozen account, paused token, insufficient allowance, and
  insufficient balance;
- exact inbound and outbound balance deltas;
- transfer failure atomicity around offers, positions, credits, and ATS holds;
- token solvency and HBAR automation reserve invariants;
- repayment and default exclusivity;
- HSS failure with public settlement recovery.

The current suites also preserve Audit Box regressions AB-037, AB-039, and
AB-042. Independent arithmetic verification covers constructed rounding and
overflow boundaries without importing production helpers.
