# Public proof link audit

- Transaction, schedule, and contract links audited at: 2026-09-27T02:12:33Z
- Current balance source audited at: 2026-09-27T12:24:59Z
- Network: Hedera testnet
- Record: `packages/foundry/deployments/reference-testnet.json`
- Scope: 17 transactions, 2 schedules, 4 deployed contracts, and 1 current rail
  balance
- Result: Mirror sources verified, HashScan deep links unavailable

## Method

Every HashScan URL was opened in headless Chromium and requested directly with
redirect following disabled. Each route returned HTTP 404, kept the original
URL, and provided no independently usable entity result. Some routes rendered
the HashScan application shell, but the HTTP result remained 404. HashScan is
therefore recorded as unavailable for this audit.

Every matching Mirror URL was requested from the exact allowlisted origin with
redirects rejected. Transaction responses were checked for the exact hash,
`status: 0x1`, null error, and recorded consensus timestamp. Schedule responses
were checked for the exact schedule ID and execution timestamp. Contract
responses were checked for the exact EVM address, a live contract ID, and
`deleted: false`.

## Transactions

Each HashScan link below returned HTTP 404 with no redirect. Each Mirror link
returned HTTP 200 and the exact hash, successful status, null error, and listed
timestamp.

- `ats-bond-deployment-1`: [HashScan](https://hashscan.io/testnet/transaction/0x3cfd8f0dfc007e987ac871ebf4030648a1835a7110efe3821665abc5d2d78e57), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3cfd8f0dfc007e987ac871ebf4030648a1835a7110efe3821665abc5d2d78e57), timestamp `1790432834.344455156`.
- `issuer-configuration-1`: [HashScan](https://hashscan.io/testnet/transaction/0x994a7e80e8c1f51c4faefa14b66b80af73753c97a63a6d4ee699142a86e1b3ad), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x994a7e80e8c1f51c4faefa14b66b80af73753c97a63a6d4ee699142a86e1b3ad), timestamp `1790432841.407634609`.
- `kyc-grant-1`: [HashScan](https://hashscan.io/testnet/transaction/0x9b0e05eed3bfa5a273f1849372fe0bc66ed3980b52d647d67cdd4307f987390e), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x9b0e05eed3bfa5a273f1849372fe0bc66ed3980b52d647d67cdd4307f987390e), timestamp `1790432845.746662104`.
- `kyc-grant-2`: [HashScan](https://hashscan.io/testnet/transaction/0x53d1d163be13f334ef4af74c58da780e06a10f5a42265b9044035e35a94d0fcf), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x53d1d163be13f334ef4af74c58da780e06a10f5a42265b9044035e35a94d0fcf), timestamp `1790432851.918935324`.
- `collateral-issuance-1`: [HashScan](https://hashscan.io/testnet/transaction/0x6aa9e7a01238f42e7e605618b00b2071b6f0d5f6477505ec77492d34d42a2ef7), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x6aa9e7a01238f42e7e605618b00b2071b6f0d5f6477505ec77492d34d42a2ef7), timestamp `1790432856.707777680`.
- `oracle-deployment-1`: [HashScan](https://hashscan.io/testnet/transaction/0xc74e75ae52794e1800def13d5d431cd4484f1469d8501bef4c0e9b10485699fe), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xc74e75ae52794e1800def13d5d431cd4484f1469d8501bef4c0e9b10485699fe), timestamp `1790432862.904182306`.
- `rail-deployment-1`: [HashScan](https://hashscan.io/testnet/transaction/0x817f3edb2850674873d77f263ce7967bb9daeaac5660ed1c03d2923bea7c5c73), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x817f3edb2850674873d77f263ce7967bb9daeaac5660ed1c03d2923bea7c5c73), timestamp `1790432868.571154937`.
- `automation-funding-1`: [HashScan](https://hashscan.io/testnet/transaction/0x2b1a4ee6d0b6932e659a00a3daa796ba049bc7b72d04bdf836912bc4ec7429c1), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x2b1a4ee6d0b6932e659a00a3daa796ba049bc7b72d04bdf836912bc4ec7429c1), timestamp `1790432875.326645104`.
- `acceptance-deployment-1`: [HashScan](https://hashscan.io/testnet/transaction/0x50a3e51753e67b8c8bed91cf866285d185eeb639088aec34a4ed8230bb067d03), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x50a3e51753e67b8c8bed91cf866285d185eeb639088aec34a4ed8230bb067d03), timestamp `1790432882.458599415`.
- `ats-allowance`: [HashScan](https://hashscan.io/testnet/transaction/0xb30c6b1bb5f6c10b4716a5b23d60fc9d87a0f39939692f9cfbdac688a6cab2e8), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xb30c6b1bb5f6c10b4716a5b23d60fc9d87a0f39939692f9cfbdac688a6cab2e8), timestamp `1790432891.783942104`.
- `fund-offer-1`: [HashScan](https://hashscan.io/testnet/transaction/0x36288f0abe01ee293d4cc235734e5663a0416ddb6234551bea99367b5f27a52e), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x36288f0abe01ee293d4cc235734e5663a0416ddb6234551bea99367b5f27a52e), timestamp `1790432898.084257104`.
- `accept-offer-1`: [HashScan](https://hashscan.io/testnet/transaction/0x060a2c4c0a42f2673d99f155e5efb572144914b5b32d58ca00fd11b4d5d5947f), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x060a2c4c0a42f2673d99f155e5efb572144914b5b32d58ca00fd11b4d5d5947f), timestamp `1790432905.927433590`.
- `fund-offer-2`: [HashScan](https://hashscan.io/testnet/transaction/0x417c5cf6b1beb32dc67649a396e746b131765bcaf247e1ee2c6eb579075078b2), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x417c5cf6b1beb32dc67649a396e746b131765bcaf247e1ee2c6eb579075078b2), timestamp `1790432914.924187289`.
- `accept-offer-2`: [HashScan](https://hashscan.io/testnet/transaction/0x22cd5e3e6b5cc8734879d316b18b0a8bbd9838ba98dc586dec4c08334925379f), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x22cd5e3e6b5cc8734879d316b18b0a8bbd9838ba98dc586dec4c08334925379f), timestamp `1790432921.227235104`.
- `borrower-withdrawal`: [HashScan](https://hashscan.io/testnet/transaction/0x6dedf5f3c5cd1e63ffea23ee71eac86797678667f9b3c9ce9b92e58c7d7c31f6), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x6dedf5f3c5cd1e63ffea23ee71eac86797678667f9b3c9ce9b92e58c7d7c31f6), timestamp `1790432927.698740903`.
- `repay-position`: [HashScan](https://hashscan.io/testnet/transaction/0x5b9a0ca2be15cc59fb496c1d79dd3c2dc6e8a282fdcbb710b4ddbe91e13f039c), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5b9a0ca2be15cc59fb496c1d79dd3c2dc6e8a282fdcbb710b4ddbe91e13f039c), timestamp `1790432933.567776183`.
- `lender-withdrawal`: [HashScan](https://hashscan.io/testnet/transaction/0x3ad50b143a2a09c8e5257aa9fd4baed7bf4bec6d62cd39b6a3a098da5a3635e6), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3ad50b143a2a09c8e5257aa9fd4baed7bf4bec6d62cd39b6a3a098da5a3635e6), timestamp `1790432938.686843840`.

## Schedules

Each HashScan link returned HTTP 404 with no redirect. Each Mirror link returned
HTTP 200, the exact schedule ID, `deleted: false`, and the listed execution
timestamp.

- Repaid position schedule: [HashScan](https://hashscan.io/testnet/schedule/0.0.10730730), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10730730), executed at `1790433027.001780876`.
- Defaulted position schedule: [HashScan](https://hashscan.io/testnet/schedule/0.0.10730732), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10730732), executed at `1790433041.060326208`.

## Contracts

Each HashScan link returned HTTP 404 with no redirect. Each Mirror link returned
HTTP 200, the exact EVM address, `deleted: false`, and the listed Hedera contract
ID.

- ATS token: [HashScan](https://hashscan.io/testnet/contract/0xe4E087dC047798bCD76EF6DDDe58134D87663482), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/0xe4E087dC047798bCD76EF6DDDe58134D87663482), contract `0.0.10730717`.
- HIP-475 oracle adapter: [HashScan](https://hashscan.io/testnet/contract/0x6d217218836341603a73aCe669cBFBD778De1b9F), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/0x6d217218836341603a73aCe669cBFBD778De1b9F), contract `0.0.10730719`.
- Collateral rail: [HashScan](https://hashscan.io/testnet/contract/0xBb038155597b01D38eb61Af8A2d6117f79A14cB5), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/0xBb038155597b01D38eb61Af8A2d6117f79A14cB5), contract `0.0.10730723`.
- Acceptance verifier: [HashScan](https://hashscan.io/testnet/contract/0x9fF2B637d4f9bD750256C0D5D550FBfB5C19B9Aa), [Mirror](https://testnet.mirrornode.hedera.com/api/v1/contracts/0x9fF2B637d4f9bD750256C0D5D550FBfB5C19B9Aa), contract `0.0.10730726`.

## Current rail balance

The exact allowlisted [Mirror account source](https://testnet.mirrornode.hedera.com/api/v1/accounts/0xbb038155597b01d38eb61af8a2d6117f79a14cb5?transactions=false)
returned HTTP 200, account `0.0.10730723`, the exact rail EVM address, balance
`936603529` tinybar, and balance timestamp `1790433041.060326208`. The request
contains no historical timestamp and is therefore classified as a current
Mirror account balance, not a block-bound state read.

## Release interpretation

HashScan is an explorer convenience and is not the authoritative proof source.
Its current 404 responses do not invalidate the lifecycle. Mirror independently
confirms all public entities. Final contract state remains bound to the exact
Hashio RPC block, while solvency uses the separately typed current Mirror
account balance. The proof interface presents Mirror first, marks the dated
HashScan outage explicitly, and keeps the HashScan URLs available for retry if
the explorer restores deep-link service.
