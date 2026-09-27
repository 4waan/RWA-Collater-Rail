import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { railAbi } from "@collateral-rail/shared/abis";
import {
  EvidenceJournal,
  HBAR_USD_PRICE_ID,
  TINYBAR_PER_HBAR,
  assertDependencyBytecode,
  assertFundingBudget,
  assertHip475Availability,
  assertHssCapacity,
  categorizeBootstrapTransactions,
  classifyDefaultPath,
  confirmMirrorAccountIdentity,
  createTemporaryActor,
  fetchMirrorPages,
  hashScanContract,
  hashScanSchedule,
  hashScanTransaction,
  mirrorContract,
  mirrorSchedule,
  mirrorTransaction,
  parseHermesUpdate,
  proofForSemanticKind,
  sweepTemporaryActor,
  validateEvidenceRecord,
  validateRailPolicyEvidence,
  validatedEndpoint,
  waitForMirrorTransaction,
} from "../lib/evidence-lib.mjs";
import {
  HEDERA_WRITE_GAS,
  receiptDefaultedPosition,
  redactSignerMaterial,
  selectedRecipeId,
} from "../lib/demo-runtime.ts";

test("Hedera lifecycle writes use bounded explicit gas limits", () => {
  assert.ok(HEDERA_WRITE_GAS.withdrawal > 45_464n);
  assert.ok(HEDERA_WRITE_GAS.acceptOffer > 2_238_629n);
  for (const gasLimit of Object.values(HEDERA_WRITE_GAS)) {
    assert.ok(gasLimit >= 100_000n);
    assert.ok(gasLimit <= 5_000_000n);
  }
});

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(payload),
  };
}

