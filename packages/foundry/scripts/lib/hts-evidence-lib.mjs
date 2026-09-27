import {
  hashScanContract,
  mirrorAccountBalance,
  mirrorContract,
  validateRailPolicyEvidence,
} from "./evidence-lib.mjs";

const CHAIN_ID = 296;
const MIRROR_ORIGIN = "https://testnet.mirrornode.hedera.com";
const HASHSCAN_ORIGIN = "https://hashscan.io";
const CIRCLE_USDC_ID = "0.0.429274";
const CIRCLE_USDC_ADDRESS = "0x0000000000000000000000000000000000068cda";
const USDC_USD_PRICE_ID =
  "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const NATIVE_HASH_RE = /^0x[a-fA-F0-9]{96}$/;
const ACCOUNT_ID_RE = /^0\.0\.\d+$/;
const TIMESTAMP_RE = /^\d+\.\d{1,9}$/;
const INTEGER_RE = /^(?:0|[1-9]\d*)$/;
const NATIVE_TRANSACTION_ID_RE = /^0\.0\.\d+@\d+\.\d{9}$/;
const BYTES_RE = /^0x(?:[a-fA-F0-9]{2})*$/;
const FORBIDDEN_KEYS = /private|mnemonic|secret|calldata|operatorKey/i;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const DEFAULT_PARTITION = `0x${"0".repeat(63)}1`;

function visit(value, path = "record") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new Error(`HTS evidence contains forbidden field ${path}.${key}.`);
    }
    visit(child, `${path}.${key}`);
  }
}

function transactionUrl(hash) {
  return `${MIRROR_ORIGIN}/api/v1/contracts/results/${hash}`;
}

function hashScanTransactionUrl(hash) {
  return `${HASHSCAN_ORIGIN}/testnet/transaction/${hash}`;
}

function nativeTransactionUrl(transactionId) {
  return `${MIRROR_ORIGIN}/api/v1/transactions/${encodeURIComponent(transactionId)}`;
}

function hashScanNativeTransactionUrl(transactionId) {
  return `${HASHSCAN_ORIGIN}/testnet/transaction/${transactionId}`;
}

function scheduleUrl(scheduleId) {
  return `${MIRROR_ORIGIN}/api/v1/schedules/${scheduleId}`;
}

function hashScanScheduleUrl(scheduleId) {
  return `${HASHSCAN_ORIGIN}/testnet/schedule/${scheduleId}`;
}

function scheduleIdFromAddress(address) {
  const raw = address.slice(2).toLowerCase();
  if (!/^0{24}[a-f0-9]{16}$/.test(raw)) return null;
  return `0.0.${BigInt(`0x${raw.slice(24)}`).toString()}`;
}

function validateTransaction(proof, requireSuccess = false) {
  if (
    proof?.type !== "transaction" ||
    typeof proof.kind !== "string" ||
    proof.kind.length === 0 ||
    !HASH_RE.test(proof.hash ?? "") ||
    !TIMESTAMP_RE.test(proof.consensusTimestamp ?? "") ||
    typeof proof.result !== "string" ||
    proof.result.length === 0 ||
    proof.mirror !== transactionUrl(proof.hash) ||
    proof.hashScan !== hashScanTransactionUrl(proof.hash) ||
    (requireSuccess && proof.result !== "SUCCESS")
  ) {
    throw new Error("HTS evidence contains an invalid transaction proof.");
  }
  return proof;
}

function validateNativeTransaction(proof, requireSuccess = false) {
  if (
    proof?.type !== "hedera-transaction" ||
    typeof proof.kind !== "string" ||
    proof.kind.length === 0 ||
    !NATIVE_TRANSACTION_ID_RE.test(proof.transactionId ?? "") ||
    !NATIVE_HASH_RE.test(proof.transactionHash ?? "") ||
    !TIMESTAMP_RE.test(proof.consensusTimestamp ?? "") ||
    typeof proof.result !== "string" ||
    proof.result.length === 0 ||
    proof.mirror !== nativeTransactionUrl(proof.transactionId) ||
    proof.hashScan !== hashScanNativeTransactionUrl(proof.transactionId) ||
    (requireSuccess && proof.result !== "SUCCESS")
  ) {
    throw new Error(
      "HTS evidence contains an invalid native transaction proof.",
    );
  }
  return proof;
}

function validateAnyTransaction(proof, requireSuccess = false) {
  return proof?.type === "transaction"
    ? validateTransaction(proof, requireSuccess)
    : validateNativeTransaction(proof, requireSuccess);
}

function transactionKey(proof) {
  return proof.type === "transaction"
    ? `evm:${proof.hash.toLowerCase()}`
    : `native:${proof.transactionId}`;
}

