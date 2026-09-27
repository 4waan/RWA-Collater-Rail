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