function verifiedEvidence() {
  const address = (digit) => `0x${digit.repeat(40)}`;
  const hash = (digit) => `0x${digit.repeat(64)}`;
  const hashes = "123456789a".split("").map(hash);
  const transactionKinds = [
    "ats-bond-deployment-1",
    "kyc-grant-2",
    "collateral-issuance-1",
    "pyth-price-refresh",
    "fund-offer-1",
    "accept-offer-1",
    "repay-position",
    "bootstrap-extra-1",
    "bootstrap-extra-2",
    "bootstrap-extra-3",
  ];
  const addresses = {
    factory: address("1"),
    resolver: address("2"),
    pyth: address("3"),
    atsToken: address("4"),
    oracle: address("5"),
    rail: address("6"),
    acceptance: address("7"),
  };
  const firstScheduleAddress = `0x${"0".repeat(24)}${"1".padStart(16, "0")}`;
  const secondScheduleAddress = `0x${"0".repeat(24)}${"2".padStart(16, "0")}`;
  const partition = `0x${"0".repeat(63)}1`;
  const repaidPositionId = hash("b");
  const defaultedPositionId = hash("c");

  const transactions = hashes.map((transactionHash, index) => ({
    type: "transaction",
    kind: transactionKinds[index],
    hash: transactionHash,
    result: "SUCCESS",
    consensusTimestamp: `170000000${index}.${index + 1}`,
    mirror: mirrorTransaction(transactionHash),
    hashScan: hashScanTransaction(transactionHash),
  }));
  const firstSchedule = {
    type: "schedule",
    address: firstScheduleAddress,
    scheduleId: "0.0.1",
    executedTimestamp: "1700000121.000000001",
    mirror: mirrorSchedule("0.0.1"),
    hashScan: hashScanSchedule("0.0.1"),
  };
  const secondSchedule = {
    type: "schedule",
    address: secondScheduleAddress,
    scheduleId: "0.0.2",
    executedTimestamp: "1700000122.000000001",
    mirror: mirrorSchedule("0.0.2"),
    hashScan: hashScanSchedule("0.0.2"),
  };
  const state = {
    type: "state",
    blockNumber: "1234",
    rpcOrigin: "https://testnet.hashio.io",
    assertions: {
      "ats.internalKyc": true,
      "ats.issuer": true,
      "ats.lenderKyc": 1,
      "ats.borrowerKyc": 1,
      "ats.assetMaturity": "1800000000",
      "ats.clearingActive": false,
      "ats.tokenDecimals": 0,
      "ats.nominalValue": "10000",
      "ats.nominalValueDecimals": 2,
      "ats.nominalValueCurrency": "0x555344",
      "ats.borrowerFree": "980",
      "ats.borrowerHeld": "0",
      "ats.lenderFree": "10",
      "ats.lenderHeld": "0",
      "rail.cashLiabilitiesTinybar": "0",
      "rail.reservedAutomationTinybar": "0",
      "rail.requiredBackingTinybar": "0",
      "rail.contractBalanceTinybar": "1",
      "rail.policy.maximumAdvanceBps": 7_000,
      "rail.policy.maximumAnnualRateBps": 10_000,
      "rail.policy.maximumQuoteMovementBps": 100,
      "rail.policy.minimumTermSeconds": 120,
      "rail.policy.maximumTermSeconds": 31_536_000,
      "rail.policy.maximumOfferLifetimeSeconds": 86_400,
      "oracle.kind": "pyth",
      "oracle.priceUsdE8": "10000000",
      "oracle.confidenceUsdE8": "1000",
      "oracle.observedAt": 1_700_000_000,
      "positions.repaidState": "REPAID",
      "positions.defaultedState": "DEFAULTED",
    },
  };
  const holdEvidence = (positionId, holdId, blockNumber) => {
    const hold = {
      positionId,
      holdId,
      holder: address("a"),
      partition,
      amount: "10",
      expirationTimestamp: "1800000001",
      escrow: addresses.rail,
      destination: `0x${"0".repeat(40)}`,
      data: positionId,
      operatorData: "0x",
      thirdPartyType: 0,
    };
    return {
      ...hold,
      state: {
        type: "state",
        blockNumber,
        rpcOrigin: "https://testnet.hashio.io",
        assertions: {
          "hold.positionId": hold.positionId,
          "hold.holdId": hold.holdId,
          "hold.holder": hold.holder,
          "hold.partition": hold.partition,
          "hold.amount": hold.amount,
          "hold.expirationTimestamp": hold.expirationTimestamp,
          "hold.escrow": hold.escrow,
          "hold.destination": hold.destination,
          "hold.data": hold.data,
          "hold.operatorData": hold.operatorData,
          "hold.thirdPartyType": hold.thirdPartyType,
        },
      },
      terminalState: {
        type: "state",
        blockNumber: "1234",
        rpcOrigin: "https://testnet.hashio.io",
        assertions: {
          "hold.positionId": hold.positionId,
          "hold.holdId": hold.holdId,
          "hold.holder": hold.holder,
          "hold.partition": hold.partition,
          "hold.remainingAmount": "0",
          "hold.deleted": true,
        },
      },
    };
  };

  return {
    schemaVersion: 3,
    network: "hedera-testnet",
    chainId: 296,
    status: "verified",
    generatedAt: "2026-09-25T12:00:10.000Z",
    recipeId: "term-credit",
    policy: {
      maximumAdvanceBps: 7_000,
      maximumAnnualRateBps: 10_000,
      maximumQuoteMovementBps: 100,
      minimumTermSeconds: 120,
      maximumTermSeconds: 31_536_000,
      maximumOfferLifetimeSeconds: 86_400,
    },
    addresses,
    actors: {
      issuer: { accountId: "0.0.100", evmAddress: address("8") },
      lender: { accountId: "0.0.101", evmAddress: address("9") },
      borrower: { accountId: "0.0.102", evmAddress: address("a") },
    },
    lifecycle: {
      atsBondDeployment: transactions[0],
      ssiAndKycConfiguration: transactions[1],
      collateralIssuance: transactions[2],
      pythPriceUpdate: transactions[3],
      fundedOffer: transactions[4],
      holdCreation: transactions[5],
      hssScheduleCreation: secondSchedule,
      repaidFacility: transactions[6],
      maturedDefault: secondSchedule,
      liveConfigurationRead: state,
    },
    transactions,
    positions: [
      {
        id: repaidPositionId,
        lender: address("9"),
        borrower: address("a"),
        collateralAmount: "10",
        holdId: "1",
        principalTinybar: "100",
        repaymentTinybar: "101",
        openedAt: 1_700_000_000,
        maturity: 1_700_000_120,
        scheduleAddress: firstScheduleAddress,
        state: "REPAID",
        automation: "COMPLETED",
        terminalPath: "repayment",
      },
      {
        id: defaultedPositionId,
        lender: address("9"),
        borrower: address("a"),
        collateralAmount: "10",
        holdId: "2",
        principalTinybar: "100",
        repaymentTinybar: "101",
        openedAt: 1_700_000_001,
        maturity: 1_700_000_121,
        scheduleAddress: secondScheduleAddress,
        state: "DEFAULTED",
        automation: "COMPLETED",
        terminalPath: "hss",
      },
    ],
    holds: [
      holdEvidence(repaidPositionId, "1", "1200"),
      holdEvidence(defaultedPositionId, "2", "1201"),
    ],
    schedules: [firstSchedule, secondSchedule],
    oracle: {
      kind: "pyth",
      feedId: HBAR_USD_PRICE_ID,
      purpose: "HBAR cash-leg conversion only",
      priceUsdE8: "10000000",
      confidenceUsdE8: "1000",
      observedAt: 1_700_000_000,
    },
    pyth: {
      feedId: HBAR_USD_PRICE_ID,
      purpose: "HBAR cash-leg conversion only",
      priceUsdE8: "10000000",
      confidenceUsdE8: "1000",
      publishTime: 1_700_000_000,
    },
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
        lender: { free: "10", held: "0" },
      },
    },
    accounting: {
      cashLiabilitiesTinybar: "0",
      reservedAutomationTinybar: "0",
      requiredBackingTinybar: "0",
      contractBalanceTinybar: "1",
    },
    verification: {
      complete: true,
      state,
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      contractLinks: Object.fromEntries(
        ["atsToken", "oracle", "rail", "acceptance"].map((name) => [
          name,
          hashScanContract(addresses[name]),
        ]),
      ),
      contractMirrorLinks: Object.fromEntries(
        ["atsToken", "oracle", "rail", "acceptance"].map((name) => [
          name,
          mirrorContract(addresses[name]),
        ]),
      ),
      linkAudit: {
        checkedAt: "2026-09-25T12:00:11.000Z",
        hashScanStatus: "available",
        mirrorStatus: "verified",
        hashScanChecked: transactions.length + 6,
        mirrorChecked: transactions.length + 6,
        finding: "docs/findings/test-proof-link-audit.md",
      },
    },
    metrics: {
      startedAt: "2026-09-25T12:00:00.000Z",
      completedAt: "2026-09-25T12:00:10.000Z",
      elapsedMilliseconds: 10_000,
      mirrorConfirmedTransactions: transactions.length,
    },
  };
}

