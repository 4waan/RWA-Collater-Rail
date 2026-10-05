import {
  AccountCreateTransaction,
  AccountDeleteTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenGrantKycTransaction,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CIRCLE_TESTNET_USDC_TOKEN_ID } from "@collateral-rail/shared/hedera";
import {
  DEFAULT_MIRROR_URL,
  confirmMirrorAccountIdentity,
  fetchAllowedJson,
} from "./lib/evidence-lib.mjs";
import {
  HTS_ACTOR_TOKEN_UNITS,
  assertCircleUsdcPreflight,
  htsOutputPath,
} from "./lib/hts-demo-runtime.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const foundryRoot = path.resolve(scriptDirectory, "..");
const mode = process.argv[2];
const MIRROR = DEFAULT_MIRROR_URL;
const CAPPED_HBAR = 225;
const credentialFile =
  process.env.HTS_CREDENTIAL_FILE ??
  "/private/tmp/rwa-credit-rail-hts/credentials.env";

async function readCredentials() {
  const stat = await lstat(credentialFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 4_096
  ) {
    throw new Error(
      "The HTS credential file must be a private regular file with mode 600 or stricter.",
    );
  }
  const values = {};
  const lines = (await readFile(credentialFile, "utf8")).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const match =
      /^(HEDERA_OPERATOR_ID|HEDERA_OPERATOR_KEY|PYTH_API_KEY)=(.*)$/u.exec(
        line,
      );
    if (!match || Object.hasOwn(values, match[1])) {
      throw new Error(
        `The HTS credential file has an unknown or duplicate field on line ${index + 1}.`,
      );
    }
    values[match[1]] = match[2].trim();
  }
  return values;
}

const credentials = await readCredentials();
const sourceAccountId = credentials.HEDERA_OPERATOR_ID;
const sourceKeyHex = credentials.HEDERA_OPERATOR_KEY?.replace(/^0x/u, "");

function requireSource() {
  if (!/^0\.0\.\d+$/u.test(sourceAccountId ?? "")) {
    throw new Error("HEDERA_OPERATOR_ID must be a Hedera testnet account ID.");
  }
  if (!/^[a-fA-F0-9]{64}$/u.test(sourceKeyHex ?? "")) {
    throw new Error(
      "HEDERA_OPERATOR_KEY must be a raw ECDSA key in the private local environment file.",
    );
  }
  let key;
  try {
    key = PrivateKey.fromStringECDSA(sourceKeyHex);
  } catch {
    throw new Error("The operator ECDSA key could not be parsed.");
  }
  return { key, address: `0x${key.publicKey.toEvmAddress()}` };
}

async function tokenRelationship(accountId, tokenId) {
  return fetchAllowedJson(
    new URL(`/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`, MIRROR),
    MIRROR,
  );
}

async function circleRelationship(accountId) {
  return tokenRelationship(accountId, CIRCLE_TESTNET_USDC_TOKEN_ID);
}

async function circleMetadata() {
  return fetchAllowedJson(
    new URL(`/api/v1/tokens/${CIRCLE_TESTNET_USDC_TOKEN_ID}`, MIRROR),
    MIRROR,
  );
}

async function waitForCircleBalance(accountId, requiredUnits) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const relationship = await circleRelationship(accountId);
    const token = relationship.tokens?.[0];
    if (
      token?.token_id === CIRCLE_TESTNET_USDC_TOKEN_ID &&
      BigInt(token.balance ?? 0) >= requiredUnits
    ) {
      return BigInt(token.balance);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Mirror did not confirm the required Circle USDC balance.");
}

async function prepareUsdc(client) {
  const metadata = await circleMetadata();
  const sample = {
    tokens: [
      {
        token_id: CIRCLE_TESTNET_USDC_TOKEN_ID,
        balance: String(HTS_ACTOR_TOKEN_UNITS * 2n),
        kyc_status: "NOT_APPLICABLE",
        freeze_status: "UNFROZEN",
      },
    ],
  };
  assertCircleUsdcPreflight(metadata, sample);
  const relationship = await circleRelationship(sourceAccountId);
  if (relationship.tokens?.length === 0) {
    await (
      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(sourceAccountId))
        .setTokenIds([TokenId.fromString(CIRCLE_TESTNET_USDC_TOKEN_ID)])
        .execute(client)
    ).getReceipt(client);
    console.log(
      `Associated account ${sourceAccountId} with Circle testnet USDC.`,
    );
  } else {
    console.log(
      `Account ${sourceAccountId} is already associated with Circle testnet USDC.`,
    );
  }
  console.log(
    "The operator can now receive 20 testnet USDC from https://faucet.circle.com/.",
  );
}

