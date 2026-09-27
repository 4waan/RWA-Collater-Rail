import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  parseEventLogs,
} from "viem";
import { atsAbi, railAbi } from "@collateral-rail/shared/abis";
import { DEFAULT_PARTITION } from "@collateral-rail/shared/hedera";
import {
  DEFAULT_MIRROR_URL,
  DEFAULT_RPC_URL,
  assertRailSolvency,
  confirmMirrorAccountIdentity,
  confirmMirrorSchedule,
  fetchAllowedJson,
  readCurrentMirrorBalance,
  validateEvidenceRecord,
  validatedEndpoint,
  waitForMirrorTransaction,
} from "./lib/evidence-lib.mjs";
import { readVerifiedFinalState } from "./lib/demo-verification.ts";

const recordPath = path.resolve(process.argv[2] ?? "deployments/testnet.json");
const parsedRecord = JSON.parse(await readFile(recordPath, "utf8"));
const record =
  parsedRecord.status === "verified"
    ? validateEvidenceRecord(parsedRecord)
    : parsedRecord;
const oracleEvidence =
  record.oracle ??
  (record.pyth
    ? {
        kind: "pyth",
        priceUsdE8: record.pyth.priceUsdE8,
        confidenceUsdE8: record.pyth.confidenceUsdE8,
        observedAt: record.pyth.publishTime,
      }
    : null);
if (
  record.schemaVersion !== 3 ||
  !["bootstrap-mined", "verified"].includes(record.status) ||
  !Array.isArray(record.transactions) ||
  record.transactions.length === 0 ||
  record.transactions.some(
    (transaction) =>
      transaction?.type !== "transaction" ||
      transaction?.result !== "SUCCESS" ||
      !/^0x[a-fA-F0-9]{64}$/.test(transaction?.hash ?? ""),
  )
) {
  throw new Error(
    "Deployment record is neither a mined bootstrap nor verified evidence.",
  );
}

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
const verifiedBlock = record.verification?.state
  ? BigInt(record.verification.state.blockNumber)
  : undefined;
const blockSelection =
  verifiedBlock === undefined ? {} : { blockNumber: verifiedBlock };

function requireAddress(name) {
  const value = record.addresses?.[name];
  if (!isAddress(value ?? "")) {
    throw new Error(`Missing valid ${name} address.`);
  }
  return value;
}