function hip475Evidence() {
  const record = verifiedEvidence();
  const systemContract = "0x0000000000000000000000000000000000000168";
  record.oracle = {
    kind: "hedera-exchange-rate",
    systemContract,
    systemFile: "0.0.112",
    purpose: "HBAR cash-leg settlement conversion only",
    priceUsdE8: "10000000",
    confidenceUsdE8: "0",
    observedAt: 1_700_000_000,
    caveat:
      "HIP-475 exposes the active network settlement conversion rate, not a live market price oracle.",
  };
  record.pyth = null;
  record.addresses.pyth = null;
  record.addresses.exchangeRateSystem = systemContract;
  record.lifecycle.pythPriceUpdate = null;
  record.transactions[3].kind = "bootstrap-extra-4";
  record.verification.state.assertions["oracle.kind"] = "hedera-exchange-rate";
  record.verification.state.assertions["oracle.confidenceUsdE8"] = "0";
  return record;
}

test("endpoint policy accepts only exact public testnet endpoints", () => {
  assert.equal(
    validatedEndpoint("rpc", "https://testnet.hashio.io/api"),
    "https://testnet.hashio.io/api",
  );
  assert.throws(
    () => validatedEndpoint("rpc", "https://testnet.hashio.io/api?key=secret"),
    /allowlist/,
  );
  assert.throws(
    () => validatedEndpoint("mirror", "http://127.0.0.1"),
    /allowlist/,
  );
});

test("recipe CLI parsing is explicit and rejects missing values", () => {
  assert.equal(selectedRecipeId([]), "term-credit");
  assert.equal(
    selectedRecipeId(["--recipe", "maturity-bridge"]),
    "maturity-bridge",
  );
  assert.equal(
    selectedRecipeId(["--recipe=custom-facility"]),
    "custom-facility",
  );
  assert.throws(() => selectedRecipeId(["--recipe"]), /requires a recipe ID/);
  assert.throws(() => selectedRecipeId(["--recipe="]), /requires a recipe ID/);
});

test("funding budget rejects balances and allocations above the cap", () => {
  assert.doesNotThrow(() =>
    assertFundingBudget({
      signerTinybar: 250n * TINYBAR_PER_HBAR,
      actorFundingTinybar: 50n * TINYBAR_PER_HBAR,
    }),
  );
  assert.throws(
    () =>
      assertFundingBudget({
        signerTinybar: 251n * TINYBAR_PER_HBAR,
        actorFundingTinybar: 50n * TINYBAR_PER_HBAR,
      }),
    /between 0 and 250/,
  );
  assert.throws(
    () =>
      assertFundingBudget({
        signerTinybar: 40n * TINYBAR_PER_HBAR,
        actorFundingTinybar: 50n * TINYBAR_PER_HBAR,
      }),
    /exceed/i,
  );
  assert.throws(
    () =>
      assertFundingBudget({
        signerTinybar: 60n * TINYBAR_PER_HBAR,
        actorFundingTinybar: 50n * TINYBAR_PER_HBAR,
        executionReserveTinybar: 25n * TINYBAR_PER_HBAR,
      }),
    /execution reserve/,
  );
});

