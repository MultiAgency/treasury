// The owner UI on a fresh simulated stack (the platform at 1a7fe98) that serves this build: `pnpm test:stack`.
// The stack's browser starts the owner signed in; these tests attach to it over CDP, as the platform's specs' clients do.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { setUnavailable, startStack, type Stack } from "../../scripts/stack.ts";

let stop: () => Promise<void>, target: Stack, browser: Browser, owner: BrowserContext, home: Page, dashboard: string, account: string;

before(async () => {
  const started = await startStack({ args: ["--frontend", join(import.meta.dirname, "..", "dist")] });
  stop = started.stop;
  target = started.target;
  const state = started.state();
  dashboard = state.dashboard;
  account = state.ownerAccount;
  browser = await chromium.connectOverCDP(state.cdp!);
  // An attached client's own connection must accept the stack's local certificate (the platform's docs/testing.md).
  await (await browser.newBrowserCDPSession()).send("Security.setIgnoreCertificateErrors", { ignore: true });
  // The owner's context is the one whose page the stack signed in.
  // The owner's page is the one the stack signed in at /a/payout/ (the payee's is the invoice page).
  home = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(`${dashboard}/a/payout/`))!;
  assert.ok(home, "the stack's owner page");
  owner = home.context();
  const viewer = await home.evaluate(async () => (await (await fetch("/gw/me")).json()).viewer?.account ?? null);
  assert.equal(viewer, account, `the stack's owner page is signed in (it shows: ${(await home.locator("body").innerText()).slice(0, 300)})`);
}, { timeout: 180_000 });

after(async () => {
  await browser?.close().catch(() => {});
  await stop?.();
});

/**
 * A second tab of the owner's session, opened from the stack's signed-in page as a person would. It shares the session
 * cookie but not the stack's test wallet, which only the stack's own page has: wallet steps happen in `home`.
 */
const tab = async (path: string) => {
  const [page] = await Promise.all([owner.waitForEvent("page"), home.evaluate(url => { window.open(url); }, `${dashboard}${path}`)]);
  await page.waitForLoadState();
  return page;
};
const visible = (locator: ReturnType<Page["getByRole"]>) => locator.waitFor({ state: "visible", timeout: 15_000 });

test("signed in, the Treasury's frame shows its owner, the wallet and the page asked for", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("region", { name: "Treasury owner" }));
  assert.match(await home.getByRole("region", { name: "Treasury owner" }).innerText(), new RegExp(account.replaceAll(".", "\\.")));
  await visible(home.getByRole("button", { name: `Wallet: ${account}`, exact: true }));
  assert.equal(await home.title(), "Treasury · Overview");
  assert.equal(await home.getByRole("link", { name: "Back to overview" }).count(), 0, "the overview has no way back to itself");

  await home.goto(`${dashboard}/a/portfolio/automations`);
  await visible(home.getByRole("link", { name: "Back to overview" }));
  assert.equal(await home.title(), "Treasury · Strategy");

  await home.goto(`${dashboard}/a/portfolio/treasury`);
  await home.waitForURL(`${dashboard}/a/portfolio/funding`);
});

test("the host's root opens the account's treasury; another area's agent isn't shown", async () => {
  await home.goto(`${dashboard}/`);
  await home.waitForURL(`${dashboard}/a/portfolio/`);
  await home.goto(`${dashboard}/a/payout/`);
  await visible(home.getByRole("heading", { name: "Treasury unavailable", exact: true }));
});

test("disconnecting the wallet signs out this tab and the others; connecting signs in again", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  const other = await tab("/a/portfolio/funding");
  await visible(other.getByRole("region", { name: "Treasury owner" }));

  await home.getByRole("button", { name: `Wallet: ${account}`, exact: true }).click();
  await home.getByRole("menuitem", { name: "Disconnect" }).click();
  await home.waitForURL(`${dashboard}/`);
  await visible(home.getByRole("heading", { name: /Your treasury/ }));
  // The other tab hears of it and rereads its session at once: nothing of the owner's stays on screen.
  await visible(other.getByRole("button", { name: "Connect wallet", exact: true }).first());
  assert.equal(await other.getByRole("region", { name: "Treasury owner" }).count(), 0);
  await other.close();

  const reloaded = home.waitForEvent("load");
  await home.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
  const chooser = home.getByText("Local test wallet", { exact: true });
  await Promise.race([reloaded, chooser.waitFor({ timeout: 15_000 }).then(() => chooser.click()).catch(() => {})]);
  await reloaded;
  await home.waitForURL(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("region", { name: "Treasury owner" }));
});

/** axe's WCAG 2.x A and AA rules, at any impact: a violation is a defect, not a warning. Best-practice rules aren't run. */
const axe = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);

test("no axe violations on the signed-out page or the signed-in frame", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("region", { name: "Treasury owner" }));
  assert.deepEqual(await axe(home), []);
  // A page this connection opens has no session: the signed-out page.
  const signedOut = await owner.newPage();
  await signedOut.goto(`${dashboard}/`);
  await visible(signedOut.getByRole("button", { name: "Connect wallet", exact: true }).first());
  assert.deepEqual(await axe(signedOut), []);
  await signedOut.close();
});

test("by keyboard: the skip link reaches the page, and the wallet menu opens and closes", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("region", { name: "Treasury owner" }));
  await home.keyboard.press("Tab");
  assert.equal(await home.evaluate(() => document.activeElement?.textContent), "Skip to main content");
  await home.keyboard.press("Enter");
  assert.equal(await home.evaluate(() => document.activeElement?.id), "agent-main");

  const wallet = home.getByRole("button", { name: `Wallet: ${account}`, exact: true });
  await wallet.focus();
  await home.keyboard.press("Enter");
  await visible(home.getByRole("menuitem", { name: "Disconnect" }));
  await home.keyboard.press("Escape");
  await home.getByRole("menuitem", { name: "Disconnect" }).waitFor({ state: "hidden" });
  assert.equal(await home.evaluate(() => document.activeElement?.getAttribute("aria-label")), `Wallet: ${account}`, "focus returns to the wallet button");
});

test("an outage of the agent's provider: setup is unavailable, and Retry setup recovers once it ends", async () => {
  await setUnavailable(target, true);
  try {
    await home.goto(`${dashboard}/a/portfolio/`);
    // The owner session still grants the agent; its setup read is the provider's refusal.
    await visible(home.getByRole("heading", { name: "Available records", exact: true }));
    await visible(home.getByRole("alert").filter({ hasText: "Setup unavailable" }));
    assert.equal(await home.getByRole("region", { name: "Treasury owner" }).count(), 0, "nothing unconfirmed is shown");
  } finally {
    await setUnavailable(target, false);
  }
  await home.getByRole("button", { name: "Retry setup" }).click();
  await visible(home.getByRole("region", { name: "Treasury owner" }));
});
