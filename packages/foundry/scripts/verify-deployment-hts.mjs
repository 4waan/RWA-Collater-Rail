import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  parseEventLogs,
} from "viem";
import {
  atsAbi,
  fixedTestUsdOracleAbi,
  htsAcceptanceAbi,
  htsRailAbi,
  htsTokenAbi,
  usdOracleAbi,
} from "@collateral-rail/shared/abis";
import {
  DEFAULT_PARTITION,
  weibarToTinybar,
} from "@collateral-rail/shared/hedera";
import {
  DEFAULT_MIRROR_URL,
  DEFAULT_RPC_URL,
  confirmMirrorAccountIdentity,
  confirmMirrorSchedule,
  fetchAllowedJson,
  fetchMirrorPages,
  readCurrentMirrorBalance,
  validatedEndpoint,
} from "./lib/evidence-lib.mjs";
import {
  htsEvidenceConstants,
  validateHtsEvidenceRecord,
} from "./lib/hts-evidence-lib.mjs";
import { ROLE_ISSUER, ROLE_KYC, ROLE_SSI_MANAGER } from "./lib/demo-runtime.ts";

const recordPath = path.resolve(
  process.argv[2] ?? "deployments/testnet-hts-controlled.json",
);
const record = validateHtsEvidenceRecord(
  JSON.parse(await readFile(recordPath, "utf8")),
);
const mirrorOrigin = validatedEndpoint(
  "mirror",
  process.env.HEDERA_MIRROR_URL ?? DEFAULT_MIRROR_URL,
);
const rpcUrl = validatedEndpoint(
  "rpc",
  process.env.HEDERA_TESTNET_RPC_URL ?? DEFAULT_RPC_URL,
);
const chain = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 15_000 }),
});
const verifiedBlock = BigInt(record.verification.state.blockNumber);
const transactionRecords = new Map();
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} differs from the evidence record.`);
  }
}

function requireAddress(name) {
  const value = record.addresses[name];
  if (!isAddress(value ?? "")) throw new Error(`Missing ${name} address.`);
  return value;
}

function tokenAddressFromId(tokenId) {
  const entity = tokenId.split(".").at(-1);
  if (!/^\d+$/.test(entity ?? "")) throw new Error("Invalid token ID.");
  return `0x${BigInt(entity).toString(16).padStart(40, "0")}`;
}

function nativeHash(value) {
  if (typeof value !== "string") return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 48 ? `0x${bytes.toString("hex")}` : null;
}

async function readMirrorTransaction(identifier, consensusTimestamp) {
  const key = `${identifier}:${consensusTimestamp}`;
  if (transactionRecords.has(key)) return transactionRecords.get(key);
  const values = await fetchMirrorPages({
    mirrorOrigin,
    pathname: `/api/v1/transactions/${encodeURIComponent(identifier)}`,
    collectionKey: "transactions",
  });
  const matches = values.filter(
    (value) =>
      value?.consensus_timestamp === consensusTimestamp &&
      Number(value?.nonce ?? 0) === 0,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Mirror returned ${matches.length} base records for ${identifier}.`,
    );
  }
  transactionRecords.set(key, matches[0]);
  return matches[0];
}

async function verifyTransaction(proof) {
  if (proof.type === "transaction") {
    const contractResult = await fetchAllowedJson(
      new URL(
        `/api/v1/contracts/results/${encodeURIComponent(proof.hash)}`,
        mirrorOrigin,
      ),
      new URL(mirrorOrigin).origin,
    );
    assertEqual(
      String(contractResult.hash ?? "").toLowerCase(),
      proof.hash.toLowerCase(),
      "EVM transaction hash",
    );
    assertEqual(
      contractResult.timestamp,
      proof.consensusTimestamp,
      "EVM consensus timestamp",
    );
    const succeeded =
      contractResult.status === "0x1" && contractResult.error_message === null;
    assertEqual(succeeded, proof.result === "SUCCESS", "EVM result status");
    const transaction = await readMirrorTransaction(
      proof.hash,
      proof.consensusTimestamp,
    );
    assertEqual(transaction.result, proof.result, "EVM Hedera result");
    return transaction;
  }

  const transaction = await readMirrorTransaction(
    proof.transactionId,
    proof.consensusTimestamp,
  );
  assertEqual(transaction.result, proof.result, "Native Hedera result");
  assertEqual(
    nativeHash(transaction.transaction_hash),
    proof.transactionHash.toLowerCase(),
    "Native transaction hash",
  );
  return transaction;
}

