import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { readFile, writeFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
} from "viem";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  atsAbi,
  oracleAbi,
  pythAbi,
  railAbi,
} from "@collateral-rail/shared/abis";
import {
  DEFAULT_PARTITION,
  WEIBAR_PER_TINYBAR,
  tinybarToWeibar,
} from "@collateral-rail/shared/hedera";
import {
  EvidenceJournal,
  HBAR_USD_PRICE_ID,
  MIN_EXECUTION_RESERVE_HBAR,
  TINYBAR_PER_HBAR,
  assertDependencyBytecode,
  assertFundingBudget,
  assertHip475Availability,
  assertHssCapacity,
  assertRailSolvency,
  categorizeBootstrapTransactions,
  classifyDefaultPath,
  confirmMirrorAccountIdentity,
  createTemporaryActor,
  fetchAllowedJson,
  hashScanContract,
  mirrorContract,
  parseHermesUpdate,
  proofForSemanticKind,
  readCurrentMirrorBalance,
  sweepTemporaryActor,
  validateEvidenceRecord,
  waitForMirrorTransaction,
} from "./lib/evidence-lib.mjs";
import { readDemoConfiguration } from "./lib/demo-config.ts";
import {
  ACTOR_FUNDING_HBAR,
  ANNUAL_RATE_BPS,
  COLLATERAL_PER_POSITION,
  HEDERA_WRITE_GAS,
  PRINCIPAL_USD_E8,
  TERM_SECONDS,
  ZERO_ADDRESS,
  addressesPath,
  assertRequiredEvidenceTools,
  assertWritableArtifactPath,
  automationStateName,
  blockAfterScheduleExecution,
  broadcastPath,
  chain,
  confirmScheduleWithRetry,
  offerFundedArgs,
  outputPath,
  positionOpenedArgs,
  positionStateName,
  receiptDefaultedPosition,
  requireAddress,
  runFoundry,
  waitUntil,
} from "./lib/demo-runtime.ts";
import { readVerifiedFinalState } from "./lib/demo-verification.ts";