test("preflight binds the signer identity and balance to Mirror", async () => {
  const evmAddress = `0x${"a".repeat(40)}`;
  const identity = await confirmMirrorAccountIdentity({
    mirrorOrigin: "https://testnet.mirrornode.hedera.com",
    accountId: "0.0.123",
    evmAddress,
    fetchImpl: async () =>
      response({
        evm_address: evmAddress,
        balance: { balance: 25_000_000_000 },
      }),
  });
  assert.equal(identity.balanceTinybar, 25_000_000_000n);
  await assert.rejects(
    confirmMirrorAccountIdentity({
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      accountId: "0.0.123",
      evmAddress,
      fetchImpl: async () =>
        response({
          evm_address: `0x${"b".repeat(40)}`,
          balance: { balance: 25_000_000_000 },
        }),
    }),
    /does not match/,
  );
  await assert.rejects(
    confirmMirrorAccountIdentity({
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      accountId: "0.0.123",
      evmAddress,
      fetchImpl: async () => response({ evm_address: evmAddress, balance: {} }),
    }),
    /invalid.*balance/i,
  );
});

test("preflight waits for a newly created signer to reach Mirror", async () => {
  const evmAddress = `0x${"a".repeat(40)}`;
  let attempts = 0;
  const identity = await confirmMirrorAccountIdentity({
    mirrorOrigin: "https://testnet.mirrornode.hedera.com",
    accountId: "0.0.123",
    evmAddress,
    indexingDelaysMs: [0],
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? response({}, 404)
        : response({
            evm_address: evmAddress,
            balance: { balance: 25_000_000_000 },
          });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(identity.balanceTinybar, 25_000_000_000n);
});

test("preflight checks dependency bytecode and HSS capacity", async () => {
  const address = (digit) => `0x${digit.repeat(40)}`;
  await assert.doesNotReject(
    assertDependencyBytecode({
      publicClient: { getBytecode: async () => "0x6000" },
      dependencies: { factory: address("1"), resolver: address("2") },
    }),
  );
  await assert.rejects(
    assertDependencyBytecode({
      publicClient: { getBytecode: async () => "0x" },
      dependencies: { pyth: address("3") },
    }),
    /no bytecode/,
  );

  const expiries = [];
  const result = await assertHssCapacity({
    publicClient: {
      readContract: async ({ args }) => {
        expiries.push(args[0]);
        return expiries.length === 3;
      },
    },
    startSecond: 100,
    gasLimit: 750_000,
  });
  assert.equal(result, 110n);
  assert.deepEqual(expiries, [100n, 105n, 110n]);
});

test("HIP-475 preflight requires a positive canonical system response", async () => {
  const encodedRate = `0x${(7_802_800n * 100n).toString(16).padStart(64, "0")}`;
  const calls = [];
  const rate = await assertHip475Availability({
    publicClient: {
      call: async (request) => {
        calls.push(request);
        return { data: encodedRate };
      },
    },
  });
  assert.equal(rate, 780_280_000n);
  assert.deepEqual(calls, [
    {
      to: "0x0000000000000000000000000000000000000168",
      data: `0x43a88229${"5f5e100".padStart(64, "0")}`,
    },
  ]);

  await assert.rejects(
    assertHip475Availability({
      publicClient: { call: async () => ({ data: "0x" }) },
    }),
    /malformed/,
  );
  await assert.rejects(
    assertHip475Availability({
      publicClient: { call: async () => ({ data: `0x${"0".repeat(64)}` }) },
    }),
    /zero/,
  );
});

test("bootstrap proofs are categorized by semantics instead of position", () => {
  const hash = (digit) => `0x${digit.repeat(64)}`;
  const categorized = categorizeBootstrapTransactions([
    {
      hash: hash("1"),
      function: "grantKyc(address,string,uint256,uint256,address)",
    },
    { hash: hash("2"), contractName: "RailAcceptance" },
    { hash: hash("3"), function: "deployBond((bytes),(bytes))" },
    { hash: hash("4"), contractName: "AtsCollateralRail" },
    { hash: hash("5"), function: "addIssuer(address)" },
    { hash: hash("6"), function: "issue(address,uint256,bytes)" },
    { hash: hash("7"), contractName: "PythHbarUsdOracle" },
    {
      hash: hash("8"),
      function: "grantKyc(address,string,uint256,uint256,address)",
    },
    { hash: hash("9"), function: "fundAutomation()" },
  ]);
  assert.equal(
    proofForSemanticKind(categorized, "ats-bond-deployment").hash,
    hash("3"),
  );
  assert.equal(
    proofForSemanticKind(categorized, "kyc-grant", "last").hash,
    hash("8"),
  );
});

test("temporary account creation wraps SDK failures without key material", async () => {
  const sdk = {
    PrivateKey: {
      generateECDSA: () => ({
        publicKey: { toEvmAddress: () => "1".repeat(40) },
        toStringRaw: () => "2".repeat(64),
      }),
    },
    Hbar: class Hbar {},
    AccountCreateTransaction: class AccountCreateTransaction {
      setECDSAKeyWithAlias() {
        return this;
      }
      setInitialBalance() {
        return this;
      }
      async execute() {
        throw new Error("BUSY");
      }
    },
  };
  await assert.rejects(
    createTemporaryActor({
      sdk,
      client: {},
      label: "lender",
      initialHbar: 1,
      busyRetryDelaysMs: [],
    }),
    /Could not create temporary lender account: BUSY/,
  );
});

test("temporary account creation rebuilds a BUSY submission safely", async () => {
  let executions = 0;
  const sdk = {
    PrivateKey: {
      generateECDSA: () => ({
        publicKey: { toEvmAddress: () => "1".repeat(40) },
        toStringRaw: () => "2".repeat(64),
      }),
    },
    Hbar: class Hbar {},
    AccountCreateTransaction: class AccountCreateTransaction {
      setECDSAKeyWithAlias() {
        return this;
      }
      setInitialBalance() {
        return this;
      }
      async execute() {
        executions += 1;
        if (executions === 1) throw new Error("BUSY");
        return {
          getReceipt: async () => ({ accountId: { toString: () => "0.0.7" } }),
        };
      }
    },
  };
  const actor = await createTemporaryActor({
    sdk,
    client: {},
    label: "borrower",
    initialHbar: 1,
    busyRetryDelaysMs: [0],
  });
  assert.equal(executions, 2);
  assert.equal(actor.accountId, "0.0.7");
});

test("Foundry output redacts every signer key representation", () => {
  const key = `0x${"ab".repeat(32)}`;
  const decimal = BigInt(key).toString();
  const output = `hex=${key} raw=${key.slice(2).toUpperCase()} decimal=${decimal}`;
  const redacted = redactSignerMaterial(output, {
    HARNESS_SIGNER_PRIVATE_KEY: key,
  });
  assert.equal(redacted.includes(key), false);
  assert.equal(redacted.toLowerCase().includes(key.slice(2)), false);
  assert.equal(redacted.includes(decimal), false);
  assert.equal(redacted.match(/\[REDACTED\]/g)?.length, 3);
});

test("Hermes parser rejects missing and malformed Pyth data", () => {
  assert.deepEqual(parseHermesUpdate({ binary: { data: ["aabb"] } }), [
    "0xaabb",
  ]);
  assert.throws(() => parseHermesUpdate({ binary: { data: [] } }), /no binary/);
  assert.throws(
    () => parseHermesUpdate({ binary: { data: ["not-hex"] } }),
    /malformed/,
  );
});

test("default attribution requires receipt evidence for the fallback", () => {
  assert.equal(
    classifyDefaultPath({ state: 1 }, { state: 3 }, true),
    "permissionless-fallback",
  );
  assert.equal(classifyDefaultPath({ state: 3 }, { state: 3 }), "hss");
  assert.equal(classifyDefaultPath({ state: 1 }, { state: 3 }, false), "hss");
  assert.throws(
    () => classifyDefaultPath({ state: 3 }, { state: 3 }, true),
    /conflicts/,
  );
  assert.throws(
    () => classifyDefaultPath({ state: 1 }, { state: 1 }),
    /did not/,
  );
});

test("fallback receipt binds PositionDefaulted to the rail and position", () => {
  const rail = `0x${"1".repeat(40)}`;
  const otherRail = `0x${"2".repeat(40)}`;
  const positionId = `0x${"a".repeat(64)}`;
  const topics = encodeEventTopics({
    abi: railAbi,
    eventName: "PositionDefaulted",
    args: { positionId },
  });
  const log = {
    address: rail,
    topics,
    data: encodeAbiParameters([{ type: "uint256" }], [10n]),
  };
  assert.equal(
    receiptDefaultedPosition({ logs: [log] }, rail, positionId),
    true,
  );
  assert.equal(
    receiptDefaultedPosition({ logs: [log] }, otherRail, positionId),
    false,
  );
  assert.throws(
    () =>
      receiptDefaultedPosition({ logs: [log] }, rail, `0x${"b".repeat(64)}`),
    /unexpected position/,
  );
});

test("Mirror pagination follows same-origin pages and collects every result", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.toString());
    if (calls.length === 1) {
      return response({
        transactions: [{ result: "SUCCESS", nonce: 0 }],
        links: { next: "/api/v1/transactions?limit=1&timestamp=lt:2" },
      });
    }
    return response({
      transactions: [{ result: "SUCCESS", nonce: 1 }],
      links: { next: null },
    });
  };
  const transactions = await fetchMirrorPages({
    mirrorOrigin: "https://testnet.mirrornode.hedera.com",
    pathname: "/api/v1/transactions/0xabc",
    collectionKey: "transactions",
    fetchImpl,
  });
  assert.equal(transactions.length, 2);
  assert.equal(calls.length, 2);
});