async function requireReceiptEvent({ proof, address, abi, eventName }) {
  if (proof.type !== "transaction") {
    throw new Error(`${eventName} is not bound to an EVM transaction.`);
  }
  const receipt = await client.getTransactionReceipt({ hash: proof.hash });
  if (receipt.status !== "success") {
    throw new Error(`${eventName} receipt did not succeed.`);
  }
  const events = parseEventLogs({
    abi,
    eventName,
    strict: true,
    logs: receipt.logs.filter((log) => sameAddress(log.address, address)),
  });
  if (events.length !== 1) {
    throw new Error(`${eventName} receipt contained ${events.length} events.`);
  }
  return events[0].args;
}

async function verifyTokenMetadata() {
  const token = await fetchAllowedJson(
    new URL(`/api/v1/tokens/${record.settlementToken.tokenId}`, mirrorOrigin),
    new URL(mirrorOrigin).origin,
  );
  const fixedFees = token.custom_fees?.fixed_fees;
  const fractionalFees = token.custom_fees?.fractional_fees;
  if (!Array.isArray(fixedFees) || !Array.isArray(fractionalFees)) {
    throw new Error("Mirror token metadata omitted custom fee arrays.");
  }
  const comparisons = [
    [token.token_id, record.settlementToken.tokenId, "token ID"],
    [token.name, record.settlementToken.name, "token name"],
    [token.symbol, record.settlementToken.symbol, "token symbol"],
    [Number(token.decimals), record.settlementToken.decimals, "token decimals"],
    [token.type, record.settlementToken.type, "token type"],
    [token.deleted, record.settlementToken.deleted, "token deletion"],
    [
      token.freeze_default,
      record.settlementToken.freezeDefault,
      "freeze default",
    ],
    [token.pause_status, record.settlementToken.pauseStatus, "pause status"],
    [token.kyc_key !== null, record.settlementToken.kycKey, "KYC key"],
    [token.freeze_key !== null, record.settlementToken.freezeKey, "freeze key"],
    [token.pause_key !== null, record.settlementToken.pauseKey, "pause key"],
    [
      token.fee_schedule_key !== null,
      record.settlementToken.feeScheduleKey,
      "fee schedule key",
    ],
    [fixedFees.length, record.settlementToken.fixedFeeCount, "fixed fees"],
    [
      fractionalFees.length,
      record.settlementToken.fractionalFeeCount,
      "fractional fees",
    ],
    [0, record.settlementToken.royaltyFeeCount, "royalty fees"],
  ];
  for (const [actual, expected, label] of comparisons) {
    assertEqual(actual, expected, label);
  }
  assertEqual(
    tokenAddressFromId(token.token_id),
    record.settlementToken.evmAddress.toLowerCase(),
    "token EVM address",
  );
}

