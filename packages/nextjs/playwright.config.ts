import { defineConfig, devices } from "@playwright/test";

const port = 3210;
const baseURL = `http://127.0.0.1:${port}`;
const serverMode = process.env.PLAYWRIGHT_SERVER_MODE;
const liveFixture = process.env.PLAYWRIGHT_LIVE_FIXTURE === "1";
const serverEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);

if (serverMode && serverMode !== "development" && serverMode !== "production") {
  throw new Error(
    "PLAYWRIGHT_SERVER_MODE must be development or production when provided.",
  );
}

const serverCommand =
  serverMode === "production"
    ? `yarn start -p ${port} -H 127.0.0.1`
    : `yarn dev -p ${port} -H 127.0.0.1`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.02,
    },
  },
  snapshotPathTemplate: "{testDir}/snapshots/{testFilePath}/{arg}{ext}",
  webServer: {
    command: serverCommand,
    env: liveFixture
      ? {
          ...serverEnvironment,
          NEXT_PUBLIC_ATS_TOKEN_ADDRESS:
            "0x2222222222222222222222222222222222222222",
          NEXT_PUBLIC_ORACLE_ADDRESS:
            "0x3333333333333333333333333333333333333333",
          NEXT_PUBLIC_ORACLE_KIND: "pyth",
          NEXT_PUBLIC_RAIL_ADDRESS:
            "0x1111111111111111111111111111111111111111",
        }
      : serverEnvironment,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
