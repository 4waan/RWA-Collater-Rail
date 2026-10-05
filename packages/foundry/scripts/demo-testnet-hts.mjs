import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenFreezeTransaction,
  TokenGrantKycTransaction,
  TokenId,
  TokenPauseTransaction,
  TokenRevokeKycTransaction,
  TokenType,
  TokenUnfreezeTransaction,
  TokenUnpauseTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  atsAbi,
  htsRailAbi,
  htsTokenAbi,
  pythAbi,
  usdOracleAbi,
} from "@collateral-rail/shared/abis";
import {
  CIRCLE_TESTNET_USDC_ADDRESS,
  CIRCLE_TESTNET_USDC_TOKEN_ID,
  DEFAULT_PARTITION,
  USDC_USD_PRICE_ID,
  WEIBAR_PER_TINYBAR,
  tinybarToWeibar,
  weibarToTinybar,
} from "@collateral-rail/shared/hedera";
import {
  MIN_EXECUTION_RESERVE_HBAR,
  TINYBAR_PER_HBAR,
  assertDependencyBytecode,
  assertFundingBudget,
  assertHssCapacity,
  categorizeBootstrapTransactions,
  confirmMirrorAccountIdentity,
  createTemporaryActor,
  fetchAllowedJson,
  parseHermesUpdate,
  proofForSemanticKind,
  readCurrentMirrorBalance,
  sweepTemporaryActor,
} from "./lib/evidence-lib.mjs";
import { readHtsDemoConfiguration } from "./lib/hts-demo-config.ts";
import {
  HTS_ACTOR_TOKEN_UNITS,
  HTS_GAS,
  HTS_PRINCIPAL_TOKEN_UNITS,
  assertCircleUsdcPreflight,
  assertWritableHtsArtifactPath,
  bestEffortSweepTokenBalance,
  htsAddressesPath,
  htsBroadcastPath,
  htsFoundryEnvironment,
  htsOfferFundedArgs,
  htsOutputPath,
  htsPositionOpenedArgs,
  runHtsFoundry,
  writeHtsEvidenceCandidateAtomic,
} from "./lib/hts-demo-runtime.ts";
import {
  ACTOR_FUNDING_HBAR,
  ANNUAL_RATE_BPS,
  COLLATERAL_PER_POSITION,
  ROLE_ISSUER,
  ROLE_KYC,
  ROLE_SSI_MANAGER,
  TERM_SECONDS,
  ZERO_ADDRESS,
  assertRequiredEvidenceTools,
  automationStateName,
  blockAfterScheduleExecution,
  chain,
  confirmScheduleWithRetry,
  positionStateName,
  requireAddress,
  waitUntil,
} from "./lib/demo-runtime.ts";
import {
  HtsEvidenceJournal,
  waitForEvmProof,
  waitForNativeProof,
} from "./lib/hts-proof-runtime.mjs";
import {
  htsEvidenceConstants,
  validateHtsEvidenceRecord,
} from "./lib/hts-evidence-lib.mjs";

const CONTROLLED_INITIAL_SUPPLY = 1_000_000_000;

