import { expect, test } from "@playwright/test";

test("home presents one promise, one recipe, and one proof frame", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Finance ATS securities on Hedera.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Reference mode", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No wallet required", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Maturity Bridge" }).click();
  await expect(
    page.getByRole("heading", { name: "Maturity Bridge" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open this blueprint" }),
  ).toHaveAttribute("href", "/facility?recipe=maturity-bridge&mode=reference");
  await expect(
    page.getByRole("heading", { name: "Every claim has a source." }),
  ).toBeVisible();
  await expect(
    page.getByText("hss observed on testnet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Verified Hedera testnet lifecycle. Invariant and Harness gated. No independent production audit. Never expose operator keys.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Unaudited testnet software.")).toHaveCount(0);
});

test("facility expands only one lifecycle step", async ({ page }) => {
  await page.goto("/facility?recipe=term-credit&mode=reference");
  await expect(
    page.getByRole("heading", { name: "One obligation, step by step." }),
  ).toBeVisible();
  await expect(page.locator('.facilityStep[data-active="true"]')).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: /Choose recipe/i }),
  ).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("button", { name: /Set terms/i }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /Set terms/i })).toBeFocused();

  await page.getByRole("button", { name: "Live wallet" }).click();
  await expect(page).toHaveURL(/mode=live/);
  await expect(
    page.getByText("Live addresses are not configured."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Price and fund/i }).click();
  const activeStep = page.locator('.facilityStep[data-active="true"]');
  await expect(activeStep.locator(".stepHeading small")).toBeVisible();
  await expect(activeStep.locator(".stepHeading small")).toHaveText(
    "Funding lender",
  );
  await expect(activeStep.locator(".primaryButton")).toHaveCount(1);
});

test("facility preserves only validated workflow identifiers", async ({
  page,
}) => {
  const offer = `0x${"1".repeat(64)}`;
  const position = `0x${"2".repeat(64)}`;
  await page.goto(
    `/facility?recipe=term-credit&mode=reference&offer=${offer}&position=${position}&terminal=settle`,
  );
  await page.getByRole("button", { name: /Repay or settle/i }).click();
  await expect(
    page.getByRole("button", { name: "Default path" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Live wallet" }).click();
  const url = new URL(page.url());
  expect(url.searchParams.get("recipe")).toBe("term-credit");
  expect(url.searchParams.get("mode")).toBe("live");
  expect(url.searchParams.get("offer")).toBe(offer);
  expect(url.searchParams.get("position")).toBe(position);
  expect(url.searchParams.get("terminal")).toBe("settle");
});

test("verification keeps financial claims and balances distinct", async ({
  page,
}) => {
  await page.goto("/verify?position=defaulted");
  await expect(
    page.getByRole("heading", {
      name: "Follow one position from claim to source.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Defaulted position" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Free ATS balance", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Held ATS balance", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("HIP-475 settlement conversion rate", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The HBAR settlement conversion rate was read from Hedera."),
  ).toBeVisible();
  await expect(page.getByText(/Pyth adapter and Mirror receipt/)).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Cash liabilities", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("HSS reserve", { exact: true })).toBeVisible();
  await expect(
    page.getByText("State read block", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Final contract state was read at an exact block."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Dated lifecycle accounting was covered by a current Mirror balance.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Current rail balance", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("DEFAULTED via hss, observed on testnet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "HashScan was unavailable on 2026-09-27. Mirror evidence remains authoritative.",
      { exact: true },
    ),
  ).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: "Open authoritative Mirror receipt" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Open authoritative Mirror schedule" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Retry schedule on HashScan" }),
  ).toHaveCount(2);
  const scheduleProof = page.locator('[data-proof-type="schedule"]').first();
  await expect(scheduleProof).toContainText("HSS schedule");
  await expect(scheduleProof).not.toContainText("Transaction receipt");
  await expect(
    scheduleProof.getByRole("link", {
      name: "Open authoritative Mirror schedule",
    }),
  ).toHaveAttribute(
    "href",
    "https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10730732",
  );
});

test("shareable recipe state and mobile layout remain bounded", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/facility?recipe=maturity-bridge&mode=reference");
  await expect(page.getByLabel("Financing recipe")).toHaveValue(
    "maturity-bridge",
  );
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasOverflow).toBe(false);
  await expect(page.locator('.facilityStep[data-active="true"]')).toHaveCount(
    1,
  );
  await expect(
    page.locator('.facilityStep[data-active="true"] .primaryButton'),
  ).toHaveCount(1);
});

test("verification rejects an empty Mirror result", async ({ page }) => {
  await page.route(
    "https://testnet.mirrornode.hedera.com/api/v1/transactions/**",
    (route) =>
      route.fulfill({
        body: JSON.stringify({ transactions: [] }),
        contentType: "application/json",
      }),
  );
  await page.goto("/verify?position=repaid");
  await page.getByText("Verify another live position").click();
  await page.getByLabel("Transaction ID or hash").fill(`0x${"a".repeat(64)}`);
  await page.getByRole("button", { name: "Query Mirror Node" }).click();
  await expect(page.getByText(/returned an empty result/i)).toBeVisible();
});

test("production security policy excludes script evaluation", async ({
  request,
}) => {
  const response = await request.get("/");
  const policy = response.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("script-src 'self' 'unsafe-inline'");
  expect(policy).not.toContain("https://hermes.pyth.network");
  if (process.env.PLAYWRIGHT_SERVER_MODE === "production") {
    expect(policy).not.toContain("unsafe-eval");
  }
});
