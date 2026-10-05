import assert from "node:assert/strict";
import test from "node:test";
import { TokenId } from "@hiero-ledger/sdk";

test("pinned Hiero SDK resolves token IDs to EVM addresses", () => {
  assert.equal(
    `0x${TokenId.fromString("0.0.429274").toEvmAddress()}`,
    "0x0000000000000000000000000000000000068cda",
  );
});
