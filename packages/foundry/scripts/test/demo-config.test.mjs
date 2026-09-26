import assert from "node:assert/strict";
import test from "node:test";
import { PYTH_ADDRESS } from "@collateral-rail/shared/hedera";
import { readDemoConfiguration } from "../lib/demo-config.ts";
import { DEFAULT_HERMES_URL } from "../lib/evidence-lib.mjs";

const signerEnvironment = {
  HARNESS_SIGNER_ACCOUNT_ID: "0.0.123",
  HARNESS_SIGNER_EVM_ADDRESS: `0x${"1".repeat(40)}`,
  HARNESS_SIGNER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
};

test("evidence runner defaults to HIP-475 and ignores Pyth-only inputs", () => {
  const configuration = readDemoConfiguration(
    {
      ...signerEnvironment,
      PYTH_ADDRESS: "not-an-address",
      PYTH_HERMES_URL: "https://attacker.invalid",
    },
    [],
  );

  assert.equal(configuration.oracleKind, "hedera-exchange-rate");
  assert.equal(configuration.hermesUrl, DEFAULT_HERMES_URL);
  assert.equal(configuration.pyth, PYTH_ADDRESS);
  assert.equal(configuration.pythApiKey, null);
});

test("Pyth mode is explicit and fails closed on its credentials and endpoint", () => {
  assert.throws(
    () =>
      readDemoConfiguration(
        { ...signerEnvironment, DEMO_ORACLE_KIND: "pyth" },
        [],
      ),
    /PYTH_API_KEY/,
  );

  assert.throws(
    () =>
      readDemoConfiguration(
        {
          ...signerEnvironment,
          DEMO_ORACLE_KIND: "pyth",
          PYTH_API_KEY: "test-only-key",
          PYTH_HERMES_URL: "https://attacker.invalid",
        },
        [],
      ),
    /allowlist/,
  );
});
