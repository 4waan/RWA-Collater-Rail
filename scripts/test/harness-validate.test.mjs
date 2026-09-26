import assert from "node:assert/strict";
import test from "node:test";
import { harnessSpec } from "../harness-validate.mjs";

test("Harness selects source and generated validation contracts explicitly", () => {
  assert.equal(harnessSpec(true), ".harness/spec.yaml");
  assert.equal(harnessSpec(false), ".harness/generated-spec.yaml");
});