async function verifyCurrentTokenBalances() {
  for (const proof of record.verification.settlementBalances) {
    const payload = await fetchAllowedJson(
      new URL(
        `/api/v1/accounts/${proof.accountId}/tokens?token.id=${proof.tokenId}`,
        mirrorOrigin,
      ),
      new URL(mirrorOrigin).origin,
    );
    if (!Array.isArray(payload.tokens) || payload.tokens.length !== 1) {
      throw new Error(
        `Mirror did not return one token relationship for ${proof.accountId}.`,
      );
    }
    const relationship = payload.tokens[0];
    assertEqual(relationship.token_id, proof.tokenId, "relationship token ID");
    assertEqual(
      String(relationship.balance),
      proof.balanceTokenUnits,
      "token balance",
    );
    assertEqual(relationship.kyc_status, proof.kycStatus, "token KYC status");
    assertEqual(
      relationship.freeze_status,
      proof.freezeStatus,
      "token freeze status",
    );
  }
}

async function verifyTokenTransfer(transfer) {
  const transaction = await readMirrorTransaction(
    transfer.transaction.type === "transaction"
      ? transfer.transaction.hash
      : transfer.transaction.transactionId,
    transfer.transaction.consensusTimestamp,
  );
  if (!Array.isArray(transaction.token_transfers)) {
    throw new Error("Mirror transaction omitted token transfers.");
  }
  const addressToAccount = new Map(
    [
      ...Object.values(record.actors),
      {
        accountId: record.verification.hbarBalance.accountId,
        evmAddress: record.addresses.rail,
      },
    ].map((identity) => [
      identity.evmAddress.toLowerCase(),
      identity.accountId,
    ]),
  );
  const from = addressToAccount.get(transfer.from.toLowerCase());
  const to = addressToAccount.get(transfer.to.toLowerCase());
  if (!from || !to) {
    throw new Error("Token transfer proof uses an unknown public identity.");
  }
  const outgoing = transaction.token_transfers.some(
    (item) =>
      item.token_id === transfer.tokenId &&
      item.account === from &&
      BigInt(item.amount) === -BigInt(transfer.amount),
  );
  const incoming = transaction.token_transfers.some(
    (item) =>
      item.token_id === transfer.tokenId &&
      item.account === to &&
      BigInt(item.amount) === BigInt(transfer.amount),
  );
  if (!outgoing || !incoming) {
    throw new Error("Mirror token transfer differs from its typed proof.");
  }
}

const factory = requireAddress("factory");
const resolver = requireAddress("resolver");
const atsToken = requireAddress("atsToken");
const settlementToken = requireAddress("settlementToken");
const oracle = requireAddress("oracle");
const rail = requireAddress("rail");
const acceptance = requireAddress("acceptance");
const issuer = record.actors.issuer.evmAddress;
const lender = record.actors.lender.evmAddress;
const borrower = record.actors.borrower.evmAddress;

const contractEntities = {
  factory,
  resolver,
  atsToken,
  oracle,
  rail,
  acceptance,
};
if (record.settlementProfile === "circle-usdc") {
  contractEntities.pyth = requireAddress("pyth");
}
for (const [name, address] of Object.entries(contractEntities)) {
  const entity = await fetchAllowedJson(
    new URL(`/api/v1/contracts/${address}`, mirrorOrigin),
    new URL(mirrorOrigin).origin,
  );
  if (!entity.contract_id && !entity.evm_address) {
    throw new Error(`Mirror did not confirm ${name}.`);
  }
}
await verifyTokenMetadata();
for (const actor of Object.values(record.actors)) {
  await confirmMirrorAccountIdentity({
    mirrorOrigin,
    accountId: actor.accountId,
    evmAddress: actor.evmAddress,
  });
}
for (const proof of record.transactions) await verifyTransaction(proof);
if (record.lifecycle.settlementTokenCreation) {
  const creation = await readMirrorTransaction(
    record.lifecycle.settlementTokenCreation.transactionId,
    record.lifecycle.settlementTokenCreation.consensusTimestamp,
  );
  assertEqual(
    creation.entity_id,
    record.settlementToken.tokenId,
    "created settlement token ID",
  );
}
for (const expected of record.schedules) {
  const actual = await confirmMirrorSchedule({
    mirrorOrigin,
    scheduleAddress: expected.address,
  });
  for (const key of ["scheduleId", "executedTimestamp", "mirror", "hashScan"]) {
    assertEqual(actual[key], expected[key], `schedule ${key}`);
  }
}
for (const transfer of record.tokenTransfers)
  await verifyTokenTransfer(transfer);