async function sweepControlledToken(
  client,
  signerKey,
  signerAccountId,
  recoveryTokenId,
) {
  const tokenIdText =
    recoveryTokenId ??
    JSON.parse(await readFile(htsOutputPath("controlled"), "utf8"))
      .settlementToken?.tokenId;
  if (!/^0\.0\.\d+$/u.test(tokenIdText ?? "")) {
    throw new Error(
      "The controlled candidate has no settlement token ID for cleanup.",
    );
  }
  const metadata = await fetchAllowedJson(
    new URL(`/api/v1/tokens/${tokenIdText}`, MIRROR),
    MIRROR,
  );
  if (
    metadata.token_id !== tokenIdText ||
    metadata.name !== "Collateral Rail Controlled Test Dollar" ||
    metadata.symbol !== "CRTD" ||
    metadata.treasury_account_id !== signerAccountId ||
    metadata.type !== "FUNGIBLE_COMMON" ||
    metadata.deleted !== false
  ) {
    throw new Error(
      "The recovery token is not this signer's controlled test token.",
    );
  }
  const tokenId = TokenId.fromString(tokenIdText);
  const signerToken = (await tokenRelationship(signerAccountId, tokenIdText))
    .tokens?.[0];
  if (signerToken?.token_id !== tokenIdText) {
    throw new Error("Mirror omitted the controlled signer token relationship.");
  }
  const tokenBalance = BigInt(signerToken.balance ?? 0);
  if (tokenBalance === 0n) return;
  const sourceToken = (await tokenRelationship(sourceAccountId, tokenIdText))
    .tokens?.[0];
  if (!sourceToken) {
    await (
      await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(sourceAccountId))
        .setTokenIds([tokenId])
        .execute(client)
    ).getReceipt(client);
  }
  const grant = await new TokenGrantKycTransaction()
    .setTokenId(tokenId)
    .setAccountId(AccountId.fromString(sourceAccountId))
    .freezeWith(client);
  await (
    await (await grant.sign(signerKey)).execute(client)
  ).getReceipt(client);
  const transfer = await new TransferTransaction()
    .addTokenTransfer(tokenId, signerAccountId, -Number(tokenBalance))
    .addTokenTransfer(tokenId, sourceAccountId, Number(tokenBalance))
    .freezeWith(client);
  await (
    await (await transfer.sign(signerKey)).execute(client)
  ).getReceipt(client);
}

async function returnRemainingHbar(client, signerKey, signerAccountId) {
  const signerMirror = await confirmMirrorAccountIdentity({
    mirrorOrigin: MIRROR,
    accountId: signerAccountId,
    evmAddress: `0x${signerKey.publicKey.toEvmAddress()}`,
  });
  if (signerMirror.balanceTinybar <= 0n) return;
  const amount = Hbar.fromTinybars(signerMirror.balanceTinybar.toString());
  const transfer = await new TransferTransaction()
    .addHbarTransfer(signerAccountId, amount.negated())
    .addHbarTransfer(sourceAccountId, amount)
    .freezeWith(client);
  await (
    await (await transfer.sign(signerKey)).execute(client)
  ).getReceipt(client);
  console.log(
    `Returned remaining HBAR from ${signerAccountId} to the operator.`,
  );
}

async function discoverControlledTokenId(signerAccountId) {
  const relationships = await fetchAllowedJson(
    new URL(`/api/v1/accounts/${signerAccountId}/tokens?limit=100`, MIRROR),
    MIRROR,
  );
  if (!Array.isArray(relationships.tokens)) {
    throw new Error("Mirror omitted the capped signer's token relationships.");
  }
  const matches = [];
  for (const relationship of relationships.tokens) {
    if (!/^0\.0\.\d+$/u.test(relationship.token_id ?? "")) continue;
    const metadata = await fetchAllowedJson(
      new URL(`/api/v1/tokens/${relationship.token_id}`, MIRROR),
      MIRROR,
    );
    if (
      metadata.name === "Collateral Rail Controlled Test Dollar" &&
      metadata.symbol === "CRTD" &&
      metadata.treasury_account_id === signerAccountId
    ) {
      matches.push(relationship.token_id);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      "More than one controlled token belongs to the capped signer.",
    );
  }
  return matches[0] ?? null;
}

