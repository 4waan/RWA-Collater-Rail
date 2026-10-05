import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["packages", "scripts"];
const checkedExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set([
  ".next",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const forbiddenPatterns = [
  { expression: /\bAccountBalanceQuery\b/u, label: "AccountBalanceQuery" },
  { expression: /\.getAccountBalance\s*\(/u, label: "getAccountBalance" },
  { expression: /\.(?:ping|pingAll)\s*\(/u, label: "Client ping helper" },
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(candidate)));
    } else if (checkedExtensions.has(path.extname(entry.name))) {
      files.push(candidate);
    }
  }

  return files;
}

const violations = [];
for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    if (file.endsWith("check-balance-query-compat.mjs")) continue;
    const source = await readFile(file, "utf8");
    for (const { expression, label } of forbiddenPatterns) {
      if (expression.test(source)) violations.push(`${file}: ${label}`);
    }
  }
}

const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
const foundryManifest = JSON.parse(
  await readFile("packages/foundry/package.json", "utf8"),
);
const expectedSdkVersion = "2.88.0";
const versions = new Set([
  rootManifest.devDependencies?.["@hiero-ledger/sdk"],
  foundryManifest.devDependencies?.["@hiero-ledger/sdk"],
]);

if (versions.size !== 1 || !versions.has(expectedSdkVersion)) {
  violations.push(
    `@hiero-ledger/sdk must be pinned to ${expectedSdkVersion} in both manifests`,
  );
}

if (violations.length > 0) {
  throw new Error(
    `Consensus Node v0.77 balance-query compatibility failed:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`,
  );
}

console.log(
  `Consensus Node v0.77 compatibility verified with @hiero-ledger/sdk ${expectedSdkVersion} and no consensus balance-query call sites.`,
);
