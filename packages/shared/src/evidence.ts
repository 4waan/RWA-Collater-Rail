import type { RailPolicy } from "./recipes";

export type TransactionProof = {
  type: "transaction";
  kind: string;
  hash: string;
  consensusTimestamp: string;
  result: string;
  mirror: string;
  hashScan: string;
};

export type ScheduleProof = {
  type: "schedule";
  address: string;
  scheduleId: string;
  executedTimestamp: string | null;
  mirror: string;
  hashScan: string;
};

export type PublicLinkAudit = {
  checkedAt: string | null;
  hashScanStatus: "available" | "unavailable" | "mixed" | "unchecked";
  mirrorStatus: "verified" | "unavailable" | "unchecked";
  hashScanChecked: number;
  mirrorChecked: number;
  finding: string | null;
};

export type StateAssertion = string | number | boolean;

export type StateProof = {
  type: "state";
  blockNumber: string;
  rpcOrigin: string;
  assertions: Record<string, StateAssertion>;
};

export type BalanceProof = {
  type: "balance";
  basis: "current-mirror-account";
  accountId: string;
  evmAddress: string;
  balanceTinybar: string;
  balanceTimestamp: string;
  checkedAt: string;
  mirror: string;
};

export type ReferenceLifecycle = {
  atsBondDeployment: TransactionProof | null;
  ssiAndKycConfiguration: TransactionProof | null;
  collateralIssuance: TransactionProof | null;
  pythPriceUpdate: TransactionProof | null;
  fundedOffer: TransactionProof | null;
  holdCreation: TransactionProof | null;
  hssScheduleCreation: ScheduleProof | null;
  repaidFacility: TransactionProof | null;
  maturedDefault: TransactionProof | ScheduleProof | null;
  liveConfigurationRead: StateProof | null;
};

export type ReferencePosition = {
  id: string;
  lender: string;
  borrower: string;
  collateralAmount: string;
  holdId: string;
  principalTinybar: string;
  repaymentTinybar: string;
  openedAt: number;
  maturity: number;
  scheduleAddress: string;
  state: "REPAID" | "DEFAULTED";
  automation: "PENDING" | "COMPLETED" | "UNAVAILABLE" | "NONE";
  terminalPath: "repayment" | "hss" | "permissionless-fallback";
};

export type HoldEvidence = {
  positionId: string;
  holdId: string;
  holder: string;
  partition: string;
  amount: string;
  expirationTimestamp: string;
  escrow: string;
  destination: string;
  data: string;
  operatorData: string;
  thirdPartyType: number;
  state: StateProof;
  terminalState: StateProof;
};

export type AccountingEvidence = {
  cashLiabilitiesTinybar: string;
  reservedAutomationTinybar: string;
  requiredBackingTinybar: string;
  contractBalanceTinybar: string;
};

export type EvidenceMetrics = {
  startedAt: string;
  completedAt: string;
  elapsedMilliseconds: number;
  mirrorConfirmedTransactions: number;
};

export type PythOracleEvidence = {
  kind: "pyth";
  feedId: string;
  priceUsdE8: string;
  confidenceUsdE8: string;
  observedAt: number;
  purpose: string;
};

export type HederaExchangeRateEvidence = {
  kind: "hedera-exchange-rate";
  systemContract: string;
  systemFile: string;
  priceUsdE8: string;
  confidenceUsdE8: string;
  observedAt: number;
  purpose: string;
  caveat: string;
};

export type OracleEvidence = PythOracleEvidence | HederaExchangeRateEvidence;