async function main() {
  const startedAtMilliseconds = Date.now();
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  const {
    recipe,
    signer,
    rpcUrl,
    mirrorUrl,
    hermesUrl,
    pythApiKey,
    oracleKind,
    factory,
    resolver,
    pyth,
  } = readDemoConfiguration();

  const operatorKey = PrivateKey.fromStringECDSA(signer.privateKey.slice(2));
  const derivedAddress = `0x${operatorKey.publicKey.toEvmAddress()}`;
  if (derivedAddress.toLowerCase() !== signer.evmAddress.toLowerCase()) {
    throw new Error(
      "Harness signer key does not match its public EVM address.",
    );
  }
  const mirrorSigner = await confirmMirrorAccountIdentity({
    mirrorOrigin: mirrorUrl,
    accountId: signer.accountId,
    evmAddress: signer.evmAddress,
  });
  assertFundingBudget({
    signerTinybar: mirrorSigner.balanceTinybar,
    actorFundingTinybar: BigInt(ACTOR_FUNDING_HBAR * 2) * TINYBAR_PER_HBAR,
    executionReserveTinybar: MIN_EXECUTION_RESERVE_HBAR * TINYBAR_PER_HBAR,
  });

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  async function hederaFeeFields() {
    const minimumGasPrice = await publicClient.getGasPrice();
    if (
      minimumGasPrice < WEIBAR_PER_TINYBAR ||
      minimumGasPrice > 500n * WEIBAR_PER_TINYBAR ||
      minimumGasPrice % WEIBAR_PER_TINYBAR !== 0n
    ) {
      throw new Error("Hedera RPC returned an unsafe gas price.");
    }
    return {
      maxFeePerGas: minimumGasPrice * 2n,
      maxPriorityFeePerGas: 0n,
    } as const;
  }
  async function fetchPythUpdate() {
    if (!pythApiKey) throw new Error("Pyth oracle mode requires PYTH_API_KEY.");
    const payload = await fetchAllowedJson(
      `${hermesUrl}/v2/updates/price/latest?ids%5B%5D=${HBAR_USD_PRICE_ID.slice(2)}&encoding=hex`,
      new URL(hermesUrl).origin,
      fetch,
      { Authorization: `Bearer ${pythApiKey}` },
    );
    const updateData = parseHermesUpdate(payload) as Hex[];
    const updateFeeTinybar = await publicClient.readContract({
      address: pyth,
      abi: pythAbi,
      functionName: "getUpdateFee",
      args: [updateData],
    });
    return { updateData, updateFeeTinybar };
  }

  await assertWritableArtifactPath(outputPath);
  await assertRequiredEvidenceTools();
  await assertDependencyBytecode({
    publicClient,
    dependencies:
      oracleKind === "pyth"
        ? { factory, resolver, pyth }
        : { factory, resolver },
  });
  if (oracleKind === "hedera-exchange-rate") {
    await assertHip475Availability({ publicClient });
  }
  await assertHssCapacity({
    publicClient,
    startSecond: Math.floor(Date.now() / 1_000) + Number(TERM_SECONDS) + 2,
    gasLimit: 750_000,
  });
  await hederaFeeFields();
  if (oracleKind === "pyth") await fetchPythUpdate();
  const journal = new EvidenceJournal();
  const actors: Array<Awaited<ReturnType<typeof createTemporaryActor>>> = [];
  const sweepResults: Array<Awaited<ReturnType<typeof sweepTemporaryActor>>> =
    [];

  async function verifyHash(kind: string, hash: Hash) {
    const proof = await waitForMirrorTransaction({
      mirrorOrigin: mirrorUrl,
      hash,
    });
    return journal.add(kind, proof);
  }

  async function writeAndVerify(kind: string, write: () => Promise<Hash>) {
    const hash = await write();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${kind} reverted.`);
    const proof = await verifyHash(kind, hash);
    return { hash, receipt, proof };
  }

  const sdkClient = Client.forTestnet().setOperator(
    AccountId.fromString(signer.accountId),
    operatorKey,
  );
  try {
    console.log(
      "Creating temporary lender and borrower accounts on Hedera testnet.",
    );
    const lender = await createTemporaryActor({
      sdk: await import("@hiero-ledger/sdk"),
      client: sdkClient,
      label: "lender",
      initialHbar: ACTOR_FUNDING_HBAR,
    });
    actors.push(lender);
    const borrower = await createTemporaryActor({
      sdk: await import("@hiero-ledger/sdk"),
      client: sdkClient,
      label: "borrower",
      initialHbar: ACTOR_FUNDING_HBAR,
    });
    actors.push(borrower);
    const lenderAddress = requireAddress("temporary lender", lender.evmAddress);
    const borrowerAddress = requireAddress(
      "temporary borrower",
      borrower.evmAddress,
    );

    console.log(
      "Deploying the ATS bond, oracle, rail, and acceptance verifier.",
    );
    await runFoundry({
      ...process.env,
      HEDERA_NETWORK: "testnet",
      HEDERA_TESTNET_RPC_URL: rpcUrl,
      HEDERA_MIRROR_URL: mirrorUrl,
      PYTH_HERMES_URL: hermesUrl,
      ATS_FACTORY_ADDRESS: factory,
      ATS_RESOLVER_ADDRESS: resolver,
      PYTH_ADDRESS: pyth,
      USE_PYTH_ORACLE: oracleKind === "pyth" ? "1" : "0",
      HEDERA_OPERATOR_ADDRESS: signer.evmAddress,
      LENDER_ADDRESS: lenderAddress,
      BORROWER_ADDRESS: borrowerAddress,
      RAIL_MAXIMUM_ADVANCE_BPS: String(recipe.policy.maximumAdvanceBps),
      RAIL_MAXIMUM_ANNUAL_RATE_BPS: String(recipe.policy.maximumAnnualRateBps),
      RAIL_MAXIMUM_QUOTE_MOVEMENT_BPS: String(
        recipe.policy.maximumQuoteMovementBps,
      ),
      RAIL_MINIMUM_TERM_SECONDS: String(recipe.policy.minimumTermSeconds),
      RAIL_MAXIMUM_TERM_SECONDS: String(recipe.policy.maximumTermSeconds),
      RAIL_MAXIMUM_OFFER_LIFETIME_SECONDS: String(
        recipe.policy.maximumOfferLifetimeSeconds,
      ),
    });

    const addresses = JSON.parse(await readFile(addressesPath, "utf8"));
    const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
    const atsToken = requireAddress("ATS token", addresses.atsToken);
    const oracle = requireAddress("oracle", addresses.oracle);
    const rail = requireAddress("rail", addresses.rail);
    const acceptance = requireAddress("acceptance", addresses.acceptance);
    const broadcastTransactions = categorizeBootstrapTransactions(
      broadcast.transactions ?? [],
    );
    const deploymentProofs = [];
    for (const transaction of broadcastTransactions) {
      deploymentProofs.push(
        await verifyHash(transaction.kind, transaction.hash as Hash),
      );
    }

    const lenderWallet = createWalletClient({
      account: privateKeyToAccount(lender.privateKeyHex as Hex),
      chain,
      transport: http(rpcUrl),
    });
    const borrowerWallet = createWalletClient({
      account: privateKeyToAccount(borrower.privateKeyHex as Hex),
      chain,
      transport: http(rpcUrl),
    });

    if (oracleKind === "pyth") {
      console.log("Submitting a fresh Pyth HBAR/USD update.");
      const initialPyth = await fetchPythUpdate();
      await writeAndVerify("pyth-price-update", async () =>
        lenderWallet.writeContract({
          address: oracle,
          abi: oracleAbi,
          functionName: "updatePrice",
          args: [initialPyth.updateData],
          value: tinybarToWeibar(initialPyth.updateFeeTinybar),
          gas: HEDERA_WRITE_GAS.oracleUpdate,
          ...(await hederaFeeFields()),
        }),
      );
    } else {
      console.log("Using Hedera HIP-475 for HBAR settlement conversion.");
    }

    await writeAndVerify("ats-allowance", async () =>
      borrowerWallet.writeContract({
        address: atsToken,
        abi: atsAbi,
        functionName: "approve",
        args: [rail, COLLATERAL_PER_POSITION * 2n],
        gas: HEDERA_WRITE_GAS.atsApproval,
        ...(await hederaFeeFields()),
      }),
    );

    console.log("Funding and accepting two bilateral facilities.");
    const positions: Array<{
      id: Hex;
      opened: {
        lender: Address;
        borrower: Address;
        collateralAmount: bigint;
        holdId: bigint;
        principalTinybar: bigint;
        repaymentTinybar: bigint;
        openedAt: bigint;
        maturity: bigint;
        scheduleAddress: Address;
        state: number;
        automation: number;
      };
      hold: readonly unknown[];
    }> = [];
    const schedules: Array<
      Awaited<ReturnType<typeof confirmScheduleWithRetry>>
    > = [];
    const holds = [];
    const fundTransactions: Array<Awaited<ReturnType<typeof writeAndVerify>>> =
      [];
    const acceptTransactions: Array<
      Awaited<ReturnType<typeof writeAndVerify>>
    > = [];
    async function requireExecutedSchedule(scheduleAddress: Address) {
      if (scheduleAddress === ZERO_ADDRESS) {
        throw new Error("HSS default has no schedule address.");
      }
      const executedSchedule = await confirmScheduleWithRetry({
        mirrorOrigin: mirrorUrl,
        scheduleAddress,
        requireExecuted: true,
      });
      const scheduleIndex = schedules.findIndex(
        ({ address }) =>
          address.toLowerCase() === scheduleAddress.toLowerCase(),
      );
      if (scheduleIndex < 0) {
        throw new Error(
          "Executed HSS schedule is not bound to an opened position.",
        );
      }
      if (executedSchedule.executedTimestamp === null) {
        throw new Error("Mirror did not report the HSS execution timestamp.");
      }
      schedules[scheduleIndex] = executedSchedule;
      return executedSchedule;
    }

    for (let sequence = 0; sequence < 2; sequence += 1) {
      const terms = {
        borrower: borrowerAddress,
        collateralAmount: COLLATERAL_PER_POSITION,
        principalUsdE8: PRINCIPAL_USD_E8,
        annualRateBps: ANNUAL_RATE_BPS,
        termSeconds: TERM_SECONDS,
        offerExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
      };
      const preview = await publicClient.readContract({
        address: rail,
        abi: railAbi,
        functionName: "previewOffer",
        args: [terms],
      });
      const funded = await writeAndVerify(
        `fund-offer-${sequence + 1}`,
        async () =>
          lenderWallet.writeContract({
            address: rail,
            abi: railAbi,
            functionName: "fundOffer",
            args: [terms],
            value: tinybarToWeibar(preview[1]),
            gas: HEDERA_WRITE_GAS.fundOffer,
            ...(await hederaFeeFields()),
          }),
      );
      fundTransactions.push(funded);
      const offerId = offerFundedArgs(funded.receipt).offerId;
      const accepted = await writeAndVerify(
        `accept-offer-${sequence + 1}`,
        async () =>
          borrowerWallet.writeContract({
            address: rail,
            abi: railAbi,
            functionName: "acceptOffer",
            args: [offerId],
            gas: HEDERA_WRITE_GAS.acceptOffer,
            ...(await hederaFeeFields()),
          }),
      );
      acceptTransactions.push(accepted);
      const opened = positionOpenedArgs(accepted.receipt);
      const position = await publicClient.readContract({
        address: rail,
        abi: railAbi,
        functionName: "getPosition",
        args: [opened.positionId],
        blockNumber: accepted.receipt.blockNumber,
      });
      const hold = await publicClient.readContract({
        address: atsToken,
        abi: atsAbi,
        functionName: "getHoldForByPartition",
        args: [
          {
            partition: DEFAULT_PARTITION,
            tokenHolder: borrowerAddress,
            holdId: position.holdId,
          },
        ],
        blockNumber: accepted.receipt.blockNumber,
      });
      const expectedHoldData = encodeAbiParameters(
        [{ type: "bytes32" }],
        [opened.positionId],
      );
      if (
        hold[0] !== COLLATERAL_PER_POSITION ||
        hold[1] <= position.maturity ||
        hold[2].toLowerCase() !== rail.toLowerCase() ||
        hold[3].toLowerCase() !== ZERO_ADDRESS ||
        hold[4].toLowerCase() !== expectedHoldData.toLowerCase() ||
        hold[5] !== "0x"
      ) {
        throw new Error(
          "ATS hold inspection did not match the facility terms.",
        );
      }
      const holdState = {
        type: "state",
        blockNumber: accepted.receipt.blockNumber.toString(),
        rpcOrigin: new URL(rpcUrl).origin,
        assertions: {
          "hold.positionId": opened.positionId,
          "hold.holdId": position.holdId.toString(),
          "hold.holder": borrowerAddress,
          "hold.partition": DEFAULT_PARTITION,
          "hold.amount": hold[0].toString(),
          "hold.expirationTimestamp": hold[1].toString(),
          "hold.escrow": hold[2],
          "hold.destination": hold[3],
          "hold.data": hold[4],
          "hold.operatorData": hold[5],
          "hold.thirdPartyType": Number(hold[6]),
        },
      } as const;
      holds.push({
        positionId: opened.positionId,
        holdId: position.holdId.toString(),
        holder: borrowerAddress,
        partition: DEFAULT_PARTITION,
        amount: hold[0].toString(),
        expirationTimestamp: hold[1].toString(),
        escrow: hold[2],
        destination: hold[3],
        data: hold[4],
        operatorData: hold[5],
        thirdPartyType: Number(hold[6]),
        state: holdState,
      });
      if (position.scheduleAddress !== ZERO_ADDRESS) {
        schedules.push(
          await confirmScheduleWithRetry({
            mirrorOrigin: mirrorUrl,
            scheduleAddress: position.scheduleAddress,
          }),
        );
      }
      positions.push({
        id: opened.positionId,
        opened: position,
        hold: [...hold],
      });
    }
    if (schedules.length === 0) {
      throw new Error("No real HSS schedule was created for either position.");
    }

    await writeAndVerify("borrower-withdrawal", async () =>
      borrowerWallet.writeContract({
        address: rail,
        abi: railAbi,
        functionName: "withdraw",
        gas: HEDERA_WRITE_GAS.withdrawal,
        ...(await hederaFeeFields()),
      }),
    );
    const repaid = await writeAndVerify("repay-position", async () =>
      borrowerWallet.writeContract({
        address: rail,
        abi: railAbi,
        functionName: "repay",
        args: [positions[0].id],
        value: tinybarToWeibar(positions[0].opened.repaymentTinybar),
        gas: HEDERA_WRITE_GAS.repayment,
        ...(await hederaFeeFields()),
      }),
    );
    await writeAndVerify("lender-withdrawal", async () =>
      lenderWallet.writeContract({
        address: rail,
        abi: railAbi,
        functionName: "withdraw",
        gas: HEDERA_WRITE_GAS.withdrawal,
        ...(await hederaFeeFields()),
      }),
    );

    console.log("Waiting for the second two-minute facility to mature.");
    await waitUntil(Number(positions[1].opened.maturity) + 12);
    const beforeFallback = await publicClient.readContract({
      address: rail,
      abi: railAbi,
      functionName: "getPosition",
      args: [positions[1].id],
    });
    let defaultTerminalProof;
    let fallbackReceiptEmittedDefault = false;
    if (Number(beforeFallback.state) === 3) {
      const executedSchedule = await requireExecutedSchedule(
        beforeFallback.scheduleAddress,
      );
      defaultTerminalProof = executedSchedule;
      await blockAfterScheduleExecution(
        publicClient,
        executedSchedule.executedTimestamp,
      );
    } else {
      if (Number(beforeFallback.state) !== 1) {
        throw new Error("Fallback settlement requires an open position.");
      }
      const fallbackHash = await lenderWallet.writeContract({
        address: rail,
        abi: railAbi,
        functionName: "settle",
        args: [positions[1].id],
        gas: HEDERA_WRITE_GAS.settlement,
        ...(await hederaFeeFields()),
      });
      const fallbackReceipt = await publicClient.waitForTransactionReceipt({
        hash: fallbackHash,
      });
      if (fallbackReceipt.status !== "success") {
        throw new Error("permissionless-default reverted.");
      }
      fallbackReceiptEmittedDefault = receiptDefaultedPosition(
        fallbackReceipt,
        rail,
        positions[1].id,
      );
      const fallbackProof = await verifyHash(
        fallbackReceiptEmittedDefault
          ? "permissionless-default"
          : "settle-race-noop",
        fallbackHash,
      );
      if (fallbackReceiptEmittedDefault) {
        defaultTerminalProof = fallbackProof;
      } else {
        const afterRace = await publicClient.readContract({
          address: rail,
          abi: railAbi,
          functionName: "getPosition",
          args: [positions[1].id],
          blockNumber: fallbackReceipt.blockNumber,
        });
        if (Number(afterRace.state) !== 3) {
          throw new Error(
            "Settlement receipt did not default the position and HSS did not win the race.",
          );
        }
        defaultTerminalProof = await requireExecutedSchedule(
          afterRace.scheduleAddress,
        );
      }
    }

    let pythRefresh: Awaited<ReturnType<typeof writeAndVerify>> | null = null;
    let verificationBlock: bigint;
    if (oracleKind === "pyth") {
      console.log("Refreshing Pyth before the final verified state read.");
      const finalPyth = await fetchPythUpdate();
      pythRefresh = await writeAndVerify("pyth-price-refresh", async () =>
        lenderWallet.writeContract({
          address: oracle,
          abi: oracleAbi,
          functionName: "updatePrice",
          args: [finalPyth.updateData],
          value: tinybarToWeibar(finalPyth.updateFeeTinybar),
          gas: HEDERA_WRITE_GAS.oracleUpdate,
          ...(await hederaFeeFields()),
        }),
      );
      verificationBlock = pythRefresh.receipt.blockNumber;
    } else {
      verificationBlock = await publicClient.getBlockNumber();
    }
    const finalPositions = await Promise.all(
      positions.map(({ id }) =>
        publicClient.readContract({
          address: rail,
          abi: railAbi,
          functionName: "getPosition",
          args: [id],
          blockNumber: verificationBlock,
        }),
      ),
    );
    for (let index = 0; index < positions.length; index += 1) {
      const terminalHold = await publicClient.readContract({
        address: atsToken,
        abi: atsAbi,
        functionName: "getHoldForByPartition",
        args: [
          {
            partition: DEFAULT_PARTITION,
            tokenHolder: borrowerAddress,
            holdId: finalPositions[index].holdId,
          },
        ],
        blockNumber: verificationBlock,
      });
      if (
        terminalHold[0] !== 0n ||
        terminalHold[1] !== 0n ||
        terminalHold[2] !== ZERO_ADDRESS ||
        terminalHold[3] !== ZERO_ADDRESS ||
        terminalHold[4] !== "0x" ||
        terminalHold[5] !== "0x" ||
        Number(terminalHold[6]) !== 0
      ) {
        throw new Error("A terminal position retained a live ATS hold.");
      }
      holds[index] = {
        ...holds[index],
        terminalState: {
          type: "state",
          blockNumber: verificationBlock.toString(),
          rpcOrigin: new URL(rpcUrl).origin,
          assertions: {
            "hold.positionId": positions[index].id,
            "hold.holdId": finalPositions[index].holdId.toString(),
            "hold.holder": borrowerAddress,
            "hold.partition": DEFAULT_PARTITION,
            "hold.remainingAmount": "0",
            "hold.deleted": true,
          },
        },
      };
    }
    const defaultPath = classifyDefaultPath(
      beforeFallback,
      finalPositions[1],
      fallbackReceiptEmittedDefault,
    );

    // A repaid position can still have a scheduled no-op at maturity. Refresh
    // every schedule after both maturities so the published record never
    // preserves an acceptance-time null execution timestamp.
    for (const position of finalPositions) {
      if (position.scheduleAddress !== ZERO_ADDRESS) {
        await requireExecutedSchedule(position.scheduleAddress);
      }
    }

    const {
      internalKyc,
      issuer,
      lenderKyc,
      borrowerKyc,
      assetMaturity,
      clearingActive,
      tokenDecimals,
      nominalValue,
      nominalValueDecimals,
      nominalValueCurrency,
      issuerRole,
      kycRole,
      ssiRole,
      borrowerFree,
      borrowerHeld,
      lenderFree,
      lenderHeld,
      cashLiabilities,
      reservedAutomation,
      requiredBacking,
      policy,
      oraclePriceUsdE8,
      oracleConfidenceUsdE8,
      oraclePublishTime,
    } = await readVerifiedFinalState({
      publicClient,
      atsToken,
      oracle,
      rail,
      issuer: signer.evmAddress,
      lender: lenderAddress,
      borrower: borrowerAddress,
      expectedPolicy: recipe.policy,
      blockNumber: verificationBlock,
    });
    const balanceProof = await readCurrentMirrorBalance({
      mirrorOrigin: mirrorUrl,
      evmAddress: rail,
    });
    assertRailSolvency({
      balanceTinybar: balanceProof.balanceTinybar,
      requiredBackingTinybar: requiredBacking.toString(),
    });

    const defaultSchedule = schedules.find(
      ({ address }) =>
        address.toLowerCase() ===
        finalPositions[1].scheduleAddress.toLowerCase(),
    );
    const lifecycleSchedule = defaultSchedule ?? schedules[0];
    const stateProof = {
      type: "state",
      blockNumber: verificationBlock.toString(),
      rpcOrigin: new URL(rpcUrl).origin,
      assertions: {
        "ats.internalKyc": internalKyc,
        "ats.issuer": issuer,
        "ats.lenderKyc": Number(lenderKyc),
        "ats.borrowerKyc": Number(borrowerKyc),
        "ats.assetMaturity": assetMaturity.toString(),
        "ats.clearingActive": clearingActive,
        "ats.tokenDecimals": Number(tokenDecimals),
        "ats.nominalValue": nominalValue.toString(),
        "ats.nominalValueDecimals": Number(nominalValueDecimals),
        "ats.nominalValueCurrency": nominalValueCurrency,
        "ats.borrowerFree": borrowerFree.toString(),
        "ats.borrowerHeld": borrowerHeld.toString(),
        "ats.lenderFree": lenderFree.toString(),
        "ats.lenderHeld": lenderHeld.toString(),
        "rail.cashLiabilitiesTinybar": cashLiabilities.toString(),
        "rail.reservedAutomationTinybar": reservedAutomation.toString(),
        "rail.requiredBackingTinybar": requiredBacking.toString(),
        "rail.policy.maximumAdvanceBps": policy.maximumAdvanceBps,
        "rail.policy.maximumAnnualRateBps": policy.maximumAnnualRateBps,
        "rail.policy.maximumQuoteMovementBps": policy.maximumQuoteMovementBps,
        "rail.policy.minimumTermSeconds": policy.minimumTermSeconds,
        "rail.policy.maximumTermSeconds": policy.maximumTermSeconds,
        "rail.policy.maximumOfferLifetimeSeconds":
          policy.maximumOfferLifetimeSeconds,
        "oracle.kind": oracleKind,
        "oracle.priceUsdE8": oraclePriceUsdE8.toString(),
        "oracle.confidenceUsdE8": oracleConfidenceUsdE8.toString(),
        "oracle.observedAt": Number(oraclePublishTime),
        "positions.repaidState": positionStateName(finalPositions[0].state),
        "positions.defaultedState": positionStateName(finalPositions[1].state),
      },
    } as const;
    const completedAtMilliseconds = Date.now();
    const completedAt = new Date(completedAtMilliseconds).toISOString();
    const verifiedTransactions = journal.values();
    const record = {
      schemaVersion: 3,
      network: "hedera-testnet",
      chainId: 296,
      status: "verified",
      generatedAt: completedAt,
      recipeId: recipe.id,
      policy,
      addresses: {
        factory,
        resolver,
        pyth: oracleKind === "pyth" ? pyth : null,
        exchangeRateSystem:
          oracleKind === "hedera-exchange-rate"
            ? "0x0000000000000000000000000000000000000168"
            : null,
        atsToken,
        oracle,
        rail,
        acceptance,
      },
      actors: {
        issuer: { accountId: signer.accountId, evmAddress: signer.evmAddress },
        lender: { accountId: lender.accountId, evmAddress: lenderAddress },
        borrower: {
          accountId: borrower.accountId,
          evmAddress: borrowerAddress,
        },
      },
      transactions: verifiedTransactions,
      lifecycle: {
        atsBondDeployment: proofForSemanticKind(
          deploymentProofs,
          "ats-bond-deployment",
        ),
        ssiAndKycConfiguration: proofForSemanticKind(
          deploymentProofs,
          "kyc-grant",
          "last",
        ),
        collateralIssuance: proofForSemanticKind(
          deploymentProofs,
          "collateral-issuance",
        ),
        pythPriceUpdate: pythRefresh?.proof ?? null,
        fundedOffer: fundTransactions[0].proof,
        holdCreation: acceptTransactions[0].proof,
        hssScheduleCreation: lifecycleSchedule,
        repaidFacility: repaid.proof,
        maturedDefault: defaultTerminalProof,
        liveConfigurationRead: stateProof,
      },
      oracle:
        oracleKind === "pyth"
          ? {
              kind: "pyth",
              feedId: HBAR_USD_PRICE_ID,
              purpose: "HBAR cash-leg conversion only",
              priceUsdE8: oraclePriceUsdE8.toString(),
              confidenceUsdE8: oracleConfidenceUsdE8.toString(),
              observedAt: Number(oraclePublishTime),
            }
          : {
              kind: "hedera-exchange-rate",
              systemContract: "0x0000000000000000000000000000000000000168",
              systemFile: "0.0.112",
              purpose: "HBAR cash-leg settlement conversion only",
              priceUsdE8: oraclePriceUsdE8.toString(),
              confidenceUsdE8: oracleConfidenceUsdE8.toString(),
              observedAt: Number(oraclePublishTime),
              caveat:
                "HIP-475 exposes the active network settlement conversion rate, not a live market price oracle.",
            },
      pyth:
        oracleKind === "pyth"
          ? {
              feedId: HBAR_USD_PRICE_ID,
              purpose: "HBAR cash-leg conversion only",
              priceUsdE8: oraclePriceUsdE8.toString(),
              confidenceUsdE8: oracleConfidenceUsdE8.toString(),
              publishTime: Number(oraclePublishTime),
            }
          : null,
      ats: {
        internalKyc,
        issuer,
        kyc: { lender: Number(lenderKyc), borrower: Number(borrowerKyc) },
        roles: { issuer: issuerRole, kyc: kycRole, ssiManager: ssiRole },
        assetMaturity: assetMaturity.toString(),
        clearingActive,
        tokenDecimals: Number(tokenDecimals),
        nominalValue: nominalValue.toString(),
        nominalValueDecimals: Number(nominalValueDecimals),
        nominalValueCurrency,
        balances: {
          borrower: {
            free: borrowerFree.toString(),
            held: borrowerHeld.toString(),
          },
          lender: { free: lenderFree.toString(), held: lenderHeld.toString() },
        },
      },
      positions: finalPositions.map((position, index) => ({
        id: positions[index].id,
        lender: position.lender,
        borrower: position.borrower,
        collateralAmount: position.collateralAmount.toString(),
        holdId: position.holdId.toString(),
        principalTinybar: position.principalTinybar.toString(),
        repaymentTinybar: position.repaymentTinybar.toString(),
        openedAt: Number(position.openedAt),
        maturity: Number(position.maturity),
        scheduleAddress: position.scheduleAddress,
        state: positionStateName(position.state),
        automation: automationStateName(position.automation),
        terminalPath: index === 0 ? "repayment" : defaultPath,
      })),
      holds,
      schedules,
      accounting: {
        cashLiabilitiesTinybar: cashLiabilities.toString(),
        reservedAutomationTinybar: reservedAutomation.toString(),
        requiredBackingTinybar: requiredBacking.toString(),
        contractBalanceTinybar: balanceProof.balanceTinybar,
      },
      verification: {
        complete: true,
        state: stateProof,
        balance: balanceProof,
        mirrorOrigin: mirrorUrl,
        contractLinks: Object.fromEntries(
          Object.entries({ atsToken, oracle, rail, acceptance }).map(
            ([name, address]) => [name, hashScanContract(address)],
          ),
        ),
        contractMirrorLinks: Object.fromEntries(
          Object.entries({ atsToken, oracle, rail, acceptance }).map(
            ([name, address]) => [name, mirrorContract(address)],
          ),
        ),
        linkAudit: {
          checkedAt: null,
          hashScanStatus: "unchecked",
          mirrorStatus: "verified",
          hashScanChecked: 0,
          mirrorChecked: verifiedTransactions.length + schedules.length + 5,
          finding: null,
        },
      },
      metrics: {
        startedAt,
        completedAt,
        elapsedMilliseconds: completedAtMilliseconds - startedAtMilliseconds,
        mirrorConfirmedTransactions: verifiedTransactions.length,
      },
      notice:
        "Verified public Hedera testnet evidence. The record contains no signer material or raw transaction payloads.",
    };
    validateEvidenceRecord(record);
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`Verified evidence written to ${outputPath}.`);
  } finally {
    for (const actor of actors.reverse()) {
      sweepResults.push(
        await sweepTemporaryActor({
          sdk: await import("@hiero-ledger/sdk"),
          client: sdkClient,
          actor,
          destinationId: signer.accountId,
        }),
      );
    }
    sdkClient.close();
    for (const result of sweepResults) {
      console.log(
        result.swept
          ? `Swept temporary account ${result.accountId}.`
          : `Best-effort sweep failed for ${result.accountId}.`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