async function main() {
  const startedAtMilliseconds = Date.now();
  const startedAt = new Date(startedAtMilliseconds).toISOString();
  const {
    profile,
    recipe,
    signer,
    rpcUrl,
    mirrorUrl,
    hermesUrl,
    pythApiKey,
    factory,
    resolver,
    pyth,
  } = readHtsDemoConfiguration();
  const outputPath = htsOutputPath(profile);
  await assertWritableHtsArtifactPath(outputPath, profile);
  await assertRequiredEvidenceTools();

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

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });
  await assertDependencyBytecode({
    publicClient,
    dependencies:
      profile === "usdc" ? { factory, resolver, pyth } : { factory, resolver },
  });
  await assertHssCapacity({
    publicClient,
    startSecond: Math.floor(Date.now() / 1_000) + Number(TERM_SECONDS) + 2,
    gasLimit: 750_000,
  });

  async function feeFields() {
    const gasPrice = await publicClient.getGasPrice();
    if (
      gasPrice < WEIBAR_PER_TINYBAR ||
      gasPrice > 500n * WEIBAR_PER_TINYBAR ||
      gasPrice % WEIBAR_PER_TINYBAR !== 0n
    ) {
      throw new Error("Hedera RPC returned an unsafe gas price.");
    }
    return { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: 0n };
  }

  async function fetchPythUpdate() {
    if (!pythApiKey) throw new Error("Circle USDC requires PYTH_API_KEY.");
    const payload = await fetchAllowedJson(
      `${hermesUrl}/v2/updates/price/latest?ids%5B%5D=${USDC_USD_PRICE_ID.slice(2)}&encoding=hex`,
      new URL(hermesUrl).origin,
      fetch,
      { Authorization: `Bearer ${pythApiKey}` },
    );
    const updateData = parseHermesUpdate(payload);
    const updateFeeTinybar = await publicClient.readContract({
      address: pyth,
      abi: pythAbi,
      functionName: "getUpdateFee",
      args: [updateData],
    });
    return { updateData, updateFeeTinybar };
  }

  if (profile === "usdc") await fetchPythUpdate();
  await feeFields();

  const sdkClient = Client.forTestnet().setOperator(
    AccountId.fromString(signer.accountId),
    operatorKey,
  );
  const journal = new HtsEvidenceJournal();
  const actors = [];
  const sweepResults = [];
  const tokenSweepResults = [];
  const tokenTransfers = [];
  let settlementTokenId = null;
  let settlementTokenAddress = null;

  async function nativeSuccess(kind, response) {
    const confirmed = await waitForNativeProof({
      response,
      client: sdkClient,
      kind,
      mirrorOrigin: mirrorUrl,
    });
    journal.add(confirmed.proof);
    return confirmed;
  }

  async function evmWrite(kind, write, expectSuccess = true) {
    const hash = await write();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if ((receipt.status === "success") !== expectSuccess) {
      throw new Error(`${kind} receipt had an unexpected status.`);
    }
    const confirmed = await waitForEvmProof({
      hash,
      kind,
      mirrorOrigin: mirrorUrl,
      expectSuccess,
    });
    journal.add(confirmed.proof);
    return { ...confirmed, hash, receipt };
  }

  function addTransfer(proof, tokenId, from, to, amount) {
    tokenTransfers.push({
      type: "token-transfer",
      transaction: proof,
      tokenId,
      from,
      to,
      amount: amount.toString(),
      mirror: proof.mirror,
    });
  }

  async function associateActor(actor, tokenId, kind) {
    const frozen = await new TokenAssociateTransaction()
      .setAccountId(actor.accountId)
      .setTokenIds([tokenId])
      .setMaxTransactionFee(new Hbar(5))
      .freezeWith(sdkClient);
    const signed = await frozen.sign(actor.privateKey);
    return nativeSuccess(kind, await signed.execute(sdkClient));
  }

  async function grantKyc(tokenId, accountId, kind) {
    return nativeSuccess(
      kind,
      await new TokenGrantKycTransaction()
        .setTokenId(tokenId)
        .setAccountId(accountId)
        .setMaxTransactionFee(new Hbar(5))
        .execute(sdkClient),
    );
  }

  async function transferFromOperator(tokenId, actor, amount, kind) {
    const confirmed = await nativeSuccess(
      kind,
      await new TransferTransaction()
        .addTokenTransfer(tokenId, signer.accountId, -Number(amount))
        .addTokenTransfer(tokenId, actor.accountId, Number(amount))
        .setMaxTransactionFee(new Hbar(5))
        .execute(sdkClient),
    );
    addTransfer(
      confirmed.proof,
      tokenId.toString(),
      signer.evmAddress,
      actor.evmAddress,
      amount,
    );
    return confirmed;
  }

  async function sweepToken(tokenId, actor, amount) {
    if (amount === 0n) return null;
    const frozen = await new TransferTransaction()
      .addTokenTransfer(tokenId, actor.accountId, -Number(amount))
      .addTokenTransfer(tokenId, signer.accountId, Number(amount))
      .setMaxTransactionFee(new Hbar(5))
      .freezeWith(sdkClient);
    const signed = await frozen.sign(actor.privateKey);
    const confirmed = await nativeSuccess(
      `sweep-${actor.label}-tokens`,
      await signed.execute(sdkClient),
    );
    addTransfer(
      confirmed.proof,
      tokenId.toString(),
      actor.evmAddress,
      signer.evmAddress,
      amount,
    );
    return confirmed;
  }

  try {
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

    let settlementTokenCreation = null;
    if (profile === "controlled") {
      const creation = await nativeSuccess(
        "settlement-token-creation",
        await new TokenCreateTransaction()
          .setTokenName("Collateral Rail Controlled Test Dollar")
          .setTokenSymbol("CRTD")
          .setTokenType(TokenType.FungibleCommon)
          .setDecimals(6)
          .setInitialSupply(CONTROLLED_INITIAL_SUPPLY)
          .setTreasuryAccountId(signer.accountId)
          .setKycKey(operatorKey.publicKey)
          .setFreezeKey(operatorKey.publicKey)
          .setPauseKey(operatorKey.publicKey)
          .setFreezeDefault(false)
          .setMaxTransactionFee(new Hbar(20))
          .execute(sdkClient),
      );
      settlementTokenId = creation.receipt.tokenId;
      if (!settlementTokenId) throw new Error("Token creation returned no ID.");
      settlementTokenAddress = requireAddress(
        "controlled settlement token",
        `0x${settlementTokenId.toEvmAddress()}`,
      );
      settlementTokenCreation = creation.proof;
    } else {
      settlementTokenId = TokenId.fromString(CIRCLE_TESTNET_USDC_TOKEN_ID);
      settlementTokenAddress = CIRCLE_TESTNET_USDC_ADDRESS;
      const metadata = await fetchAllowedJson(
        new URL(`/api/v1/tokens/${CIRCLE_TESTNET_USDC_TOKEN_ID}`, mirrorUrl),
        new URL(mirrorUrl).origin,
      );
      const operatorRelationship = await fetchAllowedJson(
        new URL(
          `/api/v1/accounts/${signer.accountId}/tokens?token.id=${CIRCLE_TESTNET_USDC_TOKEN_ID}`,
          mirrorUrl,
        ),
        new URL(mirrorUrl).origin,
      );
      assertCircleUsdcPreflight(metadata, operatorRelationship);
    }

    await runHtsFoundry(
      htsFoundryEnvironment(process.env, {
        HARNESS_SIGNER_ACCOUNT_ID: signer.accountId,
        HARNESS_SIGNER_EVM_ADDRESS: signer.evmAddress,
        HARNESS_SIGNER_PRIVATE_KEY: signer.privateKey,
        HEDERA_NETWORK: "testnet",
        HEDERA_TESTNET_RPC_URL: rpcUrl,
        HEDERA_MIRROR_URL: mirrorUrl,
        ATS_FACTORY_ADDRESS: factory,
        ATS_RESOLVER_ADDRESS: resolver,
        PYTH_ADDRESS: pyth,
        SETTLEMENT_TOKEN_ADDRESS: settlementTokenAddress,
        USE_FIXED_TEST_ORACLE: profile === "controlled" ? "1" : "0",
        HEDERA_OPERATOR_ADDRESS: signer.evmAddress,
        LENDER_ADDRESS: lenderAddress,
        BORROWER_ADDRESS: borrowerAddress,
        RAIL_MAXIMUM_ADVANCE_BPS: String(recipe.policy.maximumAdvanceBps),
        RAIL_MAXIMUM_ANNUAL_RATE_BPS: String(
          recipe.policy.maximumAnnualRateBps,
        ),
        RAIL_MAXIMUM_QUOTE_MOVEMENT_BPS: String(
          recipe.policy.maximumQuoteMovementBps,
        ),
        RAIL_MINIMUM_TERM_SECONDS: String(recipe.policy.minimumTermSeconds),
        RAIL_MAXIMUM_TERM_SECONDS: String(recipe.policy.maximumTermSeconds),
        RAIL_MAXIMUM_OFFER_LIFETIME_SECONDS: String(
          recipe.policy.maximumOfferLifetimeSeconds,
        ),
      }),
    );

    const addresses = JSON.parse(await readFile(htsAddressesPath, "utf8"));
    const broadcast = JSON.parse(await readFile(htsBroadcastPath, "utf8"));
    const atsToken = requireAddress("ATS token", addresses.atsToken);
    const oracle = requireAddress("USD oracle", addresses.oracle);
    const rail = requireAddress("HTS rail", addresses.rail);
    const acceptance = requireAddress("HTS acceptance", addresses.acceptance);
    const deploymentProofs = [];
    for (const transaction of categorizeBootstrapTransactions(
      broadcast.transactions ?? [],
      { requireAutomationFunding: false },
    )) {
      const confirmed = await waitForEvmProof({
        hash: transaction.hash,
        kind: transaction.kind,
        mirrorOrigin: mirrorUrl,
        expectSuccess: true,
      });
      journal.add(confirmed.proof);
      deploymentProofs.push(confirmed.proof);
    }

    const railContract = await fetchAllowedJson(
      new URL(`/api/v1/contracts/${rail}`, mirrorUrl),
      new URL(mirrorUrl).origin,
    );
    if (!/^0\.0\.[1-9][0-9]*$/.test(railContract.contract_id ?? "")) {
      throw new Error(
        "Mirror returned no canonical account ID for the HTS rail.",
      );
    }
    const railAccountId = railContract.contract_id;

    const operatorWallet = createWalletClient({
      account: privateKeyToAccount(signer.privateKey),
      chain,
      transport: http(rpcUrl),
    });
    const lenderWallet = createWalletClient({
      account: privateKeyToAccount(lender.privateKeyHex),
      chain,
      transport: http(rpcUrl),
    });
    const borrowerWallet = createWalletClient({
      account: privateKeyToAccount(borrower.privateKeyHex),
      chain,
      transport: http(rpcUrl),
    });

    const initialized = await evmWrite("settlement-initialization", async () =>
      operatorWallet.writeContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "initializeSettlement",
        gas: HTS_GAS.initialize,
        ...(await feeFields()),
      }),
    );

    const automationFunding = await evmWrite("automation-funding", async () =>
      operatorWallet.writeContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "fundAutomation",
        value: 2n * 500_000_000n * WEIBAR_PER_TINYBAR,
        gas: HTS_GAS.automationFunding,
        ...(await feeFields()),
      }),
    );

    let initialPythUpdate = null;
    if (profile === "usdc") {
      const pythUpdate = await fetchPythUpdate();
      initialPythUpdate = await evmWrite("pyth-price-update", async () =>
        operatorWallet.writeContract({
          address: oracle,
          abi: usdOracleAbi,
          functionName: "updatePrice",
          args: [pythUpdate.updateData],
          value: tinybarToWeibar(pythUpdate.updateFeeTinybar),
          gas: HTS_GAS.oracleUpdate,
          ...(await feeFields()),
        }),
      );
    }

    const baseTerms = {
      borrower: borrowerAddress,
      collateralAmount: COLLATERAL_PER_POSITION,
      principalTokenUnits: HTS_PRINCIPAL_TOKEN_UNITS,
      annualRateBps: ANNUAL_RATE_BPS,
      termSeconds: TERM_SECONDS,
      offerExpiresAt: BigInt(Math.floor(Date.now() / 1_000) + 900),
    };
    const associationReject = await evmWrite(
      "probe-association",
      async () =>
        lenderWallet.writeContract({
          address: rail,
          abi: htsRailAbi,
          functionName: "fundOffer",
          args: [baseTerms],
          gas: HTS_GAS.fundOffer,
          ...(await feeFields()),
        }),
      false,
    );
    const lenderAssociation = await associateActor(
      lender,
      settlementTokenId,
      "associate-lender",
    );
    const borrowerAssociation = await associateActor(
      borrower,
      settlementTokenId,
      "associate-borrower",
    );

    const complianceProbes = [
      {
        kind: "association",
        expectedFailure: "Settlement account is not associated",
        rejectedTransaction: associationReject.proof,
        recoveryTransaction: lenderAssociation.proof,
        verified: true,
      },
    ];
    const actorProvisioning = [
      lenderAssociation.proof,
      borrowerAssociation.proof,
    ];

    if (profile === "controlled") {
      const initialLenderKyc = await grantKyc(
        settlementTokenId,
        lender.accountId,
        "grant-settlement-kyc-lender-initial",
      );
      const borrowerKyc = await grantKyc(
        settlementTokenId,
        borrower.accountId,
        "grant-settlement-kyc-borrower",
      );
      const railKyc = await grantKyc(
        settlementTokenId,
        railAccountId,
        "grant-settlement-kyc-rail",
      );
      const lenderKycRevocation = await nativeSuccess(
        "revoke-settlement-kyc-lender",
        await new TokenRevokeKycTransaction()
          .setTokenId(settlementTokenId)
          .setAccountId(lender.accountId)
          .setMaxTransactionFee(new Hbar(5))
          .execute(sdkClient),
      );
      actorProvisioning.push(
        initialLenderKyc.proof,
        borrowerKyc.proof,
        railKyc.proof,
        lenderKycRevocation.proof,
      );
      const kycReject = await evmWrite(
        "probe-kyc-revoked",
        async () =>
          lenderWallet.writeContract({
            address: rail,
            abi: htsRailAbi,
            functionName: "fundOffer",
            args: [baseTerms],
            gas: HTS_GAS.fundOffer,
            ...(await feeFields()),
          }),
        false,
      );
      const lenderKycRecovery = await grantKyc(
        settlementTokenId,
        lender.accountId,
        "regrant-settlement-kyc-lender",
      );
      actorProvisioning.push(lenderKycRecovery.proof);
      complianceProbes.push({
        kind: "kyc-revoked",
        expectedFailure: "Settlement KYC was revoked",
        rejectedTransaction: kycReject.proof,
        recoveryTransaction: lenderKycRecovery.proof,
        verified: true,
      });
    }

    const lenderProvision = await transferFromOperator(
      settlementTokenId,
      lender,
      HTS_ACTOR_TOKEN_UNITS,
      "provision-lender-token",
    );
    const borrowerProvision = await transferFromOperator(
      settlementTokenId,
      borrower,
      HTS_ACTOR_TOKEN_UNITS,
      "provision-borrower-token",
    );
    actorProvisioning.push(lenderProvision.proof, borrowerProvision.proof);

    if (profile === "controlled") {
      const freeze = await nativeSuccess(
        "freeze-lender",
        await new TokenFreezeTransaction()
          .setTokenId(settlementTokenId)
          .setAccountId(lender.accountId)
          .setMaxTransactionFee(new Hbar(5))
          .execute(sdkClient),
      );
      const frozenReject = await evmWrite(
        "probe-account-frozen",
        async () =>
          lenderWallet.writeContract({
            address: rail,
            abi: htsRailAbi,
            functionName: "fundOffer",
            args: [baseTerms],
            gas: HTS_GAS.fundOffer,
            ...(await feeFields()),
          }),
        false,
      );
      const unfreeze = await nativeSuccess(
        "unfreeze-lender",
        await new TokenUnfreezeTransaction()
          .setTokenId(settlementTokenId)
          .setAccountId(lender.accountId)
          .setMaxTransactionFee(new Hbar(5))
          .execute(sdkClient),
      );
      actorProvisioning.push(freeze.proof, unfreeze.proof);
      complianceProbes.push({
        kind: "account-frozen",
        expectedFailure: "Settlement account is frozen",
        rejectedTransaction: frozenReject.proof,
        recoveryTransaction: unfreeze.proof,
        verified: true,
      });

      const pause = await nativeSuccess(
        "pause-settlement-token",
        await new TokenPauseTransaction()
          .setTokenId(settlementTokenId)
          .setMaxTransactionFee(new Hbar(5))
          .execute(sdkClient),
      );
      const pausedReject = await evmWrite(
        "probe-token-paused",
        async () =>
          lenderWallet.writeContract({
            address: rail,
            abi: htsRailAbi,
            functionName: "fundOffer",
            args: [baseTerms],
            gas: HTS_GAS.fundOffer,
            ...(await feeFields()),
          }),
        false,
      );
      const unpause = await nativeSuccess(
        "unpause-settlement-token",
        await new TokenUnpauseTransaction()
          .setTokenId(settlementTokenId)
          .setMaxTransactionFee(new Hbar(5))
          .execute(sdkClient),
      );
      actorProvisioning.push(pause.proof, unpause.proof);
      complianceProbes.push({
        kind: "token-paused",
        expectedFailure: "Settlement token is paused",
        rejectedTransaction: pausedReject.proof,
        recoveryTransaction: unpause.proof,
        verified: true,
      });
    }

    const allowanceReject = await evmWrite(
      "probe-insufficient-allowance",
      async () =>
        lenderWallet.writeContract({
          address: rail,
          abi: htsRailAbi,
          functionName: "fundOffer",
          args: [baseTerms],
          gas: HTS_GAS.fundOffer,
          ...(await feeFields()),
        }),
      false,
    );
    const allowanceRecovery = await evmWrite("approve-lender-token", async () =>
      lenderWallet.writeContract({
        address: settlementTokenAddress,
        abi: htsTokenAbi,
        functionName: "approve",
        args: [rail, HTS_PRINCIPAL_TOKEN_UNITS * 2n],
        gas: HTS_GAS.tokenApproval,
        ...(await feeFields()),
      }),
    );
    complianceProbes.push({
      kind: "insufficient-allowance",
      expectedFailure: "Settlement allowance is below principal",
      rejectedTransaction: allowanceReject.proof,
      recoveryTransaction: allowanceRecovery.proof,
      verified: true,
    });

    await evmWrite("ats-allowance", async () =>
      borrowerWallet.writeContract({
        address: atsToken,
        abi: atsAbi,
        functionName: "approve",
        args: [rail, COLLATERAL_PER_POSITION * 2n],
        gas: HTS_GAS.atsApproval,
        ...(await feeFields()),
      }),
    );
    if (profile === "usdc") {
      const refresh = await fetchPythUpdate();
      await evmWrite("pyth-price-pre-funding", async () =>
        operatorWallet.writeContract({
          address: oracle,
          abi: usdOracleAbi,
          functionName: "updatePrice",
          args: [refresh.updateData],
          value: tinybarToWeibar(refresh.updateFeeTinybar),
          gas: HTS_GAS.oracleUpdate,
          ...(await feeFields()),
        }),
      );
    }

    const positions = [];
    const holds = [];
    const schedules = [];
    const fundTransactions = [];
    const acceptTransactions = [];
    for (let sequence = 0; sequence < 2; sequence += 1) {
      const terms = {
        ...baseTerms,
        offerExpiresAt: BigInt(Math.floor(Date.now() / 1_000) + 900),
      };
      const funded = await evmWrite(`fund-offer-${sequence + 1}`, async () =>
        lenderWallet.writeContract({
          address: rail,
          abi: htsRailAbi,
          functionName: "fundOffer",
          args: [terms],
          gas: HTS_GAS.fundOffer,
          ...(await feeFields()),
        }),
      );
      fundTransactions.push(funded);
      addTransfer(
        funded.proof,
        settlementTokenId.toString(),
        lenderAddress,
        rail,
        HTS_PRINCIPAL_TOKEN_UNITS,
      );
      const offerId = htsOfferFundedArgs(funded.receipt).offerId;
      const accepted = await evmWrite(
        `accept-offer-${sequence + 1}`,
        async () =>
          borrowerWallet.writeContract({
            address: rail,
            abi: htsRailAbi,
            functionName: "acceptOffer",
            args: [offerId],
            gas: HTS_GAS.acceptOffer,
            ...(await feeFields()),
          }),
      );
      acceptTransactions.push(accepted);
      const positionId = htsPositionOpenedArgs(accepted.receipt).positionId;
      const position = await publicClient.readContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "getPosition",
        args: [positionId],
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
      const expectedData = encodeAbiParameters(
        [{ type: "bytes32" }],
        [positionId],
      );
      if (
        hold[0] !== COLLATERAL_PER_POSITION ||
        hold[1] <= position.maturity ||
        hold[2].toLowerCase() !== rail.toLowerCase() ||
        hold[3].toLowerCase() !== ZERO_ADDRESS ||
        hold[4].toLowerCase() !== expectedData.toLowerCase() ||
        hold[5] !== "0x"
      ) {
        throw new Error(
          "ATS hold inspection did not match HTS facility terms.",
        );
      }
      holds.push({
        positionId,
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
        state: {
          type: "state",
          blockNumber: accepted.receipt.blockNumber.toString(),
          rpcOrigin: new URL(rpcUrl).origin,
          assertions: {
            "hold.positionId": positionId,
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
        },
      });
      if (position.scheduleAddress !== ZERO_ADDRESS) {
        schedules.push(
          await confirmScheduleWithRetry({
            mirrorOrigin: mirrorUrl,
            scheduleAddress: position.scheduleAddress,
          }),
        );
      }
      positions.push({ id: positionId, opened: position });
    }
    if (schedules.length !== 2) {
      throw new Error("Both HTS positions must receive an HSS schedule.");
    }

    const borrowerWithdrawal = await evmWrite("borrower-withdrawal", async () =>
      borrowerWallet.writeContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "withdraw",
        gas: HTS_GAS.withdrawal,
        ...(await feeFields()),
      }),
    );
    addTransfer(
      borrowerWithdrawal.proof,
      settlementTokenId.toString(),
      rail,
      borrowerAddress,
      HTS_PRINCIPAL_TOKEN_UNITS * 2n,
    );
    const repaymentAmount = positions[0].opened.repaymentTokenUnits;
    await evmWrite("approve-borrower-repayment", async () =>
      borrowerWallet.writeContract({
        address: settlementTokenAddress,
        abi: htsTokenAbi,
        functionName: "approve",
        args: [rail, repaymentAmount],
        gas: HTS_GAS.tokenApproval,
        ...(await feeFields()),
      }),
    );
    const repaid = await evmWrite("repay-position", async () =>
      borrowerWallet.writeContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "repay",
        args: [positions[0].id],
        gas: HTS_GAS.repayment,
        ...(await feeFields()),
      }),
    );
    addTransfer(
      repaid.proof,
      settlementTokenId.toString(),
      borrowerAddress,
      rail,
      repaymentAmount,
    );
    const lenderWithdrawal = await evmWrite("lender-withdrawal", async () =>
      lenderWallet.writeContract({
        address: rail,
        abi: htsRailAbi,
        functionName: "withdraw",
        gas: HTS_GAS.withdrawal,
        ...(await feeFields()),
      }),
    );
    addTransfer(
      lenderWithdrawal.proof,
      settlementTokenId.toString(),
      rail,
      lenderAddress,
      repaymentAmount,
    );

    await waitUntil(Number(positions[1].opened.maturity) + 12);
    const terminalProof = await confirmScheduleWithRetry({
      mirrorOrigin: mirrorUrl,
      scheduleAddress: positions[1].opened.scheduleAddress,
      requireExecuted: true,
    });
    const executionBlock = await blockAfterScheduleExecution(
      publicClient,
      terminalProof.executedTimestamp,
    );
    const hssDefaultedPosition = await publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "getPosition",
      args: [positions[1].id],
      blockNumber: executionBlock,
    });
    if (
      Number(hssDefaultedPosition.state) !== 3 ||
      Number(hssDefaultedPosition.automation) !== 2
    ) {
      throw new Error(
        "The HTS evidence run requires an observed HSS default. Permissionless fallback remains covered by adversarial tests.",
      );
    }
    const terminalPath = "hss";

    for (let index = 0; index < schedules.length; index += 1) {
      schedules[index] = await confirmScheduleWithRetry({
        mirrorOrigin: mirrorUrl,
        scheduleAddress: schedules[index].address,
        requireExecuted: true,
      });
    }

    let finalPythUpdate = initialPythUpdate;
    if (profile === "usdc") {
      const refresh = await fetchPythUpdate();
      finalPythUpdate = await evmWrite("pyth-price-refresh", async () =>
        operatorWallet.writeContract({
          address: oracle,
          abi: usdOracleAbi,
          functionName: "updatePrice",
          args: [refresh.updateData],
          value: tinybarToWeibar(refresh.updateFeeTinybar),
          gas: HTS_GAS.oracleUpdate,
          ...(await feeFields()),
        }),
      );
    }
    const verificationBlock =
      finalPythUpdate?.receipt.blockNumber ??
      (await publicClient.getBlockNumber());
    const finalPositions = await Promise.all(
      positions.map((position) =>
        publicClient.readContract({
          address: rail,
          abi: htsRailAbi,
          functionName: "getPosition",
          args: [position.id],
          blockNumber: verificationBlock,
        }),
      ),
    );
    for (let index = 0; index < holds.length; index += 1) {
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
        throw new Error("A terminal HTS position retained a live ATS hold.");
      }
      holds[index].terminalState = {
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
      };
    }

    const final = await readFinalState({
      publicClient,
      atsToken,
      settlementToken: settlementTokenAddress,
      oracle,
      rail,
      issuer: signer.evmAddress,
      lender: lenderAddress,
      borrower: borrowerAddress,
      blockNumber: verificationBlock,
    });
    if (
      final.cashTokenLiabilities !== 0n ||
      final.tokenBalance !== 0n ||
      final.reservedAutomation !== 0n
    ) {
      throw new Error("Terminal HTS accounting did not return to zero.");
    }

    const lenderTokenBalance = await publicClient.readContract({
      address: settlementTokenAddress,
      abi: htsTokenAbi,
      functionName: "balanceOf",
      args: [lenderAddress],
    });
    const borrowerTokenBalance = await publicClient.readContract({
      address: settlementTokenAddress,
      abi: htsTokenAbi,
      functionName: "balanceOf",
      args: [borrowerAddress],
    });
    await sweepToken(settlementTokenId, lender, lenderTokenBalance);
    await sweepToken(settlementTokenId, borrower, borrowerTokenBalance);

    const hbarBalanceProof = await readCurrentMirrorBalance({
      mirrorOrigin: mirrorUrl,
      evmAddress: rail,
    });
    const tokenMetadata = await readTokenMetadata({
      mirrorUrl,
      tokenId: settlementTokenId.toString(),
      tokenAddress: settlementTokenAddress,
    });
    const settlementBalances = await Promise.all(
      [
        { accountId: lender.accountId, evmAddress: lenderAddress },
        { accountId: borrower.accountId, evmAddress: borrowerAddress },
        {
          accountId: hbarBalanceProof.accountId,
          evmAddress: rail,
        },
      ].map((identity) =>
        readTokenBalance({
          mirrorUrl,
          tokenId: settlementTokenId.toString(),
          identity,
        }),
      ),
    );

    const stateProof = {
      type: "state",
      blockNumber: verificationBlock.toString(),
      rpcOrigin: new URL(rpcUrl).origin,
      assertions: {
        "rail.settlementInitialized": final.settlementInitialized,
        "rail.settlementDecimals": final.settlementDecimals,
        "rail.cashTokenLiabilities": final.cashTokenLiabilities.toString(),
        "rail.settlementTokenBalance": final.tokenBalance.toString(),
        "rail.reservedAutomationTinybar": final.reservedAutomation.toString(),
        "rail.policy.maximumAdvanceBps": final.policy.maximumAdvanceBps,
        "rail.policy.maximumAnnualRateBps": final.policy.maximumAnnualRateBps,
        "rail.policy.maximumQuoteMovementBps":
          final.policy.maximumQuoteMovementBps,
        "rail.policy.minimumTermSeconds": final.policy.minimumTermSeconds,
        "rail.policy.maximumTermSeconds": final.policy.maximumTermSeconds,
        "rail.policy.maximumOfferLifetimeSeconds":
          final.policy.maximumOfferLifetimeSeconds,
        "positions.repaidState": positionStateName(finalPositions[0].state),
        "positions.defaultedState": positionStateName(finalPositions[1].state),
        "oracle.kind": profile === "controlled" ? "fixed-test" : "pyth",
        "oracle.priceUsdE8": final.oraclePrice[0].toString(),
        "oracle.confidenceUsdE8": final.oraclePrice[1].toString(),
        "oracle.observedAt": Number(final.oraclePrice[2]),
      },
    };
    const completedAtMilliseconds = Date.now();
    const completedAt = new Date(completedAtMilliseconds).toISOString();
    const transactions = journal.values();
    const sourceUrls = sourceLinks({
      factory,
      resolver,
      atsToken,
      settlementToken: settlementTokenAddress,
      settlementTokenId: settlementTokenId.toString(),
      oracle,
      rail,
      acceptance,
    });
    const record = {
      schemaVersion: 1,
      evidenceKind: "hts-settlement",
      settlementProfile:
        profile === "controlled" ? "controlled-test" : "circle-usdc",
      network: "hedera-testnet",
      chainId: 296,
      status: "verified",
      generatedAt: completedAt,
      recipeId: profile === "controlled" ? null : recipe.id,
      policy: final.policy,
      addresses: {
        factory,
        resolver,
        atsToken,
        settlementToken: settlementTokenAddress,
        oracle,
        rail,
        acceptance,
        pyth: profile === "usdc" ? pyth : null,
      },
      actors: {
        issuer: { accountId: signer.accountId, evmAddress: signer.evmAddress },
        lender: { accountId: lender.accountId, evmAddress: lenderAddress },
        borrower: {
          accountId: borrower.accountId,
          evmAddress: borrowerAddress,
        },
      },
      settlementToken: tokenMetadata,
      oracle:
        profile === "controlled"
          ? {
              kind: "fixed-test",
              priceUsdE8: final.oraclePrice[0].toString(),
              confidenceUsdE8: "0",
              observedAt: Number(final.oraclePrice[2]),
              purpose: "controlled mechanics only",
              limitation:
                "This fixed test value proves mechanics only and is not evidence of market value.",
            }
          : {
              kind: "pyth",
              feedId: USDC_USD_PRICE_ID,
              priceUsdE8: final.oraclePrice[0].toString(),
              confidenceUsdE8: final.oraclePrice[1].toString(),
              observedAt: Number(final.oraclePrice[2]),
              purpose: "Circle testnet USDC collateral-coverage valuation",
              updateTransaction: finalPythUpdate.proof,
            },
      transactions,
      tokenTransfers,
      lifecycle: {
        atsBondDeployment: proofForSemanticKind(
          deploymentProofs,
          "ats-bond-deployment",
        ),
        settlementTokenCreation,
        settlementInitialization: initialized.proof,
        automationFunding: automationFunding.proof,
        actorProvisioning,
        oracleUpdate: finalPythUpdate?.proof ?? null,
        fundedOffer: fundTransactions[0].proof,
        holdCreation: acceptTransactions[0].proof,
        repaidFacility: repaid.proof,
        maturedDefault: terminalProof,
        liveConfigurationRead: stateProof,
      },
      complianceProbes,
      ats: {
        internalKyc: final.internalKyc,
        issuer: final.issuerStatus,
        kyc: {
          lender: Number(final.lenderKyc),
          borrower: Number(final.borrowerKyc),
        },
        roles: {
          issuer: final.issuerRole,
          kyc: final.kycRole,
          ssiManager: final.ssiRole,
        },
        assetMaturity: final.assetMaturity.toString(),
        clearingActive: final.clearingActive,
        tokenDecimals: Number(final.atsDecimals),
        nominalValue: final.nominalValue.toString(),
        nominalValueDecimals: Number(final.nominalDecimals),
        nominalValueCurrency: final.nominalCurrency,
        balances: {
          borrower: {
            free: final.borrowerFree.toString(),
            held: final.borrowerHeld.toString(),
          },
          lender: {
            free: final.lenderFree.toString(),
            held: final.lenderHeld.toString(),
          },
        },
      },
      positions: finalPositions.map((position, index) => ({
        id: positions[index].id,
        lender: position.lender,
        borrower: position.borrower,
        collateralAmount: position.collateralAmount.toString(),
        holdId: position.holdId.toString(),
        principalTokenUnits: position.principalTokenUnits.toString(),
        repaymentTokenUnits: position.repaymentTokenUnits.toString(),
        openedAt: Number(position.openedAt),
        maturity: Number(position.maturity),
        scheduleAddress: position.scheduleAddress,
        state: positionStateName(position.state),
        automation: automationStateName(position.automation),
        terminalPath: index === 0 ? "repayment" : terminalPath,
      })),
      holds,
      schedules,
      accounting: {
        cashTokenLiabilities: final.cashTokenLiabilities.toString(),
        railTokenBalance: final.tokenBalance.toString(),
        reservedAutomationTinybar: final.reservedAutomation.toString(),
        railHbarBalanceTinybar: hbarBalanceProof.balanceTinybar,
      },
      verification: {
        complete: true,
        state: stateProof,
        settlementBalances,
        hbarBalance: hbarBalanceProof,
        mirrorOrigin: mirrorUrl,
        sourceUrls,
        linkAudit: {
          checkedAt: null,
          hashScanStatus: "unchecked",
          mirrorStatus: "verified",
          hashScanChecked: 0,
          mirrorChecked:
            transactions.length +
            schedules.length +
            7 +
            settlementBalances.length +
            1,
          finding: null,
        },
      },
      metrics: {
        startedAt,
        completedAt,
        elapsedMilliseconds: completedAtMilliseconds - startedAtMilliseconds,
        mirrorConfirmedTransactions: transactions.length,
      },
      limitations: [
        profile === "controlled"
          ? "The controlled settlement token and fixed oracle prove mechanics, not market value."
          : "Circle testnet USDC and Pyth demonstrate testnet market-valued mechanics only.",
        "HBAR balance is a current Mirror account proof, not an exact-block RPC assertion.",
      ],
      notice:
        "Observed on Hedera testnet. This evidence contains no signer material or raw transaction payloads.",
    };
    validateHtsEvidenceRecord(record);
    await writeHtsEvidenceCandidateAtomic(
      outputPath,
      profile,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    console.log(`Verified HTS evidence written to ${outputPath}.`);
  } finally {
    if (settlementTokenId && settlementTokenAddress) {
      for (const actor of actors) {
        tokenSweepResults.push(
          await bestEffortSweepTokenBalance({
            accountId: actor.accountId,
            readBalance: () =>
              publicClient.readContract({
                address: settlementTokenAddress,
                abi: htsTokenAbi,
                functionName: "balanceOf",
                args: [actor.evmAddress],
              }),
            sweep: (amount) => sweepToken(settlementTokenId, actor, amount),
          }),
        );
      }
    }
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
    for (const result of tokenSweepResults) {
      if (!result.swept) {
        console.log(`Best-effort token sweep failed for ${result.accountId}.`);
      } else if (result.amountTokenUnits !== "0") {
        console.log(
          `Swept ${result.amountTokenUnits} token units from ${result.accountId}.`,
        );
      }
    }
    for (const result of sweepResults) {
      console.log(
        result.swept
          ? `Swept temporary account ${result.accountId}.`
          : `Best-effort sweep failed for ${result.accountId}.`,
      );
    }
  }
}

