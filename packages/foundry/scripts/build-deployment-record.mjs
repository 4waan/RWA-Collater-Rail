import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MIRROR_URL,
  EvidenceJournal,
  categorizeBootstrapTransactions,
  proofForSemanticKind,
  waitForMirrorTransaction,
} from "./lib/evidence-lib.mjs";

const root = process.cwd();
const addressesPath = path.join(root, "deployments", "latest-addresses.json");
const broadcastPath = path.join(
  root,
  "broadcast",
  "BootstrapTestnet.s.sol",
  "296",
  "run-latest.json",
);
const outputPath = path.join(root, "deployments", "testnet.json");
const startedAtMilliseconds = Date.now();

const addresses = JSON.parse(await readFile(addressesPath, "utf8"));
const broadcast = JSON.parse(await readFile(broadcastPath, "utf8"));
const categorized = categorizeBootstrapTransactions(
  broadcast.transactions ?? [],
);
const journal = new EvidenceJournal();
for (const transaction of categorized) {
  const proof = await waitForMirrorTransaction({
    mirrorOrigin: DEFAULT_MIRROR_URL,
    hash: transaction.hash,
  });
  journal.add(transaction.kind, proof);
}
const transactions = journal.values();
const completedAtMilliseconds = Date.now();
const completedAt = new Date(completedAtMilliseconds).toISOString();

const record = {
  schemaVersion: 3,
  network: "hedera-testnet",
  chainId: 296,
  status: "bootstrap-mined",
  generatedAt: completedAt,
  recipeId: null,
  policy: null,
  addresses,
  actors: {
    issuer: { accountId: null, evmAddress: addresses.operator },
    lender: { accountId: null, evmAddress: addresses.lender },
    borrower: { accountId: null, evmAddress: addresses.borrower },
  },
  transactions,
  lifecycle: {
    atsBondDeployment: proofForSemanticKind(
      transactions,
      "ats-bond-deployment",
    ),
    ssiAndKycConfiguration: proofForSemanticKind(
      transactions,
      "kyc-grant",
      "last",
    ),
    collateralIssuance: proofForSemanticKind(
      transactions,
      "collateral-issuance",
    ),
    pythPriceUpdate: null,
    fundedOffer: null,
    holdCreation: null,
    hssScheduleCreation: null,
    repaidFacility: null,
    maturedDefault: null,
    liveConfigurationRead: null,
  },
  oracle: null,
  pyth: null,
  ats: null,
  positions: [],
  holds: [],
  schedules: [],
  accounting: null,
  verification: {
    complete: false,
    state: null,
    balance: null,
    mirrorOrigin: DEFAULT_MIRROR_URL,
    contractLinks: {},
    contractMirrorLinks: {},
    linkAudit: {
      checkedAt: null,
      hashScanStatus: "unchecked",
      mirrorStatus: "unchecked",
      hashScanChecked: 0,
      mirrorChecked: 0,
      finding: null,
    },
  },
  metrics: {
    startedAt: new Date(startedAtMilliseconds).toISOString(),
    completedAt,
    elapsedMilliseconds: completedAtMilliseconds - startedAtMilliseconds,
    mirrorConfirmedTransactions: transactions.length,
  },
  notice:
    "Bootstrap transactions are mined. Complete and verify both terminal paths before publication.",
};

await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Wrote private bootstrap record to ${outputPath}.`);