test("Mirror pagination refuses cross-origin next links", async () => {
  await assert.rejects(
    fetchMirrorPages({
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      pathname: "/api/v1/transactions/0xabc",
      collectionKey: "transactions",
      fetchImpl: async () =>
        response({
          transactions: [],
          links: { next: "https://attacker.invalid/api/v1/transactions" },
        }),
    }),
    /escaped/,
  );
});

test("Mirror pagination rejects loops and unfinished page sets", async () => {
  const origin = "https://testnet.mirrornode.hedera.com";
  await assert.rejects(
    fetchMirrorPages({
      mirrorOrigin: origin,
      pathname: "/api/v1/transactions?limit=1",
      collectionKey: "transactions",
      fetchImpl: async () =>
        response({
          transactions: [],
          links: { next: "/api/v1/transactions?limit=1" },
        }),
    }),
    /loop/,
  );

  let page = 0;
  await assert.rejects(
    fetchMirrorPages({
      mirrorOrigin: origin,
      pathname: "/api/v1/transactions?limit=1&page=0",
      collectionKey: "transactions",
      maxPages: 2,
      fetchImpl: async () => {
        page += 1;
        return response({
          transactions: [],
          links: { next: `/api/v1/transactions?limit=1&page=${page}` },
        });
      },
    }),
    /page limit/,
  );
});