async function recoverControlled(client, source) {
  const directory = process.env.HTS_RECOVERY_DIRECTORY;
  const tokenId = process.env.HTS_RECOVERY_TOKEN_ID;
  if (
    typeof directory !== "string" ||
    path.dirname(directory) !== os.tmpdir() ||
    !path.basename(directory).startsWith("rwa-hts-signer-") ||
    !/^0\.0\.\d+$/u.test(tokenId ?? "")
  ) {
    throw new Error(
      "A private HTS recovery directory and token ID are required.",
    );
  }
  const directoryStat = await lstat(directory);
  const signerPath = path.join(directory, "signer.json");
  const accountIdPath = path.join(directory, "account-id.txt");
  const signerStat = await lstat(signerPath);
  if (
    !directoryStat.isDirectory() ||
    (directoryStat.mode & 0o077) !== 0 ||
    !signerStat.isFile() ||
    (signerStat.mode & 0o077) !== 0
  ) {
    throw new Error("The signer recovery files are not private regular files.");
  }
  const recovery = JSON.parse(await readFile(signerPath, "utf8"));
  const signerAccountId = (await readFile(accountIdPath, "utf8")).trim();
  if (
    recovery.network !== "testnet" ||
    !/^0x[a-fA-F0-9]{64}$/u.test(recovery.privateKey ?? "") ||
    !/^0\.0\.\d+$/u.test(signerAccountId)
  ) {
    throw new Error("The private signer recovery record is malformed.");
  }
  const signerKey = PrivateKey.fromStringECDSA(recovery.privateKey.slice(2));
  const signerAddress = `0x${signerKey.publicKey.toEvmAddress()}`;
  if (signerAddress.toLowerCase() !== recovery.evmAddress?.toLowerCase()) {
    throw new Error("The recovery signer key and address disagree.");
  }
  await confirmMirrorAccountIdentity({
    mirrorOrigin: MIRROR,
    accountId: sourceAccountId,
    evmAddress: source.address,
  });
  await confirmMirrorAccountIdentity({
    mirrorOrigin: MIRROR,
    accountId: signerAccountId,
    evmAddress: signerAddress,
  });
  await sweepControlledToken(client, signerKey, signerAccountId, tokenId);
  await returnRemainingHbar(client, signerKey, signerAccountId);
  console.log(
    `The controlled test token still names ${signerAccountId} as treasury. Its private recovery file remains at ${signerPath}.`,
  );
}

