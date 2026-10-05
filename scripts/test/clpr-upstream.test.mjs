import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CLPR compatibility pins full commits and explicit support boundaries", async () => {
  const manifest = JSON.parse(
    await readFile("packages/foundry/abi/clpr-upstream.json", "utf8"),
  );

  for (const repository of Object.values(manifest.repositories)) {
    assert.match(repository.commit, /^[0-9a-f]{40}$/u);
    assert.ok(Object.keys(repository.files).length > 0);
  }
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(
    manifest.observedPaths.soloToBesu,
    "not-demonstrated-proof-service-unavailable",
  );
});
