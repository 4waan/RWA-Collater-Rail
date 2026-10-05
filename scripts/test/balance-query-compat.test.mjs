import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the v0.77 guard covers removed balance-query entry points", async () => {
  const source = await readFile(
    "scripts/check-balance-query-compat.mjs",
    "utf8",
  );

  assert.match(
    source,
    new RegExp(["Account", "Balance", "Query"].join(""), "u"),
  );
  assert.match(source, new RegExp(["getAccount", "Balance"].join(""), "u"));
  assert.match(source, /pingAll/u);
  assert.match(source, /2\.88\.0/u);
});