await verifyCurrentTokenBalances();

if (record.oracle.kind === "pyth") {
  const updateEvent = await requireReceiptEvent({
    proof: record.oracle.updateTransaction,
    address: oracle,
    abi: usdOracleAbi,
    eventName: "PriceUpdated",
  });
  assertEqual(
    updateEvent.priceUsdE8.toString(),
    record.oracle.priceUsdE8,
    "Pyth update event price",
  );
  assertEqual(
    Number(updateEvent.publishTime),
    record.oracle.observedAt,
    "Pyth update event time",
  );
}

const initializationEvent = await requireReceiptEvent({
  proof: record.lifecycle.settlementInitialization,
  address: rail,
  abi: htsRailAbi,
  eventName: "SettlementInitialized",
});
assertEqual(
  initializationEvent.token.toLowerCase(),
  settlementToken.toLowerCase(),
  "initialized settlement token",
);
assertEqual(
  Number(initializationEvent.decimals),
  record.settlementToken.decimals,
  "initialized settlement decimals",
);
assertEqual(
  initializationEvent.kycNotApplicable,
  !record.settlementToken.kycKey,
  "initialized settlement KYC applicability",
);

const currentHbarBalance = await readCurrentMirrorBalance({
  mirrorOrigin,
  evmAddress: rail,
});
assertEqual(
  currentHbarBalance.accountId,
  record.verification.hbarBalance.accountId,
  "rail account ID",
);
assertEqual(
  currentHbarBalance.balanceTinybar,
  record.verification.hbarBalance.balanceTinybar,
  "rail HBAR balance",
);

const [
  boundAts,
  boundSettlement,
  boundOracle,
  boundOwner,
  boundPartition,
  initialized,
  settlementDecimals,
  kycNotApplicable,
  hasKycKey,
  hasFreezeKey,
  deployedPolicy,
  cashTokenLiabilities,
  reservedAutomation,
  tokenBalance,
  hbarBalance,
  oraclePrice,
  acceptanceRail,
] = await Promise.all([
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "atsToken",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementToken",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "oracle",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "owner",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "partition",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementInitialized",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementDecimals",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementKycNotApplicable",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementHasKycKey",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "settlementHasFreezeKey",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "policy",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "cashTokenLiabilities",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "reservedAutomation",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: settlementToken,
    abi: htsTokenAbi,
    functionName: "balanceOf",
    args: [rail],
    blockNumber: verifiedBlock,
  }),
  client.getBalance({ address: rail, blockNumber: verifiedBlock }),
  client.readContract({
    address: oracle,
    abi: usdOracleAbi,
    functionName: "latestUsdPrice",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: acceptance,
    abi: htsAcceptanceAbi,
    functionName: "rail",
    blockNumber: verifiedBlock,
  }),
]);

