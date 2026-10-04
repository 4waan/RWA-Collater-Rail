import assert from "node:assert/strict";
import test from "node:test";
import {
  htsEvidenceConstants,
  validateHtsEvidenceRecord,
} from "../lib/hts-evidence-lib.mjs";
import { toMirrorNativeTransactionId } from "../lib/native-transaction-id.mjs";

const MIRROR = htsEvidenceConstants.MIRROR_ORIGIN;
const HASHSCAN = "https://hashscan.io";
const RPC = "https://testnet.hashio.io";
const PARTITION = `0x${"0".repeat(63)}1`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function address(value) {
  return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function nativeHash(value) {
  return `0x${BigInt(value).toString(16).padStart(96, "0")}`;
}

function evmTransaction(value, kind, result = "SUCCESS") {
  const transactionHash = hash(value);
  return {
    type: "transaction",
    kind,
    hash: transactionHash,
    consensusTimestamp: `1700000${String(value).padStart(3, "0")}.123456789`,
    result,
    mirror: `${MIRROR}/api/v1/contracts/results/${transactionHash}`,
    hashScan: `${HASHSCAN}/testnet/transaction/${transactionHash}`,
  };
}

function nativeTransaction(value, kind) {
  const transactionId = `0.0.${100 + value}@1700000${String(value).padStart(3, "0")}.000000001`;
  const mirrorId = toMirrorNativeTransactionId(transactionId);
  return {
    type: "hedera-transaction",
    kind,
    transactionId,
    transactionHash: nativeHash(10_000 + value),
    consensusTimestamp: `1700000${String(value).padStart(3, "0")}.123456789`,
    result: "SUCCESS",
    mirror: `${MIRROR}/api/v1/transactions/${mirrorId}`,
    hashScan: `${HASHSCAN}/testnet/transaction/${transactionId}`,
  };
}

function schedule(entity, executedTimestamp = "1700002000.123456789") {
  const scheduleAddress = address(entity);
  const scheduleId = `0.0.${entity}`;
  return {
    type: "schedule",
    address: scheduleAddress,
    scheduleId,
    executedTimestamp,
    mirror: `${MIRROR}/api/v1/schedules/${scheduleId}`,
    hashScan: `${HASHSCAN}/testnet/schedule/${scheduleId}`,
  };
}

function state(blockNumber, assertions) {
  return {
    type: "state",
    blockNumber: String(blockNumber),
    rpcOrigin: RPC,
    assertions,
  };
}

function controlledEvidence() {
  const addresses = {
    factory: address(1),
    resolver: address(2),
    atsToken: address(3),
    settlementToken: address(4),
    oracle: address(5),
    rail: address(6),
    acceptance: address(7),
    pyth: null,
  };
  const actors = {
    issuer: { accountId: "0.0.101", evmAddress: address(101) },
    lender: { accountId: "0.0.102", evmAddress: address(102) },
    borrower: { accountId: "0.0.103", evmAddress: address(103) },
  };
  const tokenCreation = nativeTransaction(1, "settlement-token-creation");
  const atsDeployment = evmTransaction(2, "ats-bond-deployment-1");
  const initialization = evmTransaction(3, "settlement-initialization");
  const automationFunding = evmTransaction(12, "automation-funding");
  const provisionIssuer = nativeTransaction(4, "provision-issuer");
  const provisionLender = nativeTransaction(5, "provision-lender");
  const provisionBorrower = nativeTransaction(6, "provision-borrower");
  const fundOffer = evmTransaction(7, "fund-offer-1");
  const acceptOffer = evmTransaction(8, "accept-offer-1");
  const secondFund = evmTransaction(9, "fund-offer-2");
  const secondAccept = evmTransaction(10, "accept-offer-2");
  const repay = evmTransaction(11, "repay-position");
  const probeKinds = [
    "association",
    "kyc-revoked",
    "account-frozen",
    "token-paused",
    "insufficient-allowance",
  ];
  const rejected = probeKinds.map((kind, index) =>
    evmTransaction(20 + index, `probe-${kind}`, "CONTRACT_REVERT_EXECUTED"),
  );
  const recovered = probeKinds.map((kind, index) =>
    nativeTransaction(30 + index, `recover-${kind}`),
  );
  const transactions = [
    tokenCreation,
    atsDeployment,
    initialization,
    automationFunding,
    provisionIssuer,
    provisionLender,
    provisionBorrower,
    fundOffer,
    acceptOffer,
    secondFund,
    secondAccept,
    repay,
    ...rejected,
    ...recovered,
  ];
  const schedules = [schedule(1001), schedule(1002)];
  const positions = [
    {
      id: hash(101),
      lender: actors.lender.evmAddress,
      borrower: actors.borrower.evmAddress,
      collateralAmount: "10",
      holdId: "1",
      principalTokenUnits: "50000000",
      repaymentTokenUnits: "50500000",
      openedAt: 1_700_001_000,
      maturity: 1_700_001_120,
      scheduleAddress: schedules[0].address,
      state: "REPAID",
      automation: "COMPLETED",
      terminalPath: "repayment",
    },
    {
      id: hash(102),
      lender: actors.lender.evmAddress,
      borrower: actors.borrower.evmAddress,
      collateralAmount: "10",
      holdId: "2",
      principalTokenUnits: "50000000",
      repaymentTokenUnits: "50500000",
      openedAt: 1_700_001_001,
      maturity: 1_700_001_121,
      scheduleAddress: schedules[1].address,
      state: "DEFAULTED",
      automation: "COMPLETED",
      terminalPath: "hss",
    },
  ];
  const finalAssertions = {
    "rail.settlementInitialized": true,
    "rail.settlementDecimals": 6,
    "rail.cashTokenLiabilities": "0",
    "rail.settlementTokenBalance": "0",
    "rail.reservedAutomationTinybar": "0",
    "rail.hbarBalanceTinybar": "1000000",
    "rail.policy.maximumAdvanceBps": 6000,
    "rail.policy.maximumAnnualRateBps": 5000,
    "rail.policy.maximumQuoteMovementBps": 100,
    "rail.policy.minimumTermSeconds": 120,
    "rail.policy.maximumTermSeconds": 31_536_000,
    "rail.policy.maximumOfferLifetimeSeconds": 3600,
    "positions.repaidState": "REPAID",
    "positions.defaultedState": "DEFAULTED",
    "oracle.kind": "fixed-test",
    "oracle.priceUsdE8": "100000000",
    "oracle.confidenceUsdE8": "0",
    "oracle.observedAt": 1_700_000_000,
  };
  const finalState = state(999, finalAssertions);
  const holds = positions.map((position, index) => {
    const base = {
      positionId: position.id,
      holdId: position.holdId,
      holder: position.borrower,
      partition: PARTITION,
      amount: position.collateralAmount,
      expirationTimestamp: String(position.maturity + 60),
      escrow: addresses.rail,
      destination: ZERO_ADDRESS,
      data: position.id,
      operatorData: "0x",
      thirdPartyType: 0,
    };
    return {
      ...base,
      state: state(500 + index, {
        "hold.positionId": base.positionId,
        "hold.holdId": base.holdId,
        "hold.holder": base.holder,
        "hold.partition": base.partition,
        "hold.amount": base.amount,
        "hold.expirationTimestamp": base.expirationTimestamp,
        "hold.escrow": base.escrow,
        "hold.destination": base.destination,
        "hold.data": base.data,
        "hold.operatorData": base.operatorData,
        "hold.thirdPartyType": base.thirdPartyType,
      }),
      terminalState: state(999, {
        "hold.positionId": base.positionId,
        "hold.holdId": base.holdId,
        "hold.holder": base.holder,
        "hold.partition": base.partition,
        "hold.remainingAmount": "0",
        "hold.deleted": true,
      }),
    };
  });
  const tokenId = "0.0.5000";
  const settlementToken = {
    tokenId,
    evmAddress: addresses.settlementToken,
    name: "Controlled Test Dollar",
    symbol: "CTD",
    decimals: 6,
    type: "FUNGIBLE_COMMON",
    deleted: false,
    freezeDefault: false,
    pauseStatus: "UNPAUSED",
    kycKey: true,
    freezeKey: true,
    pauseKey: true,
    feeScheduleKey: false,
    fixedFeeCount: 0,
    fractionalFeeCount: 0,
    royaltyFeeCount: 0,
    mirror: `${MIRROR}/api/v1/tokens/${tokenId}`,
    verifiedAt: "2026-09-27T00:00:01.000Z",
  };
  const tokenTransfers = [
    [provisionLender, actors.issuer.evmAddress, actors.lender.evmAddress],
    [provisionBorrower, actors.issuer.evmAddress, actors.borrower.evmAddress],
    [fundOffer, actors.lender.evmAddress, addresses.rail],
    [acceptOffer, addresses.rail, actors.borrower.evmAddress],
    [repay, actors.borrower.evmAddress, addresses.rail],
    [secondFund, actors.lender.evmAddress, addresses.rail],
    [secondAccept, addresses.rail, actors.borrower.evmAddress],
  ].map(([transaction, from, to], index) => ({
    type: "token-transfer",
    transaction,
    tokenId,
    from,
    to,
    amount: String(1_000_000 + index),
    mirror: transaction.mirror,
  }));
  const settlementBalances = [
    [actors.lender, "100000000"],
    [actors.borrower, "100000000"],
    [{ accountId: "0.0.600", evmAddress: addresses.rail }, "0"],
  ].map(([actor, balanceTokenUnits]) => ({
    type: "token-balance",
    basis: "current-mirror-token-relationship",
    tokenId,
    accountId: actor.accountId,
    evmAddress: actor.evmAddress,
    associated: true,
    kycStatus: "GRANTED",
    freezeStatus: "UNFROZEN",
    balanceTokenUnits,
    checkedAt: "2026-09-27T00:00:01.000Z",
    mirror: `${MIRROR}/api/v1/accounts/${actor.accountId}/tokens?token.id=${tokenId}`,
  }));
  const sourceUrls = {
    factoryHashScan: `${HASHSCAN}/testnet/contract/${addresses.factory}`,
    factoryMirror: `${MIRROR}/api/v1/contracts/${addresses.factory}`,
    resolverHashScan: `${HASHSCAN}/testnet/contract/${addresses.resolver}`,
    resolverMirror: `${MIRROR}/api/v1/contracts/${addresses.resolver}`,
    atsTokenHashScan: `${HASHSCAN}/testnet/contract/${addresses.atsToken}`,
    atsTokenMirror: `${MIRROR}/api/v1/contracts/${addresses.atsToken}`,
    settlementTokenHashScan: `${HASHSCAN}/testnet/token/${tokenId}`,
    settlementTokenMirror: settlementToken.mirror,
    oracleHashScan: `${HASHSCAN}/testnet/contract/${addresses.oracle}`,
    oracleMirror: `${MIRROR}/api/v1/contracts/${addresses.oracle}`,
    railHashScan: `${HASHSCAN}/testnet/contract/${addresses.rail}`,
    railMirror: `${MIRROR}/api/v1/contracts/${addresses.rail}`,
    acceptanceHashScan: `${HASHSCAN}/testnet/contract/${addresses.acceptance}`,
    acceptanceMirror: `${MIRROR}/api/v1/contracts/${addresses.acceptance}`,
  };
  const expectedHashScanLinks = transactions.length + schedules.length + 7;
  const expectedMirrorLinks =
    transactions.length + schedules.length + 7 + settlementBalances.length + 1;

  return {
    schemaVersion: 1,
    evidenceKind: "hts-settlement",
    settlementProfile: "controlled-test",
    network: "hedera-testnet",
    chainId: 296,
    status: "verified",
    generatedAt: "2026-09-27T00:00:01.000Z",
    recipeId: null,
    policy: {
      maximumAdvanceBps: 6000,
      maximumAnnualRateBps: 5000,
      maximumQuoteMovementBps: 100,
      minimumTermSeconds: 120,
      maximumTermSeconds: 31_536_000,
      maximumOfferLifetimeSeconds: 3600,
    },
    addresses,
    actors,
    settlementToken,
    oracle: {
      kind: "fixed-test",
      priceUsdE8: "100000000",
      confidenceUsdE8: "0",
      observedAt: 1_700_000_000,
      purpose: "controlled mechanics only",
      limitation:
        "This fixed value proves mechanics only and is not evidence of market value.",
    },
    transactions,
    tokenTransfers,
    lifecycle: {
      atsBondDeployment: atsDeployment,
      settlementTokenCreation: tokenCreation,
      settlementInitialization: initialization,
      automationFunding,
      actorProvisioning: [provisionIssuer, provisionLender, provisionBorrower],
      oracleUpdate: null,
      fundedOffer: fundOffer,
      holdCreation: acceptOffer,
      repaidFacility: repay,
      maturedDefault: schedules[1],
      liveConfigurationRead: finalState,
    },
    complianceProbes: probeKinds.map((kind, index) => ({
      kind,
      expectedFailure: `Expected ${kind} rejection`,
      rejectedTransaction: rejected[index],
      recoveryTransaction: recovered[index],
      verified: true,
    })),
    ats: {
      internalKyc: true,
      issuer: true,
      kyc: { lender: 1, borrower: 1 },
      roles: { issuer: true, kyc: true, ssiManager: true },
      assetMaturity: "1800000000",
      clearingActive: false,
      tokenDecimals: 0,
      nominalValue: "10000",
      nominalValueDecimals: 2,
      nominalValueCurrency: "0x555344",
      balances: {
        borrower: { free: "980", held: "0" },
        lender: { free: "20", held: "0" },
      },
    },
    positions,
    holds,
    schedules,
    accounting: {
      cashTokenLiabilities: "0",
      railTokenBalance: "0",
      reservedAutomationTinybar: "0",
      railHbarBalanceTinybar: "1000000",
    },
    verification: {
      complete: true,
      state: finalState,
      settlementBalances,
      hbarBalance: {
        type: "balance",
        basis: "current-mirror-account",
        accountId: "0.0.600",
        evmAddress: addresses.rail,
        balanceTinybar: "1000000",
        balanceTimestamp: "1700002000.123456789",
        checkedAt: "2026-09-27T00:00:01.000Z",
        mirror: `${MIRROR}/api/v1/accounts/${addresses.rail.toLowerCase()}?transactions=false`,
      },
      mirrorOrigin: MIRROR,
      sourceUrls,
      linkAudit: {
        checkedAt: "2026-09-27T00:00:01.000Z",
        hashScanStatus: "available",
        mirrorStatus: "verified",
        hashScanChecked: expectedHashScanLinks,
        mirrorChecked: expectedMirrorLinks,
        finding: null,
      },
    },
    metrics: {
      startedAt: "2026-09-27T00:00:00.000Z",
      completedAt: "2026-09-27T00:00:01.000Z",
      elapsedMilliseconds: 1000,
      mirrorConfirmedTransactions: transactions.length,
    },
    limitations: [
      "The controlled settlement token and fixed oracle exist only for test mechanics.",
    ],
    notice:
      "Observed on Hedera testnet. This record is evidence, not a production assurance claim.",
  };
}

function circleEvidence() {
  const record = controlledEvidence();
  const pythUpdate = evmTransaction(1, "pyth-price-refresh");
  record.transactions[0] = pythUpdate;
  record.settlementProfile = "circle-usdc";
  record.recipeId = "hts-usdc-term-credit";
  record.addresses.settlementToken = htsEvidenceConstants.CIRCLE_USDC_ADDRESS;
  record.addresses.pyth = address(8);
  record.settlementToken = {
    ...record.settlementToken,
    tokenId: htsEvidenceConstants.CIRCLE_USDC_ID,
    evmAddress: htsEvidenceConstants.CIRCLE_USDC_ADDRESS,
    name: "USD Coin",
    symbol: "USDC",
    kycKey: false,
    freezeKey: true,
    pauseKey: false,
    mirror: `${MIRROR}/api/v1/tokens/${htsEvidenceConstants.CIRCLE_USDC_ID}`,
  };
  record.oracle = {
    kind: "pyth",
    feedId: htsEvidenceConstants.USDC_USD_PRICE_ID,
    priceUsdE8: "99990000",
    confidenceUsdE8: "1000",
    observedAt: 1_700_000_000,
    purpose: "Circle testnet USDC collateral-coverage valuation",
    updateTransaction: pythUpdate,
  };
  record.lifecycle.settlementTokenCreation = null;
  record.lifecycle.oracleUpdate = pythUpdate;
  record.complianceProbes = record.complianceProbes.filter((probe) =>
    ["association", "insufficient-allowance"].includes(probe.kind),
  );
  record.tokenTransfers = record.tokenTransfers.map((transfer) => ({
    ...transfer,
    tokenId: htsEvidenceConstants.CIRCLE_USDC_ID,
  }));
  record.verification.settlementBalances =
    record.verification.settlementBalances.map((proof) => ({
      ...proof,
      tokenId: htsEvidenceConstants.CIRCLE_USDC_ID,
      kycStatus: "NOT_APPLICABLE",
      mirror: `${MIRROR}/api/v1/accounts/${proof.accountId}/tokens?token.id=${htsEvidenceConstants.CIRCLE_USDC_ID}`,
    }));
  record.verification.sourceUrls.settlementTokenHashScan = `${HASHSCAN}/testnet/token/${htsEvidenceConstants.CIRCLE_USDC_ID}`;
  record.verification.sourceUrls.settlementTokenMirror =
    record.settlementToken.mirror;
  Object.assign(record.verification.state.assertions, {
    "oracle.kind": "pyth",
    "oracle.priceUsdE8": record.oracle.priceUsdE8,
    "oracle.confidenceUsdE8": record.oracle.confidenceUsdE8,
  });
  record.limitations = [
    "Circle testnet USDC and the live Pyth feed demonstrate market-valued mechanics only.",
  ];
  return record;
}

test("controlled HTS evidence validates native and EVM proofs separately", () => {
  const record = controlledEvidence();
  assert.equal(validateHtsEvidenceRecord(record), record);
});

test("Circle USDC evidence validates the pinned token and Pyth feed", () => {
  const record = circleEvidence();
  assert.equal(validateHtsEvidenceRecord(record), record);
});

test("Circle evidence rejects the wrong token identity, decimals, and fees", () => {
  for (const mutate of [
    (record) => {
      record.settlementToken.tokenId = "0.0.1";
    },
    (record) => {
      record.settlementToken.decimals = 8;
    },
    (record) => {
      record.settlementToken.fractionalFeeCount = 1;
    },
  ]) {
    const record = circleEvidence();
    mutate(record);
    assert.throws(
      () => validateHtsEvidenceRecord(record),
      /token metadata|USDC/,
    );
  }
});

test("oracle evidence cannot cross the controlled and Circle profiles", () => {
  const controlled = controlledEvidence();
  controlled.oracle = circleEvidence().oracle;
  assert.throws(
    () => validateHtsEvidenceRecord(controlled),
    /test-only oracle/,
  );

  const circle = circleEvidence();
  circle.oracle = controlledEvidence().oracle;
  assert.throws(() => validateHtsEvidenceRecord(circle), /Pyth USDC/);
});

test("HTS evidence rejects missing transfer proofs and fake links", () => {
  const transfers = controlledEvidence();
  transfers.tokenTransfers = [];
  assert.throws(() => validateHtsEvidenceRecord(transfers), /transfer proofs/);

  const link = controlledEvidence();
  link.verification.sourceUrls.railMirror = "https://attacker.invalid/rail";
  assert.throws(() => validateHtsEvidenceRecord(link), /source URL/);
});

test("HTS evidence rejects duplicate and failed lifecycle transactions", () => {
  const duplicate = controlledEvidence();
  duplicate.transactions.push(duplicate.transactions[0]);
  duplicate.metrics.mirrorConfirmedTransactions += 1;
  duplicate.verification.linkAudit.hashScanChecked += 1;
  duplicate.verification.linkAudit.mirrorChecked += 1;
  assert.throws(() => validateHtsEvidenceRecord(duplicate), /duplicate/);

  const failed = controlledEvidence();
  failed.lifecycle.fundedOffer.result = "CONTRACT_REVERT_EXECUTED";
  assert.throws(() => validateHtsEvidenceRecord(failed), /transaction proof/);
});

test("native proof URLs and hashes cannot masquerade as EVM proofs", () => {
  const record = controlledEvidence();
  record.lifecycle.settlementTokenCreation.mirror = `${MIRROR}/api/v1/contracts/results/${record.lifecycle.settlementTokenCreation.transactionHash}`;
  assert.throws(() => validateHtsEvidenceRecord(record), /native transaction/);
});

test("HSS proof must bind the schedule address, ID, and execution", () => {
  const mismatch = controlledEvidence();
  mismatch.lifecycle.maturedDefault.scheduleId = "0.0.9999";
  assert.throws(() => validateHtsEvidenceRecord(mismatch), /schedule proof/);

  const unexecuted = controlledEvidence();
  unexecuted.lifecycle.maturedDefault.executedTimestamp = null;
  assert.throws(() => validateHtsEvidenceRecord(unexecuted), /execution/);
});

test("terminal paths must agree with the position state", () => {
  const record = controlledEvidence();
  record.positions[0].terminalPath = "hss";
  assert.throws(() => validateHtsEvidenceRecord(record), /terminal paths/);
});

test("token and HBAR solvency remain independent", () => {
  const token = controlledEvidence();
  token.accounting.cashTokenLiabilities = "1";
  token.verification.state.assertions["rail.cashTokenLiabilities"] = "1";
  assert.throws(() => validateHtsEvidenceRecord(token), /insolvent/);

  const hbar = controlledEvidence();
  hbar.accounting.reservedAutomationTinybar = "1000001";
  hbar.verification.state.assertions["rail.reservedAutomationTinybar"] =
    "1000001";
  assert.throws(() => validateHtsEvidenceRecord(hbar), /insolvent/);
});

test("exact-block accounting and current Mirror balances must agree", () => {
  const stateMismatch = controlledEvidence();
  stateMismatch.verification.state.assertions["rail.settlementTokenBalance"] =
    "1";
  assert.throws(() => validateHtsEvidenceRecord(stateMismatch), /state proof/);

  const balanceMismatch = controlledEvidence();
  balanceMismatch.verification.settlementBalances.find(
    (proof) =>
      proof.evmAddress.toLowerCase() ===
      balanceMismatch.addresses.rail.toLowerCase(),
  ).balanceTokenUnits = "1";
  assert.throws(
    () => validateHtsEvidenceRecord(balanceMismatch),
    /Mirror token/,
  );
});

test("current balance proofs reject non-authoritative URLs", () => {
  const record = controlledEvidence();
  record.verification.settlementBalances[0].mirror =
    "https://attacker.invalid/api/v1/accounts/0.0.101/tokens";
  assert.throws(() => validateHtsEvidenceRecord(record), /token balance proof/);
});

test("HTS evidence rejects forbidden secret-shaped fields", () => {
  const record = controlledEvidence();
  record.verification.operatorPrivateKey = "redacted";
  assert.throws(() => validateHtsEvidenceRecord(record), /forbidden field/);
});

test("controlled evidence requires every compliance failure and recovery", () => {
  const missing = controlledEvidence();
  missing.complianceProbes = missing.complianceProbes.filter(
    (probe) => probe.kind !== "token-paused",
  );
  assert.throws(() => validateHtsEvidenceRecord(missing), /token-paused/);

  const falseSuccess = controlledEvidence();
  falseSuccess.complianceProbes[0].rejectedTransaction.result = "SUCCESS";
  assert.throws(
    () => validateHtsEvidenceRecord(falseSuccess),
    /failed transaction/,
  );
});