test("Mirror transaction polling rejects persistently empty results", async () => {
  await assert.rejects(
    waitForMirrorTransaction({
      mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      hash: `0x${"a".repeat(64)}`,
      timeoutMs: 5,
      intervalMs: 1,
      fetchImpl: async () => response({}, 404),
    }),
    /did not confirm/,
  );
});

test("Mirror transaction proof uses the Ethereum contract result endpoint", async () => {
  const hash = `0x${"a".repeat(64)}`;
  let requestedUrl;
  const proof = await waitForMirrorTransaction({
    mirrorOrigin: "https://testnet.mirrornode.hedera.com",
    hash,
    fetchImpl: async (url) => {
      requestedUrl = url.toString();
      return response({
        hash,
        status: "0x1",
        error_message: null,
        timestamp: "1700000000.123456789",
      });
    },
  });
  assert.equal(
    requestedUrl,
    `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash}`,
  );
  assert.equal(proof.result, "SUCCESS");
  assert.equal(proof.consensusTimestamp, "1700000000.123456789");
  assert.equal(
    proof.mirror,
    `https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${hash}`,
  );
});

test("evidence journal is retry-safe and rejects conflicting duplicates", () => {
  const hash = `0x${"a".repeat(64)}`;
  const journal = new EvidenceJournal();
  const transaction = {
    type: "transaction",
    hash,
    result: "SUCCESS",
    consensusTimestamp: "1.2",
    mirror: mirrorTransaction(hash),
    hashScan: `https://hashscan.io/testnet/transaction/${hash}`,
  };
  journal.add("fund", transaction);
  journal.add("fund", transaction);
  assert.equal(journal.values().length, 1);
  assert.throws(
    () => journal.add("accept", transaction),
    /Conflicting evidence/,
  );
});