async function readTokenMetadata({ mirrorUrl, tokenId, tokenAddress }) {
  const token = await fetchAllowedJson(
    new URL(`/api/v1/tokens/${tokenId}`, mirrorUrl),
    new URL(mirrorUrl).origin,
  );
  if (
    token.token_id !== tokenId ||
    token.type !== "FUNGIBLE_COMMON" ||
    !Array.isArray(token.custom_fees?.fixed_fees) ||
    !Array.isArray(token.custom_fees?.fractional_fees)
  ) {
    throw new Error("Mirror returned malformed settlement token metadata.");
  }
  return {
    tokenId,
    evmAddress: tokenAddress,
    name: token.name,
    symbol: token.symbol,
    decimals: Number(token.decimals),
    type: token.type,
    deleted: token.deleted,
    freezeDefault: token.freeze_default,
    pauseStatus: token.pause_status,
    kycKey: token.kyc_key !== null,
    freezeKey: token.freeze_key !== null,
    pauseKey: token.pause_key !== null,
    feeScheduleKey: token.fee_schedule_key !== null,
    fixedFeeCount: token.custom_fees.fixed_fees.length,
    fractionalFeeCount: token.custom_fees.fractional_fees.length,
    royaltyFeeCount: 0,
    mirror: `${mirrorUrl}/api/v1/tokens/${tokenId}`,
    verifiedAt: new Date().toISOString(),
  };
}