export type ReferenceDeployment = {
  schemaVersion: 3;
  network: string;
  chainId: number;
  status: string;
  generatedAt: string | null;
  recipeId: string | null;
  policy: RailPolicy | null;
  addresses: Record<string, string | null>;
  actors: Record<string, { accountId: string; evmAddress: string } | null>;
  transactions: TransactionProof[];
  lifecycle: ReferenceLifecycle;
  oracle: OracleEvidence | null;
  pyth: {
    feedId: string;
    priceUsdE8: string;
    confidenceUsdE8: string;
    publishTime: number;
    purpose: string;
  } | null;
  ats: {
    internalKyc: boolean;
    issuer: boolean;
    kyc: { lender: number; borrower: number };
    roles: { issuer: boolean; kyc: boolean; ssiManager: boolean };
    assetMaturity: string;
    clearingActive: boolean;
    tokenDecimals: number;
    nominalValue: string;
    nominalValueDecimals: number;
    nominalValueCurrency: string;
    balances: {
      borrower: { free: string; held: string };
      lender: { free: string; held: string };
    };
  } | null;
  positions: ReferencePosition[];
  holds: HoldEvidence[];
  schedules: ScheduleProof[];
  accounting: AccountingEvidence | null;
  verification: {
    complete: boolean;
    state: StateProof | null;
    balance: BalanceProof | null;
    mirrorOrigin: string;
    contractLinks: Record<string, string>;
    contractMirrorLinks: Record<string, string>;
    linkAudit: PublicLinkAudit;
  };
  metrics: EvidenceMetrics | null;
  notice: string;
};

export type HtsSettlementProfile = "controlled-test" | "circle-usdc";

export type HederaNativeTransactionProof = {
  type: "hedera-transaction";
  kind: string;
  transactionId: string;
  transactionHash: string;
  consensusTimestamp: string;
  result: string;
  mirror: string;
  hashScan: string;
};

export type HtsTransactionProof =
  | TransactionProof
  | HederaNativeTransactionProof;

export type HtsTokenMetadataEvidence = {
  tokenId: string;
  evmAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  type: "FUNGIBLE_COMMON";
  deleted: boolean;
  freezeDefault: boolean;
  pauseStatus: "PAUSED" | "UNPAUSED" | "NOT_APPLICABLE";
  kycKey: boolean;
  freezeKey: boolean;
  pauseKey: boolean;
  feeScheduleKey: boolean;
  fixedFeeCount: number;
  fractionalFeeCount: number;
  royaltyFeeCount: number;
  mirror: string;
  verifiedAt: string;
};

export type HtsTokenTransferProof = {
  type: "token-transfer";
  transaction: HtsTransactionProof;
  tokenId: string;
  from: string;
  to: string;
  amount: string;
  mirror: string;
};

export type HtsBalanceProof = {
  type: "token-balance";
  basis: "current-mirror-token-relationship";
  tokenId: string;
  accountId: string;
  evmAddress: string;
  associated: true;
  kycStatus: "GRANTED" | "REVOKED" | "NOT_APPLICABLE";
  freezeStatus: "FROZEN" | "UNFROZEN" | "NOT_APPLICABLE";
  balanceTokenUnits: string;
  checkedAt: string;
  mirror: string;
};

export type HtsOracleEvidence =
  | {
      kind: "fixed-test";
      priceUsdE8: string;
      confidenceUsdE8: "0";
      observedAt: number;
      purpose: "controlled mechanics only";
      limitation: string;
    }
  | {
      kind: "pyth";
      feedId: string;
      priceUsdE8: string;
      confidenceUsdE8: string;
      observedAt: number;
      purpose: "Circle testnet USDC collateral-coverage valuation";
      updateTransaction: TransactionProof;
    };

export type HtsComplianceProbe = {
  kind:
    | "association"
    | "kyc-revoked"
    | "account-frozen"
    | "token-paused"
    | "insufficient-allowance";
  expectedFailure: string;
  rejectedTransaction: HtsTransactionProof;
  recoveryTransaction: HtsTransactionProof;
  verified: boolean;
};