test("sweep-back failure is reported without throwing or exposing a key", async () => {
  const sdk = {
    AccountId: { fromString: (value) => value },
    AccountDeleteTransaction: class AccountDeleteTransaction {
      setAccountId() {
        return this;
      }
      setTransferAccountId() {
        return this;
      }
      async freezeWith() {
        throw new Error("ACCOUNT_DELETED");
      }
    },
  };
  const result = await sweepTemporaryActor({
    sdk,
    client: {},
    actor: { accountId: "0.0.1", privateKey: {} },
    destinationId: "0.0.2",
  });
  assert.equal(result.swept, false);
  assert.match(result.error, /ACCOUNT_DELETED/);
  assert.equal("privateKey" in result, false);
});

test("verified evidence binds its recipe, policy, Mirror proofs, and links", () => {
  const record = verifiedEvidence();
  assert.equal(validateEvidenceRecord(record), record);

  record.transactions[0].hashScan = "https://example.com/not-proof";
  assert.throws(() => validateEvidenceRecord(record), /unverified transaction/);
});

test("evidence rejects Mirror origin escape and incomplete link audits", () => {
  const escaped = verifiedEvidence();
  escaped.transactions[0].mirror =
    "https://testnet.mirrornode.hedera.com.attacker.invalid/api/v1/contracts/results/" +
    escaped.transactions[0].hash;
  assert.throws(
    () => validateEvidenceRecord(escaped),
    /unverified transaction/,
  );

  const wrongContract = verifiedEvidence();
  wrongContract.verification.contractMirrorLinks.rail =
    "https://example.com/api/v1/contracts/0.0.1";
  assert.throws(() => validateEvidenceRecord(wrongContract), /Mirror source/);

  const incompleteAudit = verifiedEvidence();
  incompleteAudit.verification.linkAudit.hashScanChecked = 1;
  assert.throws(() => validateEvidenceRecord(incompleteAudit), /link audit/);
});

test("oracle evidence accepts both explicit Pyth and HIP-475 proof models", () => {
  const pyth = verifiedEvidence();
  assert.equal(validateEvidenceRecord(pyth), pyth);

  const hip475 = hip475Evidence();
  assert.equal(validateEvidenceRecord(hip475), hip475);
});

test("oracle evidence rejects proof claims from the other oracle mode", () => {
  const hip475WithPythReceipt = hip475Evidence();
  hip475WithPythReceipt.lifecycle.pythPriceUpdate =
    hip475WithPythReceipt.transactions[3];
  assert.throws(
    () => validateEvidenceRecord(hip475WithPythReceipt),
    /must not claim a Pyth update transaction/,
  );

  const pythWithoutReceipt = verifiedEvidence();
  pythWithoutReceipt.lifecycle.pythPriceUpdate = null;
  assert.throws(
    () => validateEvidenceRecord(pythWithoutReceipt),
    /must claim its Mirror-confirmed update transaction/,
  );

  const inconsistentPyth = verifiedEvidence();
  inconsistentPyth.pyth.priceUsdE8 = "99999999";
  assert.throws(
    () => validateEvidenceRecord(inconsistentPyth),
    /missing Pyth oracle data/,
  );
});

test("evidence rejects forbidden secret-shaped fields", () => {
  const record = verifiedEvidence();
  record.verification.operatorPrivateKey = "redacted-is-still-forbidden";
  assert.throws(() => validateEvidenceRecord(record), /forbidden field/);
});

test("policy evidence must stay inside the kernel safety envelope", () => {
  const record = verifiedEvidence();
  assert.equal(validateRailPolicyEvidence(record.policy), record.policy);

  record.policy.maximumAdvanceBps = 7_001;
  assert.throws(
    () => validateEvidenceRecord(record),
    /outside the kernel safety envelope/,
  );
});

test("evidence rejects missing recipes and lifecycle proofs without binding", () => {
  const missingRecipe = verifiedEvidence();
  missingRecipe.recipeId = null;
  assert.throws(() => validateEvidenceRecord(missingRecipe), /recipe ID/);

  const unknownHash = verifiedEvidence();
  unknownHash.lifecycle.holdCreation = {
    ...unknownHash.lifecycle.holdCreation,
    hash: `0x${"f".repeat(64)}`,
    mirror: mirrorTransaction(`0x${"f".repeat(64)}`),
    hashScan: hashScanTransaction(`0x${"f".repeat(64)}`),
  };
  assert.throws(() => validateEvidenceRecord(unknownHash), /not bound/);

  const wrongSemanticKind = verifiedEvidence();
  wrongSemanticKind.lifecycle.fundedOffer = wrongSemanticKind.transactions[7];
  assert.throws(
    () => validateEvidenceRecord(wrongSemanticKind),
    /semantic transaction proof/,
  );
});