async function readTokenBalance({ mirrorUrl, tokenId, identity }) {
  const payload = await fetchAllowedJson(
    new URL(
      `/api/v1/accounts/${identity.accountId}/tokens?token.id=${tokenId}`,
      mirrorUrl,
    ),
    new URL(mirrorUrl).origin,
  );
  if (!Array.isArray(payload.tokens) || payload.tokens.length !== 1) {
    throw new Error(`Mirror omitted token relationship ${identity.accountId}.`);
  }
  const relationship = payload.tokens[0];
  return {
    type: "token-balance",
    basis: "current-mirror-token-relationship",
    tokenId,
    accountId: identity.accountId,
    evmAddress: identity.evmAddress,
    associated: true,
    kycStatus: relationship.kyc_status,
    freezeStatus: relationship.freeze_status,
    balanceTokenUnits: String(relationship.balance),
    checkedAt: new Date().toISOString(),
    mirror: `${mirrorUrl}/api/v1/accounts/${identity.accountId}/tokens?token.id=${tokenId}`,
  };
}

function sourceLinks({
  factory,
  resolver,
  atsToken,
  settlementToken,
  settlementTokenId,
  oracle,
  rail,
  acceptance,
}) {
  const mirror = htsEvidenceConstants.MIRROR_ORIGIN;
  const hashScan = "https://hashscan.io";
  return {
    factoryHashScan: `${hashScan}/testnet/contract/${factory}`,
    factoryMirror: `${mirror}/api/v1/contracts/${factory}`,
    resolverHashScan: `${hashScan}/testnet/contract/${resolver}`,
    resolverMirror: `${mirror}/api/v1/contracts/${resolver}`,
    atsTokenHashScan: `${hashScan}/testnet/contract/${atsToken}`,
    atsTokenMirror: `${mirror}/api/v1/contracts/${atsToken}`,
    settlementTokenHashScan: `${hashScan}/testnet/token/${settlementTokenId}`,
    settlementTokenMirror: `${mirror}/api/v1/tokens/${settlementTokenId}`,
    oracleHashScan: `${hashScan}/testnet/contract/${oracle}`,
    oracleMirror: `${mirror}/api/v1/contracts/${oracle}`,
    railHashScan: `${hashScan}/testnet/contract/${rail}`,
    railMirror: `${mirror}/api/v1/contracts/${rail}`,
    acceptanceHashScan: `${hashScan}/testnet/contract/${acceptance}`,
    acceptanceMirror: `${mirror}/api/v1/contracts/${acceptance}`,
  };
}