export type HtsReferencePosition = {
  id: string;
  lender: string;
  borrower: string;
  collateralAmount: string;
  holdId: string;
  principalTokenUnits: string;
  repaymentTokenUnits: string;
  openedAt: number;
  maturity: number;
  scheduleAddress: string;
  state: "REPAID" | "DEFAULTED";
  automation: "PENDING" | "COMPLETED" | "UNAVAILABLE" | "NONE";
  terminalPath: "repayment" | "hss" | "permissionless-fallback";
};

export type HtsReferenceLifecycle = {
  atsBondDeployment: TransactionProof;
  settlementTokenCreation: HederaNativeTransactionProof | null;
  settlementInitialization: TransactionProof;
  actorProvisioning: HtsTransactionProof[];
  oracleUpdate: TransactionProof | null;
  fundedOffer: TransactionProof;
  holdCreation: TransactionProof;
  repaidFacility: TransactionProof;
  maturedDefault: TransactionProof | ScheduleProof;
  liveConfigurationRead: StateProof;
};

export type HtsReferenceDeployment = {
  schemaVersion: 1;
  evidenceKind: "hts-settlement";
  settlementProfile: HtsSettlementProfile;
  network: "hedera-testnet";
  chainId: 296;
  status: "verified";
  generatedAt: string;
  recipeId: "hts-usdc-term-credit" | null;
  policy: RailPolicy;
  addresses: Record<string, string | null>;
  actors: Record<string, { accountId: string; evmAddress: string } | null>;
  settlementToken: HtsTokenMetadataEvidence;
  oracle: HtsOracleEvidence;
  transactions: HtsTransactionProof[];
  tokenTransfers: HtsTokenTransferProof[];
  lifecycle: HtsReferenceLifecycle;
  complianceProbes: HtsComplianceProbe[];
  ats: ReferenceDeployment["ats"];
  positions: HtsReferencePosition[];
  holds: HoldEvidence[];
  schedules: ScheduleProof[];
  accounting: {
    cashTokenLiabilities: string;
    railTokenBalance: string;
    reservedAutomationTinybar: string;
    railHbarBalanceTinybar: string;
  };
  verification: {
    complete: true;
    state: StateProof;
    settlementBalances: HtsBalanceProof[];
    hbarBalance: BalanceProof;
    mirrorOrigin: string;
    sourceUrls: Record<string, string>;
    linkAudit: PublicLinkAudit;
  };
  metrics: EvidenceMetrics;
  limitations: string[];
  notice: string;
};

export type ClprObservationKind =
  | "observed-local-besu"
  | "observed-besu-to-solo"
  | "observed-hosted-testnet";

export type ClprMessageProof = {
  observation: ClprObservationKind;
  direction: string;
  channelId: string;
  sourceService: string;
  destinationService: string;
  sourceApplication: string;
  destinationApplication: string;
  mobilityId: string;
  messageKind: string;
  messageId: string;
  bundleHash: string;
  proofVerifier: string;
  sourceBlock: string;
  destinationBlock: string;
  observedAt: string;
};

export type ClprMobilityReferenceDeployment = {
  schemaVersion: 1;
  evidenceKind: "clpr-collateral-mobility";
  status: "verified-experimental";
  generatedAt: string;
  upstream: {
    specificationCommit: string;
    contractsCommit: string;
    endpointCommit: string;
  };
  observations: ClprObservationKind[];
  ledgers: Array<{
    domain: string;
    kind: "besu" | "hedera-solo" | "hosted";
    chainId: string;
    clprService: string;
    application: string;
  }>;
  messages: ClprMessageProof[];
  lifecycle: {
    repaymentMobilityId: string;
    defaultMobilityId: string;
    repaymentTerminalState: "REPAID";
    defaultTerminalState: "DEFAULTED";
  };
  accounting: {
    remoteTokenBalance: string;
    remoteCashLiabilities: string;
    hederaHbarBalanceTinybar: string;
    reservedAutomationTinybar: string;
  };
  exactState: StateProof[];
  sourceUrls: Record<string, string>;
  notDemonstrated: string[];
  limitations: string[];
  notice: string;
};
