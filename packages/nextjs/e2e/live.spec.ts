import { expect, test, type Page } from "@playwright/test";

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RAIL = "0x1111111111111111111111111111111111111111";
const TRANSACTION_HASH = `0x${"9".repeat(64)}`;
const BLOCK_HASH = `0x${"8".repeat(64)}`;

type ProviderOptions = {
  account?: string;
  chainId?: number;
  rejectWrites?: boolean;
};

async function installProvider(page: Page, options: ProviderOptions = {}) {
  await page.addInitScript(
    ({ account, chainId, rejectWrites, transactionHash }) => {
      let activeChain = chainId;
      let connected = false;
      let accounts = [account];
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

      function emit(event: string, value: unknown) {
        for (const listener of listeners.get(event) ?? []) listener(value);
      }

      const provider = {
        isMetaMask: true,
        on(event: string, listener: (...args: unknown[]) => void) {
          const registered = listeners.get(event) ?? new Set();
          registered.add(listener);
          listeners.set(event, registered);
          return provider;
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
          return provider;
        },
        async request({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_chainId") return `0x${activeChain.toString(16)}`;
          if (method === "eth_accounts") return connected ? accounts : [];
          if (method === "eth_requestAccounts") {
            connected = true;
            emit("accountsChanged", accounts);
            return accounts;
          }
          if (method === "wallet_switchEthereumChain") {
            const requested = params?.[0] as { chainId?: string } | undefined;
            activeChain = Number.parseInt(requested?.chainId ?? "0x0", 16);
            emit("chainChanged", `0x${activeChain.toString(16)}`);
            return null;
          }
          if (method === "wallet_revokePermissions") {
            connected = false;
            emit("accountsChanged", []);
            return null;
          }
          if (method === "eth_sendTransaction") {
            if (rejectWrites) {
              const error = new Error("User rejected the request") as Error & {
                code: number;
              };
              error.code = 4001;
              throw error;
            }
            return transactionHash;
          }
          throw new Error(`Unsupported test wallet method: ${method}`);
        },
        setAccounts(next: string[]) {
          connected = true;
          accounts = next;
          emit("accountsChanged", accounts);
        },
        setChain(next: number) {
          activeChain = next;
          emit("chainChanged", `0x${activeChain.toString(16)}`);
        },
      };

      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: provider,
      });
      Object.defineProperty(window, "__collateralTestProvider", {
        configurable: true,
        value: provider,
      });
    },
    {
      account: options.account ?? ACCOUNT_A,
      chainId: options.chainId ?? 296,
      rejectWrites: options.rejectWrites ?? false,
      transactionHash: TRANSACTION_HASH,
    },
  );
}

async function connectWallet(page: Page) {
  await page.goto("/facility?recipe=term-credit&mode=live");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText(new RegExp(ACCOUNT_A, "i"))).toBeVisible();
}

async function openApprovalStep(page: Page, borrower = ACCOUNT_A) {
  await page.getByRole("button", { name: /Set terms/i }).click();
  await page.getByLabel("Borrower address").fill(borrower);
  await page.getByRole("button", { name: "Apply terms" }).click();
  await page.getByRole("button", { name: /Approve and lock/i }).click();
}

async function mockReceipt(page: Page, status: "0x0" | "0x1") {
  await page.route("https://testnet.hashio.io/api", async (route) => {
    const payload = route.request().postDataJSON() as {
      id: number;
      method: string;
    };
    let result: unknown;
    if (payload.method === "eth_getTransactionReceipt") {
      result = {
        blockHash: BLOCK_HASH,
        blockNumber: "0x1",
        contractAddress: null,
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        from: ACCOUNT_A,
        gasUsed: "0x5208",
        logs: [],
        logsBloom: `0x${"0".repeat(512)}`,
        status,
        to: RAIL,
        transactionHash: TRANSACTION_HASH,
        transactionIndex: "0x0",
        type: "0x2",
      };
    } else if (payload.method === "eth_blockNumber") {
      result = "0x1";
    } else if (payload.method === "eth_chainId") {
      result = "0x128";
    } else {
      result = null;
    }
    await route.fulfill({
      body: JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }),
      contentType: "application/json",
    });
  });
}

test("@live exposes Pyth controls only when Pyth is explicitly configured", async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page);
  await connectWallet(page);
  await page.getByRole("button", { name: /Price and fund/i }).click();
  await expect(
    page.getByText(/Pyth converts the USD cash terms into exact tinybar/),
  ).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.getByRole("button", { name: "Update Pyth" })).toBeVisible();
  const response = await page.request.get("/");
  expect(response.headers()["content-security-policy"]).toContain(
    "https://hermes.pyth.network",
  );
});

test("@live blocks writes on the wrong chain and switches explicitly", async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page);
  await connectWallet(page);
  await page.evaluate(() => {
    const provider = (
      window as typeof window & {
        __collateralTestProvider: { setChain: (next: number) => void };
      }
    ).__collateralTestProvider;
    provider.setChain(295);
  });
  await expect(page.getByText("Wrong network.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch to testnet" }).click();
  await expect(page.getByText("Wrong network.", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Live testnet", { exact: true })).toBeVisible();
});

test("@live keeps the borrower action disabled until actors match", async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page);
  await connectWallet(page);
  await openApprovalStep(page, ACCOUNT_B);
  const approve = page.getByRole("button", { name: "Approve ATS collateral" });
  await expect(approve).toBeDisabled();
  await page.evaluate((account) => {
    const provider = (
      window as typeof window & {
        __collateralTestProvider: { setAccounts: (next: string[]) => void };
      }
    ).__collateralTestProvider;
    provider.setAccounts([account]);
  }, ACCOUNT_B);
  await expect(approve).toBeEnabled();
});

test("@live rejected signatures never confirm or advance", async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page, { rejectWrites: true });
  await connectWallet(page);
  await openApprovalStep(page);
  await page.getByRole("button", { name: "Approve ATS collateral" }).click();
  await expect(page.getByText(/wallet signature was rejected/i)).toBeVisible();
  await expect(page.locator('.actionState[data-state="error"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve ATS collateral" }),
  ).toBeVisible();
});

test("@live advances an action only after a successful mined receipt", async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page);
  await mockReceipt(page, "0x1");
  await connectWallet(page);
  await openApprovalStep(page);
  await page.getByRole("button", { name: "Approve ATS collateral" }).click();
  await expect(page.locator('.actionState[data-state="success"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByRole("button", { name: "Accept and lock collateral" }),
  ).toBeVisible();
});

test("@live reverted receipts remain failed workflow actions", async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_LIVE_FIXTURE !== "1");
  await installProvider(page);
  await mockReceipt(page, "0x0");
  await connectWallet(page);
  await openApprovalStep(page);
  await page.getByRole("button", { name: "Approve ATS collateral" }).click();
  await expect(page.locator('.actionState[data-state="error"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/transaction reverted/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve ATS collateral" }),
  ).toBeVisible();
});
