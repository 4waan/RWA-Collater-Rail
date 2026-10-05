import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const manifest = JSON.parse(
  await readFile("packages/foundry/abi/clpr-upstream.json", "utf8"),
);
const localRoot = process.env.CLPR_UPSTREAM_ROOT;
const allowedHosts = new Set(["raw.githubusercontent.com"]);
const maximumBytes = 2 * 1024 * 1024;

async function readPinnedFile(repository, file) {
  if (localRoot) {
    return readFile(path.join(localRoot, repository, file));
  }

  const entry = manifest.repositories[repository];
  const repositoryName = new URL(entry.url).pathname.replace(/^\//u, "");
  const url = new URL(
    `https://raw.githubusercontent.com/${repositoryName}/${entry.commit}/${file}`,
  );
  if (!allowedHosts.has(url.hostname)) throw new Error("Unapproved CLPR host.");

  const response = await fetch(url, {
    headers: { Accept: "text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${repository}/${file} returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maximumBytes)
    throw new Error("CLPR source is too large.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error(`${repository}/${file} has an invalid size.`);
  }
  return bytes;
}

let checked = 0;
for (const [repository, entry] of Object.entries(manifest.repositories)) {
  if (!/^[0-9a-f]{40}$/u.test(entry.commit)) {
    throw new Error(`${repository} is not pinned to a full commit.`);
  }
  for (const [file, expectedDigest] of Object.entries(entry.files)) {
    const bytes = await readPinnedFile(repository, file);
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new Error(`Pinned CLPR digest changed for ${repository}/${file}.`);
    }
    checked += 1;
  }
}

console.log(
  `${checked} pinned CLPR files across ${Object.keys(manifest.repositories).length} repositories are verified.`,
);