function validateSchedule(proof) {
  if (
    proof?.type !== "schedule" ||
    !ADDRESS_RE.test(proof.address ?? "") ||
    !ACCOUNT_ID_RE.test(proof.scheduleId ?? "") ||
    scheduleIdFromAddress(proof.address) !== proof.scheduleId ||
    (proof.executedTimestamp !== null &&
      !TIMESTAMP_RE.test(proof.executedTimestamp)) ||
    proof.mirror !== scheduleUrl(proof.scheduleId) ||
    proof.hashScan !== hashScanScheduleUrl(proof.scheduleId)
  ) {
    throw new Error("HTS evidence contains an invalid schedule proof.");
  }
  return proof;
}

function validateState(proof) {
  if (
    proof?.type !== "state" ||
    !/^[1-9]\d*$/.test(proof.blockNumber ?? "") ||
    proof.rpcOrigin !== "https://testnet.hashio.io" ||
    !proof.assertions ||
    typeof proof.assertions !== "object" ||
    Array.isArray(proof.assertions) ||
    Object.keys(proof.assertions).length === 0 ||
    Object.values(proof.assertions).some(
      (value) => !["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    throw new Error(
      "HTS evidence contains an invalid exact-block state proof.",
    );
  }
  return proof;
}

function requireUnsigned(value, label) {
  if (!INTEGER_RE.test(value ?? "")) {
    throw new Error(`${label} must be a canonical unsigned integer.`);
  }
  return BigInt(value);
}

function sameProof(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateTokenMetadata(token, profile) {
  if (
    !ACCOUNT_ID_RE.test(token?.tokenId ?? "") ||
    !ADDRESS_RE.test(token?.evmAddress ?? "") ||
    typeof token?.name !== "string" ||
    typeof token?.symbol !== "string" ||
    token?.type !== "FUNGIBLE_COMMON" ||
    !Number.isInteger(token?.decimals) ||
    token.decimals < 0 ||
    token.decimals > 18 ||
    token.deleted !== false ||
    typeof token.freezeDefault !== "boolean" ||
    typeof token.kycKey !== "boolean" ||
    typeof token.freezeKey !== "boolean" ||
    typeof token.pauseKey !== "boolean" ||
    typeof token.feeScheduleKey !== "boolean" ||
    !["PAUSED", "UNPAUSED", "NOT_APPLICABLE"].includes(token.pauseStatus) ||
    token.fixedFeeCount !== 0 ||
    token.fractionalFeeCount !== 0 ||
    token.royaltyFeeCount !== 0 ||
    token.mirror !== `${MIRROR_ORIGIN}/api/v1/tokens/${token.tokenId}` ||
    !Number.isFinite(Date.parse(token.verifiedAt ?? ""))
  ) {
    throw new Error("HTS evidence contains invalid settlement token metadata.");
  }
  if (
    profile === "circle-usdc" &&
    (token.tokenId !== CIRCLE_USDC_ID ||
      token.evmAddress.toLowerCase() !== CIRCLE_USDC_ADDRESS ||
      token.name !== "USD Coin" ||
      token.symbol !== "USDC" ||
      token.decimals !== 6)
  ) {
    throw new Error(
      "Circle evidence does not match the pinned testnet USDC token.",
    );
  }
  if (profile === "controlled-test" && token.decimals !== 6) {
    throw new Error("Controlled settlement evidence must use six decimals.");
  }
  if (
    profile === "controlled-test" &&
    (!token.kycKey ||
      !token.freezeKey ||
      !token.pauseKey ||
      token.feeScheduleKey)
  ) {
    throw new Error(
      "Controlled settlement evidence has the wrong compliance keys.",
    );
  }
  if (
    profile === "circle-usdc" &&
    (token.kycKey ||
      !token.freezeKey ||
      token.pauseKey ||
      token.feeScheduleKey ||
      token.freezeDefault)
  ) {
    throw new Error("Circle evidence has unexpected compliance controls.");
  }
}

function validateBalanceProof(proof) {
  if (
    proof?.type !== "token-balance" ||
    proof?.basis !== "current-mirror-token-relationship" ||
    !ACCOUNT_ID_RE.test(proof.tokenId ?? "") ||
    !ACCOUNT_ID_RE.test(proof.accountId ?? "") ||
    !ADDRESS_RE.test(proof.evmAddress ?? "") ||
    proof.associated !== true ||
    !["GRANTED", "REVOKED", "NOT_APPLICABLE"].includes(proof.kycStatus) ||
    !["FROZEN", "UNFROZEN", "NOT_APPLICABLE"].includes(proof.freezeStatus) ||
    !INTEGER_RE.test(proof.balanceTokenUnits ?? "") ||
    !Number.isFinite(Date.parse(proof.checkedAt ?? "")) ||
    proof.mirror !==
      `${MIRROR_ORIGIN}/api/v1/accounts/${proof.accountId}/tokens?token.id=${proof.tokenId}`
  ) {
    throw new Error(
      "HTS evidence contains an invalid current token balance proof.",
    );
  }
  if (proof.kycStatus === "REVOKED" || proof.freezeStatus === "FROZEN") {
    throw new Error(
      "HTS evidence records a non-ready settlement relationship.",
    );
  }
  return proof;
}

function validateHbarBalanceProof(proof, railAddress) {
  if (
    proof?.type !== "balance" ||
    proof?.basis !== "current-mirror-account" ||
    !ACCOUNT_ID_RE.test(proof.accountId ?? "") ||
    !ADDRESS_RE.test(proof.evmAddress ?? "") ||
    proof.evmAddress.toLowerCase() !== railAddress.toLowerCase() ||
    !INTEGER_RE.test(proof.balanceTinybar ?? "") ||
    !TIMESTAMP_RE.test(proof.balanceTimestamp ?? "") ||
    !Number.isFinite(Date.parse(proof.checkedAt ?? "")) ||
    proof.mirror !== mirrorAccountBalance(railAddress)
  ) {
    throw new Error(
      "HTS evidence contains an invalid current HBAR balance proof.",
    );
  }
  return proof;
}

function validateAtsEvidence(ats) {
  if (
    !ats ||
    ats.internalKyc !== true ||
    ats.issuer !== true ||
    ats.kyc?.lender !== 1 ||
    ats.kyc?.borrower !== 1 ||
    ats.roles?.issuer !== true ||
    ats.roles?.kyc !== true ||
    ats.roles?.ssiManager !== true ||
    !/^[1-9]\d*$/.test(ats.assetMaturity ?? "") ||
    ats.clearingActive !== false ||
    !Number.isSafeInteger(ats.tokenDecimals) ||
    ats.tokenDecimals < 0 ||
    ats.tokenDecimals > 18 ||
    !/^[1-9]\d*$/.test(ats.nominalValue ?? "") ||
    !Number.isSafeInteger(ats.nominalValueDecimals) ||
    ats.nominalValueDecimals < 0 ||
    ats.nominalValueDecimals > 18 ||
    typeof ats.nominalValueCurrency !== "string" ||
    !BYTES_RE.test(ats.nominalValueCurrency)
  ) {
    throw new Error("HTS evidence is missing final ATS compliance assertions.");
  }
  for (const party of ["borrower", "lender"]) {
    for (const field of ["free", "held"]) {
      requireUnsigned(ats.balances?.[party]?.[field], `ATS ${party} ${field}`);
    }
    if (ats.balances[party].held !== "0") {
      throw new Error("Terminal HTS evidence retains an ATS held balance.");
    }
  }
}

function validateLinkAudit(linkAudit, expectedHashScan, expectedMirror) {
  if (
    !linkAudit ||
    !["available", "unavailable", "mixed", "unchecked"].includes(
      linkAudit.hashScanStatus,
    ) ||
    !["verified", "unavailable", "unchecked"].includes(
      linkAudit.mirrorStatus,
    ) ||
    !Number.isSafeInteger(linkAudit.hashScanChecked) ||
    linkAudit.hashScanChecked < 0 ||
    !Number.isSafeInteger(linkAudit.mirrorChecked) ||
    linkAudit.mirrorChecked < 0 ||
    (linkAudit.hashScanStatus === "unchecked" &&
      (linkAudit.checkedAt !== null || linkAudit.hashScanChecked !== 0)) ||
    (linkAudit.hashScanStatus !== "unchecked" &&
      (!Number.isFinite(Date.parse(linkAudit.checkedAt ?? "")) ||
        linkAudit.hashScanChecked !== expectedHashScan)) ||
    (linkAudit.mirrorStatus === "verified" &&
      linkAudit.mirrorChecked !== expectedMirror) ||
    (linkAudit.finding !== null &&
      (typeof linkAudit.finding !== "string" ||
        !/^docs\/findings\/[a-z0-9-]+\.md$/.test(linkAudit.finding)))
  ) {
    throw new Error("HTS evidence has an invalid public link audit.");
  }
}

export function validateHtsEvidenceRecord(record) {
  visit(record);
  if (
    record?.schemaVersion !== 1 ||
    record?.evidenceKind !== "hts-settlement" ||
    !["controlled-test", "circle-usdc"].includes(record?.settlementProfile) ||
    record?.network !== "hedera-testnet" ||
    record?.chainId !== CHAIN_ID ||
    record?.status !== "verified" ||
    !Number.isFinite(Date.parse(record?.generatedAt ?? ""))
  ) {
    throw new Error("HTS evidence is not a verified Hedera testnet record.");
  }
  if (
    (record.settlementProfile === "circle-usdc" &&
      record.recipeId !== "hts-usdc-term-credit") ||
    (record.settlementProfile === "controlled-test" && record.recipeId !== null)
  ) {
    throw new Error(
      "HTS evidence recipe does not match its settlement profile.",
    );
  }
  validateRailPolicyEvidence(record.policy);

  for (const name of [
    "factory",
    "resolver",
    "atsToken",
    "settlementToken",
    "oracle",
    "rail",
    "acceptance",
  ]) {
    if (!ADDRESS_RE.test(record.addresses?.[name] ?? "")) {
      throw new Error(`HTS evidence is missing ${name}.`);
    }
  }
  if (
    (record.settlementProfile === "circle-usdc" &&
      !ADDRESS_RE.test(record.addresses?.pyth ?? "")) ||
    (record.settlementProfile === "controlled-test" &&
      record.addresses?.pyth !== null)
  ) {
    throw new Error(
      "HTS evidence oracle dependencies do not match the profile.",
    );
  }
  for (const actor of ["issuer", "lender", "borrower"]) {
    if (
      !ACCOUNT_ID_RE.test(record.actors?.[actor]?.accountId ?? "") ||
      !ADDRESS_RE.test(record.actors?.[actor]?.evmAddress ?? "")
    ) {
      throw new Error(`HTS evidence is missing ${actor} identity.`);
    }
  }
  const actorValues = ["issuer", "lender", "borrower"].map(
    (name) => record.actors[name],
  );
  if (
    new Set(actorValues.map((actor) => actor.accountId)).size !== 3 ||
    new Set(actorValues.map((actor) => actor.evmAddress.toLowerCase())).size !==
      3
  ) {
    throw new Error("HTS evidence actor identities must be distinct.");
  }

  validateTokenMetadata(record.settlementToken, record.settlementProfile);
  if (
    record.addresses.settlementToken.toLowerCase() !==
    record.settlementToken.evmAddress.toLowerCase()
  ) {
    throw new Error("HTS token address does not match its metadata proof.");
  }
  if (record.settlementProfile === "controlled-test") {
    if (
      record.oracle?.kind !== "fixed-test" ||
      !/^[1-9]\d*$/.test(record.oracle?.priceUsdE8 ?? "") ||
      record.oracle?.confidenceUsdE8 !== "0" ||
      !Number.isSafeInteger(record.oracle?.observedAt) ||
      record.oracle.observedAt <= 0 ||
      record.oracle?.purpose !== "controlled mechanics only" ||
      typeof record.oracle?.limitation !== "string" ||
      record.oracle.limitation.length < 20
    ) {
      throw new Error(
        "Controlled evidence must carry a valid test-only oracle limitation.",
      );
    }
  } else if (
    record.oracle?.kind !== "pyth" ||
    record.oracle?.feedId?.toLowerCase() !== USDC_USD_PRICE_ID ||
    !/^[1-9]\d*$/.test(record.oracle?.priceUsdE8 ?? "") ||
    !INTEGER_RE.test(record.oracle?.confidenceUsdE8 ?? "") ||
    !Number.isSafeInteger(record.oracle?.observedAt) ||
    record.oracle.observedAt <= 0 ||
    record.oracle?.purpose !==
      "Circle testnet USDC collateral-coverage valuation"
  ) {
    throw new Error("Circle evidence must use the pinned Pyth USDC/USD feed.");
  }

  if (!Array.isArray(record.transactions) || record.transactions.length < 10) {
    throw new Error("HTS evidence has too few transaction proofs.");
  }
  const transactionJournal = new Map();
  const transactionHashes = new Set();
  for (const proof of record.transactions) {
    validateAnyTransaction(proof);
    const key = transactionKey(proof);
    const proofHash =
      proof.type === "transaction"
        ? proof.hash.toLowerCase()
        : proof.transactionHash.toLowerCase();
    if (transactionJournal.has(key) || transactionHashes.has(proofHash)) {
      throw new Error("HTS evidence contains a duplicate transaction proof.");
    }
    transactionJournal.set(key, proof);
    transactionHashes.add(proofHash);
  }
  const requireRecordedSuccess = (proof) => {
    validateAnyTransaction(proof, true);
    if (!sameProof(proof, transactionJournal.get(transactionKey(proof)))) {
      throw new Error(
        "HTS lifecycle proof is not present in the transaction journal.",
      );
    }
    return proof;
  };

  const lifecycle = record.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object") {
    throw new Error("HTS evidence lifecycle is incomplete.");
  }
  const lifecycleKinds = {
    atsBondDeployment: /^ats-bond-deployment-\d+$/,
    settlementInitialization: /^settlement-initialization$/,
    fundedOffer: /^fund-offer-1$/,
    holdCreation: /^accept-offer-1$/,
    repaidFacility: /^repay-position$/,
  };
  for (const [name, kindPattern] of Object.entries(lifecycleKinds)) {
    const proof = requireRecordedSuccess(lifecycle[name]);
    if (proof.type !== "transaction" || !kindPattern.test(proof.kind)) {
      throw new Error(`HTS lifecycle ${name} has the wrong semantic kind.`);
    }
  }
  if (
    !Array.isArray(lifecycle.actorProvisioning) ||
    lifecycle.actorProvisioning.length < 2
  ) {
    throw new Error("HTS evidence is missing actor provisioning proofs.");
  }
  for (const proof of lifecycle.actorProvisioning) {
    requireRecordedSuccess(proof);
  }
  if (record.settlementProfile === "controlled-test") {
    const creation = requireRecordedSuccess(lifecycle.settlementTokenCreation);
    if (
      creation.type !== "hedera-transaction" ||
      creation.kind !== "settlement-token-creation"
    ) {
      throw new Error(
        "Controlled evidence token creation is not a native HTS proof.",
      );
    }
  } else if (lifecycle.settlementTokenCreation !== null) {
    throw new Error("Circle evidence must not claim token creation.");
  }
  if (record.oracle.kind === "pyth") {
    const update = requireRecordedSuccess(record.oracle.updateTransaction);
    if (
      update.type !== "transaction" ||
      update.kind !== "pyth-price-refresh" ||
      !sameProof(lifecycle.oracleUpdate, update)
    ) {
      throw new Error("Pyth oracle proof is not bound to the lifecycle.");
    }
  } else if (lifecycle.oracleUpdate !== null) {
    throw new Error("Fixed test oracle evidence must not claim a Pyth update.");
  }

  const lifecycleState = validateState(lifecycle.liveConfigurationRead);
  if (!Array.isArray(record.positions) || record.positions.length !== 2) {
    throw new Error("HTS evidence must contain exactly two positions.");
  }
  const repaid = record.positions.find(
    (position) => position.state === "REPAID",
  );
  const defaulted = record.positions.find(
    (position) => position.state === "DEFAULTED",
  );
  if (
    !repaid ||
    repaid.terminalPath !== "repayment" ||
    !defaulted ||
    !["hss", "permissionless-fallback"].includes(defaulted.terminalPath)
  ) {
    throw new Error("HTS evidence terminal paths are incomplete.");
  }
  const positionIds = new Set();
  const holdIds = new Set();
  for (const position of record.positions) {
    if (
      !HASH_RE.test(position?.id ?? "") ||
      !ADDRESS_RE.test(position?.lender ?? "") ||
      !ADDRESS_RE.test(position?.borrower ?? "") ||
      position.lender.toLowerCase() !==
        record.actors.lender.evmAddress.toLowerCase() ||
      position.borrower.toLowerCase() !==
        record.actors.borrower.evmAddress.toLowerCase() ||
      !/^[1-9]\d*$/.test(position?.collateralAmount ?? "") ||
      !/^[1-9]\d*$/.test(position?.holdId ?? "") ||
      !/^[1-9]\d*$/.test(position?.principalTokenUnits ?? "") ||
      !/^[1-9]\d*$/.test(position?.repaymentTokenUnits ?? "") ||
      BigInt(position.repaymentTokenUnits) <
        BigInt(position.principalTokenUnits) ||
      !Number.isSafeInteger(position?.openedAt) ||
      !Number.isSafeInteger(position?.maturity) ||
      position.maturity <= position.openedAt ||
      !ADDRESS_RE.test(position?.scheduleAddress ?? "") ||
      !["PENDING", "COMPLETED", "UNAVAILABLE", "NONE"].includes(
        position?.automation,
      )
    ) {
      throw new Error("HTS evidence contains an incomplete position proof.");
    }
    const positionId = position.id.toLowerCase();
    if (positionIds.has(positionId) || holdIds.has(position.holdId)) {
      throw new Error(
        "HTS evidence position and hold identifiers must be distinct.",
      );
    }
    positionIds.add(positionId);
    holdIds.add(position.holdId);
  }

  if (defaulted.terminalPath === "hss") {
    const schedule = validateSchedule(lifecycle.maturedDefault);
    if (
      schedule.executedTimestamp === null ||
      schedule.address.toLowerCase() !== defaulted.scheduleAddress.toLowerCase()
    ) {
      throw new Error("HSS terminal evidence is not bound to execution.");
    }
  } else {
    const fallback = requireRecordedSuccess(lifecycle.maturedDefault);
    if (
      fallback.type !== "transaction" ||
      fallback.kind !== "permissionless-default"
    ) {
      throw new Error("Fallback terminal evidence lacks a settlement proof.");
    }
  }

  if (!Array.isArray(record.holds) || record.holds.length !== 2) {
    throw new Error("HTS evidence must bind one ATS hold to each position.");
  }
  const holdsByPosition = new Map();
  for (const hold of record.holds) {
    const position = record.positions.find(
      (candidate) =>
        candidate.id.toLowerCase() === String(hold?.positionId).toLowerCase(),
    );
    if (
      !position ||
      holdsByPosition.has(position.id.toLowerCase()) ||
      hold.holdId !== position.holdId ||
      hold.holder.toLowerCase() !== position.borrower.toLowerCase() ||
      hold.partition.toLowerCase() !== DEFAULT_PARTITION ||
      hold.amount !== position.collateralAmount ||
      !/^[1-9]\d*$/.test(hold.expirationTimestamp ?? "") ||
      BigInt(hold.expirationTimestamp) <= BigInt(position.maturity) ||
      hold.escrow.toLowerCase() !== record.addresses.rail.toLowerCase() ||
      hold.destination.toLowerCase() !== ZERO_ADDRESS ||
      hold.data.toLowerCase() !== position.id.toLowerCase() ||
      hold.operatorData !== "0x" ||
      !Number.isSafeInteger(hold.thirdPartyType) ||
      hold.thirdPartyType < 0
    ) {
      throw new Error("HTS hold evidence is not bound to its position.");
    }
    const holdState = validateState(hold.state);
    const holdAssertions = {
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
    };
    for (const [key, expected] of Object.entries(holdAssertions)) {
      if (holdState.assertions[key] !== expected) {
        throw new Error(`HTS hold proof is missing assertion ${key}.`);
      }
    }
    const terminalState = validateState(hold.terminalState);
    if (
      terminalState.blockNumber !== lifecycleState.blockNumber ||
      terminalState.rpcOrigin !== lifecycleState.rpcOrigin
    ) {
      throw new Error("Terminal HTS hold proof does not use the final block.");
    }
    const terminalAssertions = {
      "hold.positionId": hold.positionId,
      "hold.holdId": hold.holdId,
      "hold.holder": hold.holder,
      "hold.partition": hold.partition,
      "hold.remainingAmount": "0",
      "hold.deleted": true,
    };
    for (const [key, expected] of Object.entries(terminalAssertions)) {
      if (terminalState.assertions[key] !== expected) {
        throw new Error(`HTS terminal hold proof is missing assertion ${key}.`);
      }
    }
    holdsByPosition.set(position.id.toLowerCase(), hold);
  }

  if (!Array.isArray(record.schedules) || record.schedules.length === 0) {
    throw new Error("HTS evidence has no Mirror-confirmed schedules.");
  }
  const schedulesByAddress = new Map();
  for (const schedule of record.schedules) {
    validateSchedule(schedule);
    const key = schedule.address.toLowerCase();
    if (schedulesByAddress.has(key)) {
      throw new Error("HTS evidence contains a duplicate schedule proof.");
    }
    schedulesByAddress.set(key, schedule);
  }
  const scheduledPositions = record.positions.filter(
    (position) => position.scheduleAddress !== ZERO_ADDRESS,
  );
  if (
    scheduledPositions.length !== schedulesByAddress.size ||
    scheduledPositions.some(
      (position) =>
        !schedulesByAddress.has(position.scheduleAddress.toLowerCase()),
    )
  ) {
    throw new Error("HTS schedule proofs are not bound to the positions.");
  }
  for (const position of record.positions) {
    if (position.scheduleAddress === ZERO_ADDRESS) {
      if (position.automation !== "UNAVAILABLE") {
        throw new Error(
          "Unscheduled HTS position lacks unavailable automation.",
        );
      }
    } else {
      const schedule = schedulesByAddress.get(
        position.scheduleAddress.toLowerCase(),
      );
      if (position.automation !== "COMPLETED" || !schedule?.executedTimestamp) {
        throw new Error("HTS schedule execution contradicts automation state.");
      }
    }
  }
  if (
    defaulted.terminalPath === "hss" &&
    !sameProof(
      lifecycle.maturedDefault,
      schedulesByAddress.get(defaulted.scheduleAddress.toLowerCase()),
    )
  ) {
    throw new Error("HTS default schedule is not bound to the terminal path.");
  }

  if (
    !Array.isArray(record.tokenTransfers) ||
    record.tokenTransfers.length < 6
  ) {
    throw new Error("HTS evidence has too few token transfer proofs.");
  }
  for (const transfer of record.tokenTransfers) {
    if (
      transfer?.type !== "token-transfer" ||
      transfer.tokenId !== record.settlementToken.tokenId ||
      !ADDRESS_RE.test(transfer.from ?? "") ||
      !ADDRESS_RE.test(transfer.to ?? "") ||
      requireUnsigned(transfer.amount, "Token transfer amount") <= 0n ||
      transfer.mirror !== transfer.transaction?.mirror
    ) {
      throw new Error("HTS evidence contains an invalid token transfer proof.");
    }
    requireRecordedSuccess(transfer.transaction);
  }

  if (!Array.isArray(record.complianceProbes)) {
    throw new Error("HTS evidence compliance probes are missing.");
  }
  const requiredProbes =
    record.settlementProfile === "controlled-test"
      ? [
          "association",
          "kyc-revoked",
          "account-frozen",
          "token-paused",
          "insufficient-allowance",
        ]
      : ["association", "insufficient-allowance"];
  for (const kind of requiredProbes) {
    const matches = record.complianceProbes.filter(
      (probe) => probe.kind === kind,
    );
    const probe = matches[0];
    if (
      matches.length !== 1 ||
      !probe ||
      probe.verified !== true ||
      typeof probe.expectedFailure !== "string" ||
      probe.expectedFailure.length < 3
    ) {
      throw new Error(`HTS evidence is missing the ${kind} probe.`);
    }
    validateAnyTransaction(probe.rejectedTransaction);
    if (
      probe.rejectedTransaction.result === "SUCCESS" ||
      !sameProof(
        probe.rejectedTransaction,
        transactionJournal.get(transactionKey(probe.rejectedTransaction)),
      )
    ) {
      throw new Error(
        `${kind} probe did not record a bound failed transaction.`,
      );
    }
    requireRecordedSuccess(probe.recoveryTransaction);
  }

  validateAtsEvidence(record.ats);
  const tokenLiabilities = requireUnsigned(
    record.accounting?.cashTokenLiabilities,
    "Token liabilities",
  );
  const tokenBalance = requireUnsigned(
    record.accounting?.railTokenBalance,
    "Rail token balance",
  );
  const automationReserve = requireUnsigned(
    record.accounting?.reservedAutomationTinybar,
    "Automation reserve",
  );
  const hbarBalance = requireUnsigned(
    record.accounting?.railHbarBalanceTinybar,
    "Rail HBAR balance",
  );
  if (tokenBalance < tokenLiabilities || hbarBalance < automationReserve) {
    throw new Error("HTS evidence is insolvent.");
  }

  const state = validateState(record.verification?.state);
  if (!sameProof(state, lifecycleState)) {
    throw new Error("HTS lifecycle and verification state proofs differ.");
  }
  const requiredStateAssertions = {
    "rail.settlementInitialized": true,
    "rail.settlementDecimals": record.settlementToken.decimals,
    "rail.cashTokenLiabilities": record.accounting.cashTokenLiabilities,
    "rail.settlementTokenBalance": record.accounting.railTokenBalance,
    "rail.reservedAutomationTinybar":
      record.accounting.reservedAutomationTinybar,
    "rail.hbarBalanceTinybar": record.accounting.railHbarBalanceTinybar,
    "rail.policy.maximumAdvanceBps": record.policy.maximumAdvanceBps,
    "rail.policy.maximumAnnualRateBps": record.policy.maximumAnnualRateBps,
    "rail.policy.maximumQuoteMovementBps":
      record.policy.maximumQuoteMovementBps,
    "rail.policy.minimumTermSeconds": record.policy.minimumTermSeconds,
    "rail.policy.maximumTermSeconds": record.policy.maximumTermSeconds,
    "rail.policy.maximumOfferLifetimeSeconds":
      record.policy.maximumOfferLifetimeSeconds,
    "positions.repaidState": "REPAID",
    "positions.defaultedState": "DEFAULTED",
    "oracle.kind": record.oracle.kind,
    "oracle.priceUsdE8": record.oracle.priceUsdE8,
    "oracle.confidenceUsdE8": record.oracle.confidenceUsdE8,
    "oracle.observedAt": record.oracle.observedAt,
  };
  for (const [key, expected] of Object.entries(requiredStateAssertions)) {
    if (state.assertions[key] !== expected) {
      throw new Error(`HTS state proof is missing assertion ${key}.`);
    }
  }

  if (
    record.verification?.complete !== true ||
    record.verification?.mirrorOrigin !== MIRROR_ORIGIN ||
    !Array.isArray(record.verification?.settlementBalances) ||
    record.verification.settlementBalances.length < 3 ||
    !record.verification?.hbarBalance
  ) {
    throw new Error("HTS verification evidence is incomplete.");
  }
  const settlementBalances = new Map();
  for (const proof of record.verification.settlementBalances) {
    validateBalanceProof(proof);
    if (
      proof.tokenId !== record.settlementToken.tokenId ||
      settlementBalances.has(proof.accountId)
    ) {
      throw new Error(
        "HTS balance proofs are duplicated or use the wrong token.",
      );
    }
    settlementBalances.set(proof.accountId, proof);
  }
  for (const evmAddress of [
    record.actors.lender.evmAddress,
    record.actors.borrower.evmAddress,
    record.addresses.rail,
  ]) {
    if (
      ![...settlementBalances.values()].some(
        (proof) => proof.evmAddress.toLowerCase() === evmAddress.toLowerCase(),
      )
    ) {
      throw new Error("HTS evidence is missing a required settlement balance.");
    }
  }
  const railTokenBalance = [...settlementBalances.values()].find(
    (proof) =>
      proof.evmAddress.toLowerCase() === record.addresses.rail.toLowerCase(),
  );
  if (
    railTokenBalance.balanceTokenUnits !== record.accounting.railTokenBalance
  ) {
    throw new Error(
      "Current Mirror token balance differs from HTS accounting.",
    );
  }
  const hbarProof = validateHbarBalanceProof(
    record.verification.hbarBalance,
    record.addresses.rail,
  );
  if (hbarProof.balanceTinybar !== record.accounting.railHbarBalanceTinybar) {
    throw new Error("Current Mirror HBAR balance differs from HTS accounting.");
  }

  const expectedSources = {
    factoryHashScan: hashScanContract(record.addresses.factory),
    factoryMirror: mirrorContract(record.addresses.factory),
    resolverHashScan: hashScanContract(record.addresses.resolver),
    resolverMirror: mirrorContract(record.addresses.resolver),
    atsTokenHashScan: hashScanContract(record.addresses.atsToken),
    atsTokenMirror: mirrorContract(record.addresses.atsToken),
    settlementTokenHashScan: `${HASHSCAN_ORIGIN}/testnet/token/${record.settlementToken.tokenId}`,
    settlementTokenMirror: record.settlementToken.mirror,
    oracleHashScan: hashScanContract(record.addresses.oracle),
    oracleMirror: mirrorContract(record.addresses.oracle),
    railHashScan: hashScanContract(record.addresses.rail),
    railMirror: mirrorContract(record.addresses.rail),
    acceptanceHashScan: hashScanContract(record.addresses.acceptance),
    acceptanceMirror: mirrorContract(record.addresses.acceptance),
  };
  if (
    Object.keys(record.verification.sourceUrls ?? {})
      .sort()
      .join(",") !== Object.keys(expectedSources).sort().join(",") ||
    Object.entries(expectedSources).some(
      ([key, expected]) => record.verification.sourceUrls[key] !== expected,
    )
  ) {
    throw new Error(
      "HTS evidence contains an invalid authoritative source URL.",
    );
  }
  validateLinkAudit(
    record.verification.linkAudit,
    record.transactions.length + record.schedules.length + 7,
    record.transactions.length +
      record.schedules.length +
      7 +
      record.verification.settlementBalances.length +
      1,
  );

  if (
    !Array.isArray(record.limitations) ||
    record.limitations.length === 0 ||
    record.limitations.some(
      (limitation) => typeof limitation !== "string" || limitation.length < 15,
    ) ||
    typeof record.notice !== "string" ||
    record.notice.length < 20
  ) {
    throw new Error(
      "HTS evidence must publish explicit limitations and notice text.",
    );
  }
  if (
    !record.metrics ||
    !Number.isFinite(Date.parse(record.metrics.startedAt ?? "")) ||
    !Number.isFinite(Date.parse(record.metrics.completedAt ?? "")) ||
    !Number.isSafeInteger(record.metrics.elapsedMilliseconds) ||
    record.metrics.elapsedMilliseconds <= 0 ||
    Date.parse(record.metrics.startedAt) >
      Date.parse(record.metrics.completedAt) ||
    Date.parse(record.metrics.completedAt) -
      Date.parse(record.metrics.startedAt) !==
      record.metrics.elapsedMilliseconds ||
    record.generatedAt !== record.metrics.completedAt ||
    !Number.isSafeInteger(record.metrics.mirrorConfirmedTransactions) ||
    record.metrics.mirrorConfirmedTransactions !== record.transactions.length
  ) {
    throw new Error("HTS evidence metrics are invalid.");
  }
  return record;
}

export const htsEvidenceConstants = Object.freeze({
  CIRCLE_USDC_ID,
  CIRCLE_USDC_ADDRESS,
  USDC_USD_PRICE_ID,
  MIRROR_ORIGIN,
});
