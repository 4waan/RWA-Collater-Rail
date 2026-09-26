# Architecture

## Boundary

`AtsCollateralRail` is a bilateral obligation manager. It is bound at deployment
to one ATS token, one partition, one HBAR/USD settlement-conversion adapter, the
token decimal count, a configured nominal value, and an immutable rail policy.
It does not discover assets, match orders, pool funds, or calculate a security
market price.

Financing recipes sit above this kernel. A recipe selects safe policy limits and
starting terms without changing custody, accounting, automation, or terminal
state behavior. This keeps product experimentation separate from the invariants
that protect cash and collateral.

## State transitions

```text
funded offer
  | cancel
  +----------> lender credit
  |
  | accept after policy validation and hold inspection
  v
OPEN
  | repay before or after maturity       | settle at or after maturity
  v                                      v
REPAID                                DEFAULTED
  |                                      |
hold released to borrower             hold executed to lender
```

Terminal calls are idempotent. A second `settle` after default returns `false`.
A scheduled `settle` after repayment completes the automation record without
touching collateral.

## Cash accounting

The invariant is:

```text
contract HBAR balance >= cashLiabilities + reservedAutomation
```

`cashLiabilities` covers funded offers and credited withdrawals. Acceptance
changes the beneficiary of principal from an offer to borrower credit without
changing the liability total. Cancellation does the same for lender credit.
Repayment adds a new lender liability. Withdrawal reduces liability before the
external call, and a reentrancy lock protects the full path.

The HSS reserve is not lender principal. `withdrawUnusedAutomation` can reach
only balance above user liabilities and pending schedule reserves.

Hedera has two native value units at this boundary. JSON RPC transaction
values and `eth_getBalance` use 18-decimal weibars. Solidity `msg.value`,
`address.balance`, and every rail cash amount use 8-decimal tinybars. Client
and runner code converts by exactly 10,000,000,000 only when values cross the
JSON RPC boundary. Contract accounting remains entirely in tinybars.

## Collateral accounting

The borrower grants the rail an ATS allowance. Acceptance checks:

1. borrower and lender internal KYC;
2. offer expiry and self-dealing;
3. configured collateral coverage;
4. a valid settlement conversion and at most 1% movement from funding;
5. free partition balance and allowance;
6. asset maturity after facility maturity.

The rail then asks ATS to create an escrow hold with no destination and an
effectively open expiry. It reads the hold back and validates amount, escrow,
destination, data binding, authorized third-party type, and expiry before
opening the position. ATS balance adjustments can change the hold amount later.
Each terminal path repeats the identity checks, drains the current amount, and
requires the hold to be absent afterward.

`balanceOfByPartition` is displayed as free balance. Held balance is read from
`getHeldAmountForByPartition` and shown independently.

## Automation

The rail inherits the official `HederaScheduleService` helper from
`@hiero-ledger/hiero-contracts@0.2.0`. After storing the obligation, it probes
maturity plus 2, 5, and 10 seconds. A schedule is accepted only when capacity is
available, the response code equals 22, and the returned address is nonzero.

All HSS errors are caught. The position stays open and recoverable with public
`settle` if every attempt fails. The public fallback is the correctness path;
HSS improves liveness.

## Trust model

- ATS enforces native balances, allowance, and hold mechanics.
- The rail enforces facility policy before asking ATS to hold.
- The default HIP-475 adapter reads Hedera's active network settlement
  conversion rate. It is not trusted or described as a live market price.
- The optional Pyth adapter is trusted only for HBAR/USD cash conversion within
  freshness and confidence bounds. Pyth mode must be explicitly configured.
- HSS may fail or be saturated without blocking acceptance or recovery.
- Mirror Node supplies historical evidence, but direct contract reads determine current state.
- The deployment operator controls ATS issuance and KYC setup, but cannot seize rail credits.

## Evidence model

Public evidence is typed by what the network actually proves:

- a transaction proof contains a successful Mirror-confirmed hash, consensus
  timestamp, and HashScan link;
- a schedule proof contains the long-zero address, Hedera schedule ID,
  execution timestamp when applicable, and HashScan link;
- a state proof contains the Hedera block number, approved RPC origin, and the
  exact assertions read at that block.

Oracle evidence is also discriminated by source. A HIP-475 record names system
contract `0x168`, system file `0.0.112`, the observed settlement rate, its block
state proof, and the required network-rate caveat. It must not contain a Pyth
update transaction. A Pyth record names the feed, price, confidence, publish
time, and the successful Mirror-confirmed update transaction. The interface and
documentation render the label, source, caveat, and proof from this typed field.

An HSS default uses the executed schedule plus a later terminal state proof. A
permissionless default uses its successful settlement transaction plus the same
final state checks. The runner never submits or cites a later no-op call as proof
that HSS performed the earlier terminal action.

The public reference file is replaced atomically only after the complete record
passes relationship validation, live Mirror and RPC verification, receipt-event
binding, final hold reads, and secret scanning. A failed run leaves the previous
public state untouched.

## External calls

All ATS state-changing calls are behind the local reentrancy lock. State changes
made before an ATS call revert atomically if that call fails. Native payouts use
a pull model, so a recipient that rejects HBAR cannot block another transition.
