# Collateral mobility state machine

The Hedera application owns the ATS hold and HSS automation reserve. The peer
application owns the controlled settlement-token escrow and token liabilities.

## Activation

1. The lender funds a remote offer.
2. Verified `OFFER_FUNDED` creates its Hedera representation.
3. The borrower accepts and Hedera creates the ATS hold.
4. Verified `COLLATERAL_LOCKED` creates a remote borrower principal credit.
5. The borrower withdraws the principal.
6. Verified `PRINCIPAL_WITHDRAWN` opens the Hedera position and fixes maturity
   from the proven withdrawal time plus the agreed term.

## Repayment

1. The remote borrower escrows exact repayment.
2. Verified `REPAYMENT_ESCROWED` releases the ATS hold if the position remains
   open and repayment wins the local terminal ordering.
3. Verified `REPAYMENT_ACCEPTED` creates a remote lender credit.
4. The lender withdraws separately.

## Default

HSS or permissionless `settle` executes the ATS hold after maturity. A local
`DEFAULT_CONFIRMED` outbox item is retryable independently of the terminal
action. Verified default turns a pending remote repayment into a borrower
refund and can never create lender repayment credit.

## Failure rules

- Before collateral lock, an expired remote offer refunds the lender.
- After collateral lock, Hedera releases only after verified remote
  cancellation or refund state.
- After principal withdrawal, cancellation is forbidden.
- A late principal proof opens the position with its original source-derived
  maturity. If maturity passed, permissionless default is immediately allowed.
- A repayment seen remotely but not verified on Hedera cannot undo a completed
  default. The remote repayment is refunded after verified default.
- Duplicate messages return their recorded result. Reusing the same semantic
  key with different bytes is a conflict and reverts.
- Permanent proof unavailability leaves ambiguous collateral frozen. This is a
  deliberate safety-over-liveness choice.

## Accounting invariants

```text
remoteTokenBalance >= remoteCashLiabilities
hederaHbarBalance >= reservedAutomation
holdsCreated == collateralAccepted
terminalActions == repaidPositions + defaultedPositions + cancelledLockedPositions
openPositions == activatedPositions - repaidPositions - defaultedPositions
repaymentPayouts + repaymentRefunds == finalizedRepaymentEscrows
```