async function readFinalState({
  publicClient,
  atsToken,
  settlementToken,
  oracle,
  rail,
  issuer,
  lender,
  borrower,
  blockNumber,
}) {
  const values = await Promise.all([
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isInternalKycActivated",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isIssuer",
      args: [issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getKycStatusFor",
      args: [borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getMaturityDate",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "isClearingActivated",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "decimals",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValue",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValueDecimals",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getNominalValueCurrency",
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_ISSUER, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_KYC, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "hasRole",
      args: [ROLE_SSI_MANAGER, issuer],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "balanceOfByPartition",
      args: [DEFAULT_PARTITION, borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getHeldAmountForByPartition",
      args: [DEFAULT_PARTITION, borrower],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "balanceOfByPartition",
      args: [DEFAULT_PARTITION, lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: atsToken,
      abi: atsAbi,
      functionName: "getHeldAmountForByPartition",
      args: [DEFAULT_PARTITION, lender],
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "settlementInitialized",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "settlementDecimals",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "cashTokenLiabilities",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "reservedAutomation",
      blockNumber,
    }),
    publicClient.readContract({
      address: rail,
      abi: htsRailAbi,
      functionName: "policy",
      blockNumber,
    }),
    publicClient.readContract({
      address: settlementToken,
      abi: htsTokenAbi,
      functionName: "balanceOf",
      args: [rail],
      blockNumber,
    }),
    publicClient.getBalance({ address: rail, blockNumber }),
    publicClient.readContract({
      address: oracle,
      abi: usdOracleAbi,
      functionName: "latestUsdPrice",
      blockNumber,
    }),
  ]);
  const policy = {
    maximumAdvanceBps: Number(values[21].maximumAdvanceBps),
    maximumAnnualRateBps: Number(values[21].maximumAnnualRateBps),
    maximumQuoteMovementBps: Number(values[21].maximumQuoteMovementBps),
    minimumTermSeconds: Number(values[21].minimumTermSeconds),
    maximumTermSeconds: Number(values[21].maximumTermSeconds),
    maximumOfferLifetimeSeconds: Number(values[21].maximumOfferLifetimeSeconds),
  };
  return {
    internalKyc: values[0],
    issuerStatus: values[1],
    lenderKyc: values[2],
    borrowerKyc: values[3],
    assetMaturity: values[4],
    clearingActive: values[5],
    atsDecimals: values[6],
    nominalValue: values[7],
    nominalDecimals: values[8],
    nominalCurrency: values[9],
    issuerRole: values[10],
    kycRole: values[11],
    ssiRole: values[12],
    borrowerFree: values[13],
    borrowerHeld: values[14],
    lenderFree: values[15],
    lenderHeld: values[16],
    settlementInitialized: values[17],
    settlementDecimals: Number(values[18]),
    cashTokenLiabilities: values[19],
    reservedAutomation: values[20],
    policy,
    tokenBalance: values[22],
    hbarBalanceTinybar: weibarToTinybar(values[23]),
    oraclePrice: values[24],
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