for (const [actual, expected, label] of [
  [boundAts.toLowerCase(), atsToken.toLowerCase(), "ATS binding"],
  [
    boundSettlement.toLowerCase(),
    settlementToken.toLowerCase(),
    "settlement binding",
  ],
  [boundOracle.toLowerCase(), oracle.toLowerCase(), "oracle binding"],
  [boundOwner.toLowerCase(), issuer.toLowerCase(), "owner binding"],
  [boundPartition, DEFAULT_PARTITION, "partition binding"],
  [initialized, true, "settlement initialization"],
  [
    Number(settlementDecimals),
    record.settlementToken.decimals,
    "settlement decimals",
  ],
  [kycNotApplicable, !record.settlementToken.kycKey, "KYC applicability"],
  [hasKycKey, record.settlementToken.kycKey, "stored KYC key"],
  [hasFreezeKey, record.settlementToken.freezeKey, "stored freeze key"],
  [
    cashTokenLiabilities.toString(),
    record.accounting.cashTokenLiabilities,
    "token liabilities",
  ],
  [
    reservedAutomation.toString(),
    record.accounting.reservedAutomationTinybar,
    "automation reserve",
  ],
  [
    tokenBalance.toString(),
    record.accounting.railTokenBalance,
    "exact-block token balance",
  ],
  [
    weibarToTinybar(hbarBalance).toString(),
    record.accounting.railHbarBalanceTinybar,
    "exact-block HBAR balance",
  ],
  [oraclePrice[0].toString(), record.oracle.priceUsdE8, "oracle price"],
  [
    oraclePrice[1].toString(),
    record.oracle.confidenceUsdE8,
    "oracle confidence",
  ],
  [Number(oraclePrice[2]), record.oracle.observedAt, "oracle observation"],
  [acceptanceRail.toLowerCase(), rail.toLowerCase(), "acceptance rail binding"],
]) {
  assertEqual(actual, expected, label);
}
const policy = {
  maximumAdvanceBps: Number(deployedPolicy.maximumAdvanceBps),
  maximumAnnualRateBps: Number(deployedPolicy.maximumAnnualRateBps),
  maximumQuoteMovementBps: Number(deployedPolicy.maximumQuoteMovementBps),
  minimumTermSeconds: Number(deployedPolicy.minimumTermSeconds),
  maximumTermSeconds: Number(deployedPolicy.maximumTermSeconds),
  maximumOfferLifetimeSeconds: Number(
    deployedPolicy.maximumOfferLifetimeSeconds,
  ),
};
assertEqual(
  JSON.stringify(policy),
  JSON.stringify(record.policy),
  "rail policy",
);

if (record.oracle.kind === "pyth") {
  const [boundPyth, boundPriceId] = await Promise.all([
    client.readContract({
      address: oracle,
      abi: usdOracleAbi,
      functionName: "pyth",
      blockNumber: verifiedBlock,
    }),
    client.readContract({
      address: oracle,
      abi: usdOracleAbi,
      functionName: "priceId",
      blockNumber: verifiedBlock,
    }),
  ]);
  assertEqual(
    boundPyth.toLowerCase(),
    record.addresses.pyth.toLowerCase(),
    "Pyth contract binding",
  );
  assertEqual(
    boundPriceId.toLowerCase(),
    record.oracle.feedId.toLowerCase(),
    "Pyth feed binding",
  );
} else {
  const fixedPrice = await client.readContract({
    address: oracle,
    abi: fixedTestUsdOracleAbi,
    functionName: "fixedPriceUsdE8",
    blockNumber: verifiedBlock,
  });
  assertEqual(
    fixedPrice.toString(),
    record.oracle.priceUsdE8,
    "fixed test oracle binding",
  );
}