async function runLifecycle(client, source) {
  if (mode === "usdc") {
    if (!credentials.PYTH_API_KEY?.trim()) {
      throw new Error("PYTH_API_KEY is required for the Circle USDC profile.");
    }
    assertCircleUsdcPreflight(
      await circleMetadata(),
      await circleRelationship(sourceAccountId),
    );
  }

  const sourceMirror = await confirmMirrorAccountIdentity({
    mirrorOrigin: MIRROR,
    accountId: sourceAccountId,
    evmAddress: source.address,
  });
  if (sourceMirror.balanceTinybar < 250n * 100_000_000n) {
    throw new Error(
      "The operator needs at least 250 HBAR to fund a capped signer and fees.",
    );
  }

  const signerKey = PrivateKey.generateECDSA();
  const recoveryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "rwa-hts-signer-"),
  );
  await chmod(recoveryDirectory, 0o700);
  const recoveryPath = path.join(recoveryDirectory, "signer.json");
  const accountIdPath = path.join(recoveryDirectory, "account-id.txt");
  await writeFile(
    recoveryPath,
    JSON.stringify({
      network: "testnet",
      evmAddress: `0x${signerKey.publicKey.toEvmAddress()}`,
      privateKey: `0x${signerKey.toStringRaw()}`,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    `Temporary signer recovery material is private at ${recoveryDirectory}.`,
  );

  let signerAccountId;
  let swept = false;
  let hbarReturned = false;
  let childSucceeded = false;
  try {
    const response = await new AccountCreateTransaction()
      .setECDSAKeyWithAlias(signerKey)
      .setInitialBalance(new Hbar(CAPPED_HBAR))
      .execute(client);
    signerAccountId = (await response.getReceipt(client)).accountId?.toString();
    if (!/^0\.0\.\d+$/u.test(signerAccountId ?? "")) {
      throw new Error("The capped signer creation returned no account ID.");
    }
    await writeFile(accountIdPath, `${signerAccountId}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      `Created capped signer ${signerAccountId} with ${CAPPED_HBAR} HBAR.`,
    );

    if (mode === "usdc") {
      const tokenId = TokenId.fromString(CIRCLE_TESTNET_USDC_TOKEN_ID);
      const association = await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(signerAccountId))
        .setTokenIds([tokenId])
        .freezeWith(client);
      await (
        await (await association.sign(signerKey)).execute(client)
      ).getReceipt(client);
      const amount = HTS_ACTOR_TOKEN_UNITS * 2n;
      await (
        await new TransferTransaction()
          .addTokenTransfer(tokenId, sourceAccountId, -Number(amount))
          .addTokenTransfer(tokenId, signerAccountId, Number(amount))
          .execute(client)
      ).getReceipt(client);
      await waitForCircleBalance(signerAccountId, amount);
      console.log(
        `Provisioned ${Number(amount) / 1_000_000} Circle testnet USDC to the capped signer.`,
      );
    }

    await confirmMirrorAccountIdentity({
      mirrorOrigin: MIRROR,
      accountId: signerAccountId,
      evmAddress: `0x${signerKey.publicKey.toEvmAddress()}`,
    });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/demo-testnet-hts.mjs", `--profile=${mode}`],
      {
        cwd: foundryRoot,
        stdio: "inherit",
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          HEDERA_NETWORK: "testnet",
          HARNESS_SIGNER_ACCOUNT_ID: signerAccountId,
          HARNESS_SIGNER_EVM_ADDRESS: `0x${signerKey.publicKey.toEvmAddress()}`,
          HARNESS_SIGNER_PRIVATE_KEY: `0x${signerKey.toStringRaw()}`,
          ...(mode === "usdc"
            ? { PYTH_API_KEY: credentials.PYTH_API_KEY }
            : {}),
        },
      },
    );
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) {
      throw new Error(
        `The ${mode} lifecycle exited without a verified candidate.`,
      );
    }
    childSucceeded = true;
  } finally {
    if (signerAccountId) {
      try {
        if (mode === "controlled") {
          const tokenId = childSucceeded
            ? undefined
            : await discoverControlledTokenId(signerAccountId);
          if (childSucceeded || tokenId) {
            await sweepControlledToken(
              client,
              signerKey,
              signerAccountId,
              tokenId,
            );
          }
        }
        if (mode === "usdc") {
          const tokenBalance = await waitForCircleBalance(signerAccountId, 0n);
          if (tokenBalance > 0n) {
            const transfer = await new TransferTransaction()
              .addTokenTransfer(
                CIRCLE_TESTNET_USDC_TOKEN_ID,
                signerAccountId,
                -Number(tokenBalance),
              )
              .addTokenTransfer(
                CIRCLE_TESTNET_USDC_TOKEN_ID,
                sourceAccountId,
                Number(tokenBalance),
              )
              .freezeWith(client);
            await (
              await (await transfer.sign(signerKey)).execute(client)
            ).getReceipt(client);
          }
        }
        const deleteTransaction = await new AccountDeleteTransaction()
          .setAccountId(AccountId.fromString(signerAccountId))
          .setTransferAccountId(AccountId.fromString(sourceAccountId))
          .freezeWith(client);
        await (
          await (await deleteTransaction.sign(signerKey)).execute(client)
        ).getReceipt(client);
        swept = true;
        console.log(
          `Swept capped signer ${signerAccountId} back to the operator.`,
        );
      } catch {
        if (mode === "controlled") {
          try {
            await returnRemainingHbar(client, signerKey, signerAccountId);
            hbarReturned = true;
          } catch {
            console.error(
              `HBAR return needs manual recovery from ${recoveryPath}.`,
            );
          }
        }
        if (!hbarReturned) {
          console.error(`Sweep needs manual recovery from ${recoveryPath}.`);
        }
      }
    }
    if (swept) {
      await unlink(recoveryPath);
      await unlink(accountIdPath);
      await rmdir(recoveryDirectory);
    } else {
      const reason = hbarReturned
        ? "The controlled token treasury remains on the capped signer."
        : "The capped signer may still hold funds.";
      console.error(
        `${reason} Private recovery file retained at ${recoveryPath}.`,
      );
    }
    if (!childSucceeded) console.error("No HTS lifecycle claim was published.");
  }
}

if (
  !["prepare-usdc", "controlled", "usdc", "recover-controlled"].includes(mode)
) {
  throw new Error(
    "Choose prepare-usdc, controlled, usdc, or recover-controlled.",
  );
}
const source = requireSource();
const client = Client.forTestnet().setOperator(
  AccountId.fromString(sourceAccountId),
  source.key,
);
try {
  if (mode === "recover-controlled") {
    await recoverControlled(client, source);
  } else if (mode === "prepare-usdc") {
    await confirmMirrorAccountIdentity({
      mirrorOrigin: MIRROR,
      accountId: sourceAccountId,
      evmAddress: source.address,
    });
    await prepareUsdc(client);
  } else await runLifecycle(client, source);
} finally {
  client.close();
}
