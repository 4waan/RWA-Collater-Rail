import assert from "node:assert/strict";
import test from "node:test";
import {
  toMirrorEvmBaseTransactionPath,
  toMirrorNativeTransactionId,
} from "../lib/native-transaction-id.mjs";

test("native transaction IDs use Mirror's hyphenated REST path", () => {
  assert.equal(
    toMirrorNativeTransactionId("0.0.10861992@1791145999.575232278"),
    "0.0.10861992-1791145999-575232278",
  );
});

test("malformed native transaction IDs cannot reach Mirror", () => {
  for (const value of [
    "0.0.1@1.1",
    "0.0.1@1.000000001?scheduled",
    "0.0.1-1-000000001",
    "0.0.1@1.000000001/path",
  ]) {
    assert.throws(() => toMirrorNativeTransactionId(value));
  }
});

test("EVM contract results bind to a base transaction by exact timestamp", () => {
  assert.equal(
    toMirrorEvmBaseTransactionPath("1791147559.911615104"),
    "/api/v1/transactions?timestamp=1791147559.911615104",
  );
  assert.throws(() => toMirrorEvmBaseTransactionPath("0x1234"));
});