function requireActorAddress(name) {
  const value = record.actors?.[name]?.evmAddress;
  if (!isAddress(value ?? "")) {
    throw new Error(`Missing valid ${name} actor address.`);
  }
  return value;
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the recorded evidence.`);
  }
}

async function requireReceiptEvent({ proof, address, abi, eventName }) {
  const receipt = await client.getTransactionReceipt({ hash: proof.hash });
  if (receipt.status !== "success") {
    throw new Error(`${eventName} receipt did not succeed.`);
  }
  const events = parseEventLogs({
    abi,
    eventName,
    strict: true,
    logs: receipt.logs.filter(({ address: emittedBy }) =>
      sameAddress(emittedBy, address),
    ),
  });
  if (events.length !== 1) {
    throw new Error(
      `${eventName} receipt contained ${events.length} matching events.`,
    );
  }
  return events[0].args;
}

const token = requireAddress("atsToken");
const oracle = requireAddress("oracle");
const rail = requireAddress("rail");
const acceptance = requireAddress("acceptance");
const operator = requireActorAddress("issuer");
const lender = requireActorAddress("lender");
const borrower = requireActorAddress("borrower");
let currentBalanceProof = null;
let currentAccounting = null;

for (const [name, address] of Object.entries({
  token,
  oracle,
  rail,
  acceptance,
})) {
  const entity = await fetchAllowedJson(
    new URL(`/api/v1/contracts/${address}`, mirrorOrigin),
    mirrorOrigin,
  );
  if (!entity.contract_id && !entity.evm_address) {
    throw new Error(`Mirror did not confirm ${name}.`);
  }
}

for (const transaction of record.transactions) {
  const mirrorProof = await waitForMirrorTransaction({
    mirrorOrigin,
    hash: transaction.hash,
    timeoutMs: 30_000,
  });
  if (
    mirrorProof.hash !== transaction.hash ||
    mirrorProof.result !== transaction.result ||
    mirrorProof.consensusTimestamp !== transaction.consensusTimestamp ||
    mirrorProof.mirror !== transaction.mirror ||
    mirrorProof.hashScan !== transaction.hashScan
  ) {
    throw new Error(
      `Mirror proof for ${transaction.hash} differs from the record.`,
    );
  }
}

if (record.status === "verified") {
  for (const actor of Object.values(record.actors)) {
    await confirmMirrorAccountIdentity({
      mirrorOrigin,
      accountId: actor.accountId,
      evmAddress: actor.evmAddress,
    });
  }
  for (const schedule of record.schedules) {
    const mirrorSchedule = await confirmMirrorSchedule({
      mirrorOrigin,
      scheduleAddress: schedule.address,
    });
    if (
      mirrorSchedule.scheduleId !== schedule.scheduleId ||
      mirrorSchedule.executedTimestamp !== schedule.executedTimestamp ||
      mirrorSchedule.mirror !== schedule.mirror ||
      mirrorSchedule.hashScan !== schedule.hashScan
    ) {
      throw new Error(
        `Mirror schedule ${schedule.scheduleId} differs from the record.`,
      );
    }
  }
}

const acceptanceAbi = [
  {
    type: "function",
    name: "rail",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];
const [boundToken, boundOracle, partition, owner, nominal, acceptanceRail] =
  await Promise.all([
    client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "atsToken",
      ...blockSelection,
    }),
    client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "oracle",
      ...blockSelection,
    }),
    client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "partition",
      ...blockSelection,
    }),
    client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "owner",
      ...blockSelection,
    }),
    client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "nominalValueUsdE8",
      ...blockSelection,
    }),
    client.readContract({
      address: acceptance,
      abi: acceptanceAbi,
      functionName: "rail",
      ...blockSelection,
    }),
  ]);
if (!sameAddress(boundToken, token))
  throw new Error("Rail token binding mismatch.");
if (!sameAddress(boundOracle, oracle))
  throw new Error("Rail oracle binding mismatch.");
if (!sameAddress(owner, operator)) throw new Error("Rail owner mismatch.");
if (!sameAddress(acceptanceRail, rail)) {
  throw new Error("Acceptance verifier rail binding mismatch.");
}
if (partition !== DEFAULT_PARTITION)
  throw new Error("Rail partition mismatch.");
if (nominal !== 100n * 10n ** 8n) {
  throw new Error("Rail nominal value mismatch.");
}

if (record.status === "bootstrap-mined") {
  const [
    internalKyc,
    issuer,
    lenderKyc,
    borrowerKyc,
    maturity,
    clearingActive,
    tokenDecimals,
    nominalValue,
    nominalValueDecimals,
    nominalValueCurrency,
  ] = await Promise.all([
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "isInternalKycActivated",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "isIssuer",
      args: [operator],
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [lender],
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [borrower],
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getMaturityDate",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "isClearingActivated",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "decimals",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getNominalValue",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getNominalValueDecimals",
    }),
    client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getNominalValueCurrency",
    }),
  ]);
  if (
    !internalKyc ||
    !issuer ||
    lenderKyc !== 1 ||
    borrowerKyc !== 1 ||
    maturity === 0n ||
    clearingActive ||
    tokenDecimals !== 0 ||
    nominalValue !== 10_000n ||
    nominalValueDecimals !== 2 ||
    nominalValueCurrency.toLowerCase() !== "0x555344"
  ) {
    throw new Error("ATS live KYC, SSI, or maturity configuration mismatch.");
  }
} else {
  if (!oracleEvidence) {
    throw new Error("Verified evidence is missing its oracle source.");
  }
  const finalState = await readVerifiedFinalState({
    publicClient: client,
    atsToken: token,
    oracle,
    rail,
    issuer: operator,
    lender,
    borrower,
    expectedPolicy: record.policy,
    blockNumber: verifiedBlock,
  });
  currentBalanceProof = await readCurrentMirrorBalance({
    mirrorOrigin,
    evmAddress: rail,
  });
  assertEqual(
    currentBalanceProof.accountId,
    record.verification.balance.accountId,
    "Rail Mirror account ID",
  );
  const [currentCashLiabilities, currentReservedAutomation, currentRequired] =
    await Promise.all([
      client.readContract({
        address: rail,
        abi: railAbi,
        functionName: "cashLiabilities",
      }),
      client.readContract({
        address: rail,
        abi: railAbi,
        functionName: "reservedAutomation",
      }),
      client.readContract({
        address: rail,
        abi: railAbi,
        functionName: "requiredBacking",
      }),
    ]);
  if (currentRequired !== currentCashLiabilities + currentReservedAutomation) {
    throw new Error("Current rail accounting is internally inconsistent.");
  }
  assertRailSolvency({
    balanceTinybar: currentBalanceProof.balanceTinybar,
    requiredBackingTinybar: currentRequired.toString(),
  });
  currentAccounting = {
    cashLiabilitiesTinybar: currentCashLiabilities.toString(),
    reservedAutomationTinybar: currentReservedAutomation.toString(),
    requiredBackingTinybar: currentRequired.toString(),
  };
  assertEqual(finalState.internalKyc, record.ats.internalKyc, "ATS KYC mode");
  assertEqual(finalState.issuer, record.ats.issuer, "ATS issuer status");
  assertEqual(
    Number(finalState.lenderKyc),
    record.ats.kyc.lender,
    "Lender KYC",
  );
  assertEqual(
    Number(finalState.borrowerKyc),
    record.ats.kyc.borrower,
    "Borrower KYC",
  );
  assertEqual(
    finalState.assetMaturity.toString(),
    record.ats.assetMaturity,
    "ATS maturity",
  );
  assertEqual(
    finalState.clearingActive,
    record.ats.clearingActive,
    "ATS clearing mode",
  );
  assertEqual(
    Number(finalState.tokenDecimals),
    record.ats.tokenDecimals,
    "ATS token decimals",
  );
  assertEqual(
    finalState.nominalValue.toString(),
    record.ats.nominalValue,
    "ATS nominal value",
  );
  assertEqual(
    Number(finalState.nominalValueDecimals),
    record.ats.nominalValueDecimals,
    "ATS nominal decimals",
  );
  assertEqual(
    finalState.nominalValueCurrency.toLowerCase(),
    record.ats.nominalValueCurrency.toLowerCase(),
    "ATS nominal currency",
  );
  assertEqual(finalState.issuerRole, record.ats.roles.issuer, "Issuer role");
  assertEqual(finalState.kycRole, record.ats.roles.kyc, "KYC role");
  assertEqual(finalState.ssiRole, record.ats.roles.ssiManager, "SSI role");
  assertEqual(
    finalState.borrowerFree.toString(),
    record.ats.balances.borrower.free,
    "Borrower free balance",
  );
  assertEqual(
    finalState.borrowerHeld.toString(),
    record.ats.balances.borrower.held,
    "Borrower held balance",
  );
  assertEqual(
    finalState.lenderFree.toString(),
    record.ats.balances.lender.free,
    "Lender free balance",
  );
  assertEqual(
    finalState.lenderHeld.toString(),
    record.ats.balances.lender.held,
    "Lender held balance",
  );
  assertEqual(
    finalState.cashLiabilities.toString(),
    record.accounting.cashLiabilitiesTinybar,
    "Cash liabilities",
  );
  assertEqual(
    finalState.reservedAutomation.toString(),
    record.accounting.reservedAutomationTinybar,
    "Automation reserve",
  );
  assertEqual(
    finalState.requiredBacking.toString(),
    record.accounting.requiredBackingTinybar,
    "Required backing",
  );
  assertEqual(
    finalState.oraclePriceUsdE8.toString(),
    oracleEvidence.priceUsdE8,
    "Oracle price",
  );
  assertEqual(
    finalState.oracleConfidenceUsdE8.toString(),
    oracleEvidence.confidenceUsdE8,
    "Oracle confidence",
  );
  assertEqual(
    Number(finalState.oraclePublishTime),
    oracleEvidence.observedAt,
    "Oracle observation time",
  );

  const repaidPosition = record.positions.find(
    ({ state }) => state === "REPAID",
  );
  const defaultedPosition = record.positions.find(
    ({ state }) => state === "DEFAULTED",
  );
  const fundedArgs = await requireReceiptEvent({
    proof: record.lifecycle.fundedOffer,
    address: rail,
    abi: railAbi,
    eventName: "OfferFunded",
  });
  assertEqual(
    fundedArgs.offerId.toLowerCase(),
    repaidPosition.id.toLowerCase(),
    "Funded offer ID",
  );
  assertEqual(
    fundedArgs.lender.toLowerCase(),
    repaidPosition.lender.toLowerCase(),
    "Funded offer lender",
  );
  assertEqual(
    fundedArgs.borrower.toLowerCase(),
    repaidPosition.borrower.toLowerCase(),
    "Funded offer borrower",
  );
  assertEqual(
    fundedArgs.principalTinybar.toString(),
    repaidPosition.principalTinybar,
    "Funded offer principal",
  );

  const openedArgs = await requireReceiptEvent({
    proof: record.lifecycle.holdCreation,
    address: rail,
    abi: railAbi,
    eventName: "PositionOpened",
  });
  assertEqual(
    openedArgs.positionId.toLowerCase(),
    repaidPosition.id.toLowerCase(),
    "Opened position ID",
  );
  assertEqual(
    openedArgs.holdId.toString(),
    repaidPosition.holdId,
    "Opened hold ID",
  );
  assertEqual(
    openedArgs.maturity.toString(),
    String(repaidPosition.maturity),
    "Opened maturity",
  );

  const heldArgs = await requireReceiptEvent({
    proof: record.lifecycle.holdCreation,
    address: token,
    abi: atsAbi,
    eventName: "HeldFromByPartition",
  });
  assertEqual(
    heldArgs.operator.toLowerCase(),
    rail.toLowerCase(),
    "ATS hold operator",
  );
  assertEqual(
    heldArgs.tokenHolder.toLowerCase(),
    repaidPosition.borrower.toLowerCase(),
    "ATS hold owner",
  );
  assertEqual(heldArgs.partition, DEFAULT_PARTITION, "ATS hold partition");
  assertEqual(
    heldArgs.holdId.toString(),
    repaidPosition.holdId,
    "ATS hold event ID",
  );
  assertEqual(
    heldArgs.hold.amount.toString(),
    repaidPosition.collateralAmount,
    "ATS hold event amount",
  );
  assertEqual(
    heldArgs.hold.escrow.toLowerCase(),
    rail.toLowerCase(),
    "ATS hold escrow",
  );
  assertEqual(
    heldArgs.hold.data.toLowerCase(),
    repaidPosition.id.toLowerCase(),
    "ATS hold position binding",
  );

  const repaidArgs = await requireReceiptEvent({
    proof: record.lifecycle.repaidFacility,
    address: rail,
    abi: railAbi,
    eventName: "PositionRepaid",
  });
  assertEqual(
    repaidArgs.positionId.toLowerCase(),
    repaidPosition.id.toLowerCase(),
    "Repaid position ID",
  );
  assertEqual(
    repaidArgs.repaymentTinybar.toString(),
    repaidPosition.repaymentTinybar,
    "Repaid amount",
  );
  const releasedArgs = await requireReceiptEvent({
    proof: record.lifecycle.repaidFacility,
    address: token,
    abi: atsAbi,
    eventName: "HoldByPartitionReleased",
  });
  assertEqual(
    releasedArgs.tokenHolder.toLowerCase(),
    repaidPosition.borrower.toLowerCase(),
    "Released hold owner",
  );
  assertEqual(
    releasedArgs.holdId.toString(),
    repaidPosition.holdId,
    "Released hold ID",
  );
  assertEqual(
    releasedArgs.amount.toString(),
    repaidPosition.collateralAmount,
    "Released hold amount",
  );

  if (defaultedPosition.terminalPath === "permissionless-fallback") {
    const defaultedArgs = await requireReceiptEvent({
      proof: record.lifecycle.maturedDefault,
      address: rail,
      abi: railAbi,
      eventName: "PositionDefaulted",
    });
    assertEqual(
      defaultedArgs.positionId.toLowerCase(),
      defaultedPosition.id.toLowerCase(),
      "Defaulted position ID",
    );
    const executedArgs = await requireReceiptEvent({
      proof: record.lifecycle.maturedDefault,
      address: token,
      abi: atsAbi,
      eventName: "HoldByPartitionExecuted",
    });
    assertEqual(
      executedArgs.tokenHolder.toLowerCase(),
      defaultedPosition.borrower.toLowerCase(),
      "Executed hold owner",
    );
    assertEqual(
      executedArgs.holdId.toString(),
      defaultedPosition.holdId,
      "Executed hold ID",
    );
    assertEqual(
      executedArgs.to.toLowerCase(),
      defaultedPosition.lender.toLowerCase(),
      "Executed hold recipient",
    );
    assertEqual(
      defaultedArgs.collateralAmount.toString(),
      executedArgs.amount.toString(),
      "Defaulted collateral amount",
    );
  }

  const positionStates = ["NONE", "OPEN", "REPAID", "DEFAULTED"];
  const automationStates = ["NONE", "PENDING", "COMPLETED", "UNAVAILABLE"];
  for (const expected of record.positions) {
    const actual = await client.readContract({
      address: rail,
      abi: railAbi,
      functionName: "getPosition",
      args: [expected.id],
      blockNumber: verifiedBlock,
    });
    const comparisons = [
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
        actual.principalTinybar.toString(),
        expected.principalTinybar,
        "principal",
      ],
      [
        actual.repaymentTinybar.toString(),
        expected.repaymentTinybar,
        "repayment",
      ],
      [Number(actual.openedAt), expected.openedAt, "opened time"],
      [Number(actual.maturity), expected.maturity, "maturity"],
      [
        actual.scheduleAddress.toLowerCase(),
        expected.scheduleAddress.toLowerCase(),
        "schedule address",
      ],
      [positionStates[Number(actual.state)], expected.state, "state"],
      [
        automationStates[Number(actual.automation)],
        expected.automation,
        "automation state",
      ],
    ];
    for (const [actualValue, expectedValue, field] of comparisons) {
      assertEqual(
        actualValue,
        expectedValue,
        `Position ${expected.id} ${field}`,
      );
    }
  }

  for (const expected of record.holds) {
    const actual = await client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getHoldForByPartition",
      args: [
        {
          partition: expected.partition,
          tokenHolder: expected.holder,
          holdId: BigInt(expected.holdId),
        },
      ],
      blockNumber: BigInt(expected.state.blockNumber),
    });
    const comparisons = [
      [actual[0].toString(), expected.amount, "amount"],
      [actual[1].toString(), expected.expirationTimestamp, "expiry"],
      [actual[2].toLowerCase(), expected.escrow.toLowerCase(), "escrow"],
      [
        actual[3].toLowerCase(),
        expected.destination.toLowerCase(),
        "destination",
      ],
      [actual[4].toLowerCase(), expected.data.toLowerCase(), "data"],
      [
        actual[5].toLowerCase(),
        expected.operatorData.toLowerCase(),
        "operator data",
      ],
      [Number(actual[6]), expected.thirdPartyType, "third-party type"],
    ];
    for (const [actualValue, expectedValue, field] of comparisons) {
      assertEqual(
        actualValue,
        expectedValue,
        `Hold ${expected.holdId} ${field}`,
      );
    }
    const terminal = await client.readContract({
      address: token,
      abi: atsAbi,
      functionName: "getHoldForByPartition",
      args: [
        {
          partition: expected.partition,
          tokenHolder: expected.holder,
          holdId: BigInt(expected.holdId),
        },
      ],
      blockNumber: BigInt(expected.terminalState.blockNumber),
    });
    if (
      terminal[0] !== 0n ||
      terminal[1] !== 0n ||
      !sameAddress(terminal[2], "0x0000000000000000000000000000000000000000") ||
      !sameAddress(terminal[3], "0x0000000000000000000000000000000000000000") ||
      terminal[4] !== "0x" ||
      terminal[5] !== "0x" ||
      Number(terminal[6]) !== 0
    ) {
      throw new Error(`Hold ${expected.holdId} remains live at final state.`);
    }
  }

  if (defaultedPosition.terminalPath === "hss") {
    const block = await client.getBlock({ blockNumber: verifiedBlock });
    const executionSecond = BigInt(
      record.lifecycle.maturedDefault.executedTimestamp.split(".")[0],
    );
    if (block.timestamp < executionSecond) {
      throw new Error("Final state block predates HSS execution.");
    }
  }
}

console.log(
  JSON.stringify(
    {
      verified: true,
      status: record.status,
      contracts: { token, oracle, rail, acceptance },
      receipts: record.transactions.length,
      schedules: record.schedules?.length ?? 0,
      verifiedBlock: verifiedBlock?.toString() ?? "latest",
      currentBalance:
        currentBalanceProof === null
          ? null
          : {
              basis: currentBalanceProof.basis,
              balanceTinybar: currentBalanceProof.balanceTinybar,
              balanceTimestamp: currentBalanceProof.balanceTimestamp,
              checkedAt: currentBalanceProof.checkedAt,
              accounting: currentAccounting,
              changedSinceEvidence:
                currentBalanceProof.balanceTinybar !==
                record.accounting.contractBalanceTinybar,
            },
    },
    null,
    2,
  ),
);
