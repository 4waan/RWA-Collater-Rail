import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile("packages/shared/src/hedera.ts", "utf8");
const atsSurface = JSON.parse(
  await readFile("packages/foundry/abi/ats-v8-required.json", "utf8"),
);

function readStringConstant(name) {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!match) throw new Error(`Missing ${name} in the shared Hedera config.`);
  return match[1];
}

function readNumberConstant(name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
  if (!match) throw new Error(`Missing ${name} in the shared Hedera config.`);
  return Number(match[1]);
}

const rpcUrl = readStringConstant("HEDERA_TESTNET_RPC_URL");
const chainId = readNumberConstant("HEDERA_TESTNET_CHAIN_ID");
const dependencies = {
  "ATS Factory": readStringConstant("ATS_FACTORY_ADDRESS"),
  "ATS Resolver": readStringConstant("ATS_RESOLVER_ADDRESS"),
  "Optional Pyth": readStringConstant("PYTH_ADDRESS"),
};
const exchangeRateSystem = "0x0000000000000000000000000000000000000168";
const oneHbarInTinybar =
  "0000000000000000000000000000000000000000000000000000000005f5e100";
const tinybarsToTinycentsSelector = "43a88229";

const parsedRpcUrl = new URL(rpcUrl);
if (
  parsedRpcUrl.protocol !== "https:" ||
  parsedRpcUrl.origin !== "https://testnet.hashio.io" ||
  parsedRpcUrl.pathname !== "/api"
) {
  throw new Error("The compatibility RPC endpoint is outside the allowlist.");
}

let nextRequestId = 1;

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRequestId++,
      method,
      params,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Hedera RPC returned HTTP ${response.status}.`);
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 262_144) {
    throw new Error("Hedera RPC response exceeded the size limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 262_144) {
    throw new Error("Hedera RPC response exceeded the size limit.");
  }

  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !payload ||
    payload.jsonrpc !== "2.0" ||
    payload.id !== nextRequestId - 1 ||
    payload.error ||
    typeof payload.result !== "string"
  ) {
    throw new Error(`Invalid Hedera RPC response for ${method}.`);
  }

  return payload.result;
}

const reportedChainId = Number.parseInt(await rpc("eth_chainId", []), 16);
if (reportedChainId !== chainId) {
  throw new Error(
    `Hedera RPC chain ID ${reportedChainId} did not match ${chainId}.`,
  );
}

for (const [name, address] of Object.entries(dependencies)) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error(`${name} is not a valid EVM address.`);
  }
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
    throw new Error(`${name} has no contract bytecode at ${address}.`);
  }
}

const exchangeRateResult = await rpc("eth_call", [
  {
    to: exchangeRateSystem,
    data: `0x${tinybarsToTinycentsSelector}${oneHbarInTinybar}`,
  },
  "latest",
]);
if (
  !/^0x[0-9a-f]{64}$/i.test(exchangeRateResult) ||
  BigInt(exchangeRateResult) <= 0n
) {
  throw new Error("HIP-475 returned an invalid HBAR settlement conversion.");
}

for (const [file, expectedDigest] of Object.entries(atsSurface.sourceFiles)) {
  const url = new URL(
    `https://raw.githubusercontent.com/hashgraph/asset-tokenization-studio/${atsSurface.upstreamCommit}/${file}`,
  );
  const response = await fetch(url, {
    headers: { Accept: "text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Pinned ATS source returned HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 262_144) {
    throw new Error("Pinned ATS source has an invalid response size.");
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(`Pinned ATS source digest changed for ${file}.`);
  }
}

console.log(
  `Hedera testnet chain ${chainId}, HIP-475, ${Object.keys(dependencies).length} deployed dependencies, and ${Object.keys(atsSurface.sourceFiles).length} pinned ATS sources are verified.`,
);