const [
  internalKyc,
  issuerStatus,
  lenderKyc,
  borrowerKyc,
  assetMaturity,
  clearingActive,
  tokenDecimals,
  nominalValue,
  nominalDecimals,
  nominalCurrency,
  issuerRole,
  kycRole,
  ssiRole,
  borrowerFree,
  borrowerHeld,
  lenderFree,
  lenderHeld,
] = await Promise.all([
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "isInternalKycActivated",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "isIssuer",
    args: [issuer],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getKycStatusFor",
    args: [lender],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getKycStatusFor",
    args: [borrower],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getMaturityDate",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "isClearingActivated",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "decimals",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getNominalValue",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getNominalValueDecimals",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getNominalValueCurrency",
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "hasRole",
    args: [ROLE_ISSUER, issuer],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "hasRole",
    args: [ROLE_KYC, issuer],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "hasRole",
    args: [ROLE_SSI_MANAGER, issuer],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "balanceOfByPartition",
    args: [DEFAULT_PARTITION, borrower],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getHeldAmountForByPartition",
    args: [DEFAULT_PARTITION, borrower],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "balanceOfByPartition",
    args: [DEFAULT_PARTITION, lender],
    blockNumber: verifiedBlock,
  }),
  client.readContract({
    address: atsToken,
    abi: atsAbi,
    functionName: "getHeldAmountForByPartition",
    args: [DEFAULT_PARTITION, lender],
    blockNumber: verifiedBlock,
  }),
]);
for (const [actual, expected, label] of [
  [internalKyc, record.ats.internalKyc, "ATS internal KYC"],
  [issuerStatus, record.ats.issuer, "ATS issuer"],
  [Number(lenderKyc), record.ats.kyc.lender, "ATS lender KYC"],
  [Number(borrowerKyc), record.ats.kyc.borrower, "ATS borrower KYC"],
  [assetMaturity.toString(), record.ats.assetMaturity, "ATS maturity"],
  [clearingActive, record.ats.clearingActive, "ATS clearing"],
  [Number(tokenDecimals), record.ats.tokenDecimals, "ATS decimals"],
  [nominalValue.toString(), record.ats.nominalValue, "ATS nominal value"],
  [
    Number(nominalDecimals),
    record.ats.nominalValueDecimals,
    "ATS nominal decimals",
  ],
  [
    nominalCurrency.toLowerCase(),
    record.ats.nominalValueCurrency.toLowerCase(),
    "ATS nominal currency",
  ],
  [issuerRole, record.ats.roles.issuer, "ATS issuer role"],
  [kycRole, record.ats.roles.kyc, "ATS KYC role"],
  [ssiRole, record.ats.roles.ssiManager, "ATS SSI role"],
  [
    borrowerFree.toString(),
    record.ats.balances.borrower.free,
    "borrower free ATS",
  ],
  [
    borrowerHeld.toString(),
    record.ats.balances.borrower.held,
    "borrower held ATS",
  ],
  [lenderFree.toString(), record.ats.balances.lender.free, "lender free ATS"],
  [lenderHeld.toString(), record.ats.balances.lender.held, "lender held ATS"],
]) {
  assertEqual(actual, expected, label);
}

const positionStates = ["NONE", "OPEN", "REPAID", "DEFAULTED"];
const automationStates = ["NONE", "PENDING", "COMPLETED", "UNAVAILABLE"];
for (const expected of record.positions) {
  const actual = await client.readContract({
    address: rail,
    abi: htsRailAbi,
    functionName: "getPosition",
    args: [expected.id],
    blockNumber: verifiedBlock,
  });
  for (const [actualValue, expectedValue, label] of [
    [actual.lender.toLowerCase(), expected.lender.toLowerCase(), "lender"],
    [
      actual.borrower.toLowerCase(),
      expected.borrower.toLowerCase(),
      "borrower",
    ],
    [
      actual.collateralAmount.toString(),
      expected.collateralAmount,
      "collateral",
    ],
    [actual.holdId.toString(), expected.holdId, "hold ID"],
    [
      actual.principalTokenUnits.toString(),
      expected.principalTokenUnits,
      "principal",
    ],
    [
      actual.repaymentTokenUnits.toString(),
      expected.repaymentTokenUnits,
      "repayment",
    ],
    [Number(actual.openedAt), expected.openedAt, "opened time"],
    [Number(actual.maturity), expected.maturity, "maturity"],
    [
      actual.scheduleAddress.toLowerCase(),
      expected.scheduleAddress.toLowerCase(),
      "schedule",
    ],
    [positionStates[Number(actual.state)], expected.state, "state"],
    [
      automationStates[Number(actual.automation)],
      expected.automation,
      "automation",
    ],
  ]) {
    assertEqual(actualValue, expectedValue, `position ${expected.id} ${label}`);
  }
}