test("position amounts and hold identifiers are canonical and nonzero", () => {
  const zeroLikeHold = verifiedEvidence();
  zeroLikeHold.positions[0].holdId = "00";
  zeroLikeHold.holds[0].holdId = "00";
  zeroLikeHold.holds[0].state.assertions["hold.holdId"] = "00";
  assert.throws(
    () => validateEvidenceRecord(zeroLikeHold),
    /incomplete position proof/,
  );

  const underpayment = verifiedEvidence();
  underpayment.positions[0].repaymentTinybar = "99";
  assert.throws(
    () => validateEvidenceRecord(underpayment),
    /incomplete position proof/,
  );
});

test("each scheduled position has one distinct Mirror schedule", () => {
  const sharedSchedule = verifiedEvidence();
  sharedSchedule.positions[0].scheduleAddress =
    sharedSchedule.positions[1].scheduleAddress;
  assert.throws(
    () => validateEvidenceRecord(sharedSchedule),
    /schedule is not bound/,
  );
});

test("terminal automation requires an executed schedule or explicit unavailability", () => {
  const staleSchedule = verifiedEvidence();
  staleSchedule.schedules[0].executedTimestamp = null;
  assert.throws(
    () => validateEvidenceRecord(staleSchedule),
    /schedule execution contradicts/,
  );

  const missingSchedule = verifiedEvidence();
  missingSchedule.positions[0].scheduleAddress =
    "0x0000000000000000000000000000000000000000";
  missingSchedule.schedules = [missingSchedule.schedules[1]];
  assert.throws(
    () => validateEvidenceRecord(missingSchedule),
    /without a schedule must record unavailable automation/,
  );
});

test("HSS terminal evidence requires an executed schedule bound to default", () => {
  const missingExecution = verifiedEvidence();
  missingExecution.schedules[0].executedTimestamp = null;
  missingExecution.lifecycle.hssScheduleCreation.executedTimestamp = null;
  missingExecution.lifecycle.maturedDefault.executedTimestamp = null;
  assert.throws(
    () => validateEvidenceRecord(missingExecution),
    /schedule execution contradicts|executed schedule proof/,
  );

  const wrongPath = verifiedEvidence();
  wrongPath.positions[1].terminalPath = "permissionless-fallback";
  assert.throws(
    () => validateEvidenceRecord(wrongPath),
    /Fallback terminal path/,
  );
});

test("permissionless fallback is accepted only with a verified transaction", () => {
  const record = verifiedEvidence();
  record.positions[1].terminalPath = "permissionless-fallback";
  record.transactions[9].kind = "permissionless-default";
  record.lifecycle.maturedDefault = record.transactions[9];
  assert.equal(validateEvidenceRecord(record), record);

  record.lifecycle.maturedDefault = record.schedules[0];
  assert.throws(() => validateEvidenceRecord(record), /Fallback terminal path/);
});

test("hold inspections bind both positions to exact block state", () => {
  const missingHold = verifiedEvidence();
  missingHold.holds.pop();
  assert.throws(
    () => validateEvidenceRecord(missingHold),
    /two exact ATS hold/,
  );

  const wrongEscrow = verifiedEvidence();
  wrongEscrow.holds[0].escrow = wrongEscrow.addresses.oracle;
  assert.throws(() => validateEvidenceRecord(wrongEscrow), /invalid ATS hold/);

  const residualHold = verifiedEvidence();
  residualHold.holds[0].terminalState.assertions["hold.remainingAmount"] = "1";
  assert.throws(
    () => validateEvidenceRecord(residualHold),
    /terminal hold proof/,
  );

  const staleTerminalRead = verifiedEvidence();
  staleTerminalRead.holds[0].terminalState.blockNumber = "1233";
  assert.throws(
    () => validateEvidenceRecord(staleTerminalRead),
    /final verification block/,
  );
});

test("state assertions and metrics must be complete and internally bound", () => {
  const missingAssertion = verifiedEvidence();
  delete missingAssertion.verification.state.assertions[
    "rail.contractBalanceTinybar"
  ];
  assert.throws(
    () => validateEvidenceRecord(missingAssertion),
    /missing assertion/,
  );

  const wrongMetrics = verifiedEvidence();
  wrongMetrics.metrics.mirrorConfirmedTransactions = 1;
  assert.throws(() => validateEvidenceRecord(wrongMetrics), /metrics/);

  const inconsistentElapsed = verifiedEvidence();
  inconsistentElapsed.metrics.elapsedMilliseconds = 9_999;
  assert.throws(() => validateEvidenceRecord(inconsistentElapsed), /metrics/);
});