for (const expected of record.holds) {
  const readHold = (blockNumber) =>
    client.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getHoldForByPartition",
      args: [
        {
          partition: expected.partition,
          tokenHolder: expected.holder,
          holdId: BigInt(expected.holdId),
        },
      ],
      blockNumber,
    });
  const initial = await readHold(BigInt(expected.state.blockNumber));
  for (const [actual, value, label] of [
    [initial[0].toString(), expected.amount, "amount"],
    [initial[1].toString(), expected.expirationTimestamp, "expiry"],
    [initial[2].toLowerCase(), expected.escrow.toLowerCase(), "escrow"],
    [
      initial[3].toLowerCase(),
      expected.destination.toLowerCase(),
      "destination",
    ],
    [initial[4].toLowerCase(), expected.data.toLowerCase(), "data"],
    [
      initial[5].toLowerCase(),
      expected.operatorData.toLowerCase(),
      "operator data",
    ],
    [Number(initial[6]), expected.thirdPartyType, "third-party type"],
  ]) {
    assertEqual(actual, value, `hold ${expected.holdId} ${label}`);
  }
  const terminal = await readHold(BigInt(expected.terminalState.blockNumber));
  if (
    terminal[0] !== 0n ||
    terminal[1] !== 0n ||
    !sameAddress(terminal[2], ZERO_ADDRESS) ||
    !sameAddress(terminal[3], ZERO_ADDRESS) ||
    terminal[4] !== "0x" ||
    terminal[5] !== "0x" ||
    Number(terminal[6]) !== 0
  ) {
    throw new Error(`Hold ${expected.holdId} remains live at final state.`);
  }
}

const repaidPosition = record.positions.find(
  (position) => position.state === "REPAID",
);
const funded = await requireReceiptEvent({
  proof: record.lifecycle.fundedOffer,
  address: rail,
  abi: htsRailAbi,
  eventName: "OfferFunded",
});
assertEqual(
  funded.offerId.toLowerCase(),
  repaidPosition.id.toLowerCase(),
  "funded offer ID",
);
assertEqual(
  funded.principalTokenUnits.toString(),
  repaidPosition.principalTokenUnits,
  "funded token amount",
);
const opened = await requireReceiptEvent({
  proof: record.lifecycle.holdCreation,
  address: rail,
  abi: htsRailAbi,
  eventName: "PositionOpened",
});
assertEqual(
  opened.positionId.toLowerCase(),
  repaidPosition.id.toLowerCase(),
  "opened position ID",
);
assertEqual(opened.holdId.toString(), repaidPosition.holdId, "opened hold ID");
const repaidEvent = await requireReceiptEvent({
  proof: record.lifecycle.repaidFacility,
  address: rail,
  abi: htsRailAbi,
  eventName: "PositionRepaid",
});
assertEqual(
  repaidEvent.positionId.toLowerCase(),
  repaidPosition.id.toLowerCase(),
  "repaid position ID",
);
assertEqual(
  repaidEvent.repaymentTokenUnits.toString(),
  repaidPosition.repaymentTokenUnits,
  "repaid token amount",
);

const defaultSchedule = record.lifecycle.maturedDefault;
if (defaultSchedule.type === "schedule") {
  const block = await client.getBlock({ blockNumber: verifiedBlock });
  const executionSecond = BigInt(
    defaultSchedule.executedTimestamp.split(".")[0],
  );
  if (block.timestamp < executionSecond) {
    throw new Error("Final state block predates HSS execution.");
  }
}

console.log(
  JSON.stringify(
    {
      verified: true,
      profile: record.settlementProfile,
      token: record.settlementToken.tokenId,
      transactions: record.transactions.length,
      tokenTransfers: record.tokenTransfers.length,
      schedules: record.schedules.length,
      verifiedBlock: verifiedBlock.toString(),
      mirror: htsEvidenceConstants.MIRROR_ORIGIN,
    },
    null,
    2,
  ),
);
