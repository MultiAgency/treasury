// The owner UI on a fresh simulated stack (the platform at 1a7fe98) that serves this build: `pnpm test:stack`.
// The stack's browser starts the owner signed in; these tests attach to it over CDP, as the platform's specs' clients do.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type BrowserContext, type Page } from "playwright";
import { dropSignatureResponse, dropSwapResponse, ETH, fundPublic, revealOwnerOutcome, setTargets, setUnavailable, startStack, USDC, WNEAR, type Stack } from "../../scripts/stack.ts";
import type { OwnerActionRecord, OwnerStatus, StrategyStatus } from "../src/platform.ts";


/**
 * A fresh stack serving this build, attached over CDP to the owner's page it signed in. `close` ends both.
 */
async function attach() {
  const started = await startStack({ args: ["--frontend", join(import.meta.dirname, "..", "dist")] });
  const state = started.state();
  const browser = await chromium.connectOverCDP(state.cdp!);
  const close = async () => { await browser.close().catch(() => {}); await started.stop(); };
  try {
    // An attached client's own connection must accept the stack's local certificate (the platform's docs/testing.md).
    await (await browser.newBrowserCDPSession()).send("Security.setIgnoreCertificateErrors", { ignore: true });
    // The owner's page is the one the stack signed in at /a/payout/ (the payee's is the invoice page).
    const home = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(`${state.dashboard}/a/payout/`))!;
    assert.ok(home, "the stack's owner page");
    const viewer = await home.evaluate(async () => (await (await fetch("/gw/me")).json()).viewer?.account ?? null);
    assert.equal(viewer, state.ownerAccount, `the stack's owner page is signed in (it shows: ${(await home.locator("body").innerText()).slice(0, 300)})`);
    return { target: started.target, home, dashboard: state.dashboard, account: state.ownerAccount, close };
  } catch (error) {
    await close();
    throw error;
  }
}

let close: () => Promise<void>, target: Stack, owner: BrowserContext, home: Page, dashboard: string, account: string;

before(async () => {
  ({ close, target, home, dashboard, account } = await attach());
  // The owner's context is the one whose page the stack signed in.
  owner = home.context();
}, { timeout: 180_000 });

after(async () => { await close?.(); });

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

test("the Overview shows the schedule, the book, its allocation against the target and the signed limits", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("heading", { level: 1, name: "Treasury overview", exact: true }));
  const schedule = home.getByRole("region", { name: "Schedule status" });
  await visible(schedule.getByRole("status").filter({ hasText: "Schedule: off" }));
  assert.equal(await schedule.getByRole("button", { name: "Turn off schedule" }).count(), 0, "an off schedule offers nothing to turn off");

  await visible(home.getByText("Book value", { exact: true }));
  await visible(home.getByText("Held privately", { exact: true }));
  await visible(home.getByRole("heading", { level: 2, name: "Allocation", exact: true }));
  for (const symbol of ["USDC", "wNEAR", "ETH"])
    await visible(home.getByRole("row").filter({ has: home.getByText(symbol, { exact: true }) }).first());

  await visible(home.getByRole("heading", { level: 2, name: "Signed limits", exact: true }));
  // The stack's policy signs a per-transaction cap only: every signed window is listed, not just the monthly one.
  await visible(home.getByText("Per transaction: 25 USDC", { exact: true }));
  const windows = home.getByRole("table", { name: "USD budget windows" });
  for (const period of ["Daily", "Weekly", "Monthly"]) await visible(windows.getByRole("rowheader", { name: period, exact: true }));

  await home.getByRole("navigation", { name: "Treasury tools" }).getByRole("link", { name: "Set targets and schedule" }).click();
  await home.waitForURL(`${dashboard}/a/portfolio/automations`);
});

test("the Overview reads the saved target and the book: a saved strategy and public funds show on reload", async () => {
  await setTargets(target, { [USDC]: 7000, [WNEAR]: 2000, [ETH]: 1000 });
  await home.goto(`${dashboard}/a/portfolio/`);
  const row = (symbol: string) => home.getByRole("row").filter({ has: home.getByText(symbol, { exact: true }) }).first();
  await visible(row("USDC").getByText(/· 70%/));
  await visible(row("wNEAR").getByText(/· 20%/));
  await visible(row("ETH").getByText(/· 10%/));

  const held = async () => Number((await row("USDC").getByText(/ USDC$/).innerText()).replace(/ USDC$/, ""));
  const before = await held();
  await fundPublic(target, USDC, "2500000");
  await home.reload();
  await visible(row("USDC"));
  assert.equal(await held(), before + 2.5, "2.5 USDC arrived on the public balance");
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

test("no axe violations on the signed-out page or the Overview", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("heading", { level: 1, name: "Treasury overview", exact: true }));
  await visible(home.getByRole("status").filter({ hasText: "Schedule: off" }));
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

/** One of `portfolio`'s owner procedures, called from `page` in the owner's session as the app calls it: its value. */
const rpc = async <T,>(page: Page, path: string, input?: unknown): Promise<T> => page.evaluate(async ([path, input]) => {
  const response = await fetch(`/a/portfolio/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: input }) });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()).json;
}, [path, input] as const);
const records = (page: Page) => rpc<OwnerActionRecord[]>(page, "owner/actions");
const status = (page: Page, correlationId: string) => rpc<OwnerStatus>(page, "owner/status", { correlationId });
/** Waits until `check` answers true, reading again every half second. */
const until = async (check: () => Promise<boolean>, timeout = 60_000) => {
  for (const started = Date.now(); !(await check()); await new Promise(resolve => setTimeout(resolve, 500)))
    if (Date.now() - started > timeout) throw new Error("Timed out");
};
/** The owner actions `act` records, by the records before and after it. */
const recorded = async (page: Page, act: () => Promise<void>) => {
  const before = new Set((await records(page)).map(a => a.correlationId));
  await act();
  return (await records(page)).filter(a => !before.has(a.correlationId));
};

test("freeze, then unfreeze, each signed in the owner's page and successful in owner/status", async () => {
  await home.goto(`${dashboard}/a/portfolio/policy`);
  await visible(home.getByRole("heading", { name: "Freeze the agent", exact: true }));
  assert.deepEqual(await axe(home), []);
  for (const [button, type, next] of [["Freeze", "agent_freeze", "Unfreeze the agent"], ["Unfreeze", "agent_unfreeze", "Freeze the agent"]] as const) {
    const [action, ...others] = await recorded(home, async () => {
      await home.getByRole("button", { name: button, exact: true }).click();
      await home.getByRole("heading", { name: next, exact: true }).waitFor({ timeout: 60_000 });
    });
    assert.equal(others.length, 0, "one owner action per click");
    assert.equal(action?.type, type);
    assert.deepEqual(await status(home, action!.correlationId), { stage: "submitted", status: "SUCCESS" });
    assert.equal(await home.getByRole("alert").filter({ hasText: /\S/ }).count(), 0, "no error shown");
  }
});

test("a lost signature reply: the outcome is unknown, followed in owner/status, never signed again; then it settles", async () => {
  await home.goto(`${dashboard}/a/portfolio/policy`);
  await visible(home.getByRole("heading", { name: "Freeze the agent", exact: true }));
  const sent: string[] = [], statusReads: string[] = [];
  const onRequest = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname.split("/rpc/")[1];
    if (path === "owner/prepare" || path === "owner/submit") sent.push(path);
    if (path === "owner/status") statusReads.push(path);
  };
  home.on("request", onRequest);
  try {
    await dropSignatureResponse(target);
    const before = new Set((await records(home)).map(a => a.correlationId));
    await home.getByRole("button", { name: "Freeze", exact: true }).click();
    await visible(home.getByRole("status").filter({ hasText: "The outcome is unknown: this owner/submit request may have taken effect." }));
    const freeze = home.getByRole("button", { name: "Freeze", exact: true });
    assert.equal(await freeze.isDisabled(), true, "no second signature is offered");
    const [action] = (await records(home)).filter(a => !before.has(a.correlationId));
    assert.equal(action?.type, "agent_freeze");
    assert.equal(action.stage, "submitted");
    assert.deepEqual(await status(home, action.correlationId), { stage: "submitting" });
    await until(async () => statusReads.length > 0);
    assert.deepEqual(await axe(home), []);

    // Another page of the session, after a reload, offers no signature either while the record says submitted.
    const other = await tab("/a/portfolio/policy");
    await visible(other.getByRole("status").filter({ hasText: "An earlier freeze was submitted and its outcome is still being checked. Do not sign again." }));
    // The provider may already show the agent frozen: neither freezing nor unfreezing is offered.
    assert.equal(await other.getByRole("button", { name: /^(connect to )?(un)?freeze$/i }).isDisabled(), true);
    await other.goto(`${dashboard}/a/portfolio/activity`);
    await visible(other.getByText("Submission attempted—checking the existing owner action’s outcome. Do not sign again."));
    assert.deepEqual(await axe(other), []);
    await other.close();

    await revealOwnerOutcome(target);
    await until(async () => (await status(home, action.correlationId)).stage === "submitted");
    assert.deepEqual(await status(home, action.correlationId), { stage: "submitted", status: "SUCCESS" });
    // The page's own observation settles it: the agent is frozen, and nothing was signed or submitted again.
    await home.getByRole("heading", { name: "Unfreeze the agent", exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await home.getByRole("status").filter({ hasText: "The outcome is unknown" }).count(), 0);
    assert.deepEqual(sent, ["owner/prepare", "owner/submit"]);
  } finally {
    home.off("request", onRequest);
  }
  // Leave `portfolio` unfrozen for the tests after this one.
  await home.getByRole("button", { name: "Unfreeze", exact: true }).click();
  await home.getByRole("heading", { name: "Freeze the agent", exact: true }).waitFor({ timeout: 60_000 });
});

/** Turns the schedule off from `page`: the stop is sent once and answered, and the schedule reads as off. */
const turnOff = async (page: Page) => {
  const button = page.getByRole("button", { name: "Turn off", exact: true });
  await visible(button);
  await until(async () => !(await button.isDisabled()), 15_000);
  const answered = page.waitForResponse(response => response.url().endsWith("/rpc/autopilot/stop"));
  await button.click();
  assert.equal((await answered).ok(), true);
  await visible(page.getByRole("status").filter({ hasText: "Future scheduled runs are off." }));
};

test("Turn off stops the schedule when a read fails: in the frame, and on the strategy page while setup is unavailable", async () => {
  // A lost overview answer, retried and still lost: the frame keeps the owner's way to stop the schedule.
  await home.route("**/a/portfolio/rpc/overview", route => route.abort("connectionreset"));
  try {
    await home.goto(`${dashboard}/a/portfolio/`);
    await home.getByText("Some agent details could not be loaded.").waitFor({ timeout: 30_000 });
    assert.deepEqual(await axe(home), []);
    await turnOff(home);
  } finally {
    await home.unroute("**/a/portfolio/rpc/overview");
  }
  assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, false);

  await setUnavailable(target, true);
  try {
    await home.goto(`${dashboard}/a/portfolio/automations`);
    await visible(home.getByRole("alert").filter({ hasText: "Setup unavailable" }));
    assert.deepEqual(await axe(home), []);
    await turnOff(home);
  } finally {
    await setUnavailable(target, false);
  }
  assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, false);
});

test("an overview refresh fails on the Overview: one stop control, the Overview's own", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("status").filter({ hasText: "Schedule: off" }));
  // From now on the provider refuses the overview and the schedule's read: the next refresh of each fails.
  const refused = JSON.stringify({ json: { defined: true, code: "BAD_REQUEST", message: "The provider could not complete this request.",
    data: { kind: "provider", code: "http_error", availableAt: null } } });
  const reads = ["**/a/portfolio/rpc/overview", "**/a/portfolio/rpc/autopilot/get"];
  for (const read of reads) await home.route(read, route => route.fulfill({ status: 400, contentType: "application/json", body: refused }));
  try {
    await home.getByText("Refresh failed. Showing previously loaded records; check again before acting.", { exact: true }).waitFor({ timeout: 60_000 });
    await visible(home.getByRole("status").filter({ hasText: "Schedule: unavailable" }));
    await visible(home.getByRole("button", { name: "Turn off schedule", exact: true }));
    assert.equal(await home.getByRole("button", { name: /^Turn off/ }).count(), 1, "the frame adds no second stop beside the Overview's");
    assert.equal(await home.getByRole("heading", { name: "Schedule", exact: true }).count(), 0, "the frame's Schedule section isn't shown");
    assert.deepEqual(await axe(home), []);
  } finally {
    for (const read of reads) await home.unroute(read);
  }
});

/** How the owner session answers one of `portfolio`'s procedures: whether it succeeded, or its failure's kind. */
const answer = (page: Page, path: string) => page.evaluate(async path => {
  const response = await fetch(`/a/portfolio/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return response.ok ? { ok: true } : { ok: false, kind: ((await response.json()) as { json: { data?: { kind?: string } } }).json.data?.kind };
}, path);

test("setup unreadable: Activity shows the retained records; other pages link to them", async () => {
  await setUnavailable(target, true);
  try {
    await home.goto(`${dashboard}/a/portfolio/activity`);
    await visible(home.getByRole("heading", { name: "Available records", exact: true }));
    await visible(home.getByRole("alert").filter({ hasText: "Setup unavailable" }));
    await visible(home.getByRole("status").filter({ hasText: "Retained records remain available. Current provider outcomes are not confirmed here." }));
    await visible(home.getByRole("heading", { name: "Unresolved operations", exact: true }));
    await visible(home.getByText("No unresolved operations are recorded on this instance.", { exact: true }));
    await visible(home.getByRole("heading", { name: "Owner actions", exact: true }));
    await visible(home.getByRole("heading", { name: "Operation history", exact: true }));
    assert.equal(await home.getByRole("region", { name: "Treasury owner" }).count(), 0, "nothing unconfirmed is shown");
    assert.deepEqual(await axe(home), []);

    await home.goto(`${dashboard}/a/portfolio/funding`);
    await visible(home.getByRole("alert").filter({ hasText: "Setup unavailable" }));
    await home.getByRole("link", { name: "Review existing operation records", exact: true }).click();
    await home.waitForURL(`${dashboard}/a/portfolio/activity`);
    await visible(home.getByRole("heading", { name: "Operation history", exact: true }));
  } finally {
    await setUnavailable(target, false);
  }
});

test("a provider outage reads as the owner session answers it: by kind, the provider's refusal, and the agent's own records stay", async () => {
  await setUnavailable(target, true);
  try {
    // On the owner session (unlike the machine route) the agent is still granted: setup is the provider's refusal,
    // and the agent's own records still answer.
    assert.deepEqual([await answer(home, "setup"), await answer(home, "activity"), await answer(home, "unresolved")],
      [{ ok: false, kind: "provider" }, { ok: true }, { ok: true }]);
    await home.goto(`${dashboard}/a/portfolio/activity`);
    // A provider refusal is shown in its own words, and isn't a denial: the records aren't hidden.
    await visible(home.getByRole("alert").filter({ hasText: "Setup unavailable" }));
    await visible(home.getByText("The provider could not complete this request. Check the recorded outcome before retrying.", { exact: true }));
    await visible(home.getByRole("status").filter({ hasText: "Retained records remain available." }));
    await visible(home.getByRole("heading", { name: "Operation history", exact: true }));
    assert.equal(await home.getByText(/could not be loaded/).count(), 0, "the agent's own records were read");
  } finally {
    await setUnavailable(target, false);
  }
});

// The unresolved operation it leaves blocks every later money action: only reads follow it.
test("after a lost swap reply, Activity lists the unresolved operation and says resolving it is the owner's separate step", async () => {
  await dropSwapResponse(target);
  // Executed outside the app's UI, as the platform's specs do: the provider applies the swap and loses the reply.
  const saved = await rpc<{ id: string }>(home, "externalPlan", { swaps: [{ from: USDC, to: WNEAR, amount: "1000000" }] });
  const executed = await home.evaluate(async planId => (await fetch("/a/portfolio/rpc/executePlan", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ json: { planId } }) })).text(), saved.id);
  assert.match(executed, /event: error/);

  await home.goto(`${dashboard}/a/portfolio/activity`);
  await visible(home.getByRole("heading", { name: "Operation status", level: 1 }));
  await visible(home.getByText("Unresolved operations", { exact: true }).first());
  await visible(home.getByRole("status").filter({ hasText: /^New sends are blocked by 1 unresolved operation\.$/ }));
  await visible(home.getByText("Resolving it is a separate step that needs the owner’s authorization. This page cannot clear, retry or replay it.", { exact: true }));
  await visible(home.getByText("Its submission was attempted and no provider reference was returned, so whether it executed is unknown.", { exact: true }));
  await visible(home.getByText("submission outcome unknown", { exact: true }));
  await visible(home.getByRole("heading", { name: "Owner actions", exact: true }));
  assert.equal(await home.getByRole("button", { name: /clear|retry|replay|resolve/i }).count(), 0, "resolution isn't offered here");
  assert.deepEqual(await axe(home), []);

  // Checking outcomes reads statuses only: the operation stays unknown and unresolved, nothing is sent again, and the
  // check stays offered after its unknown result, so a second check reads the same.
  const rows = (await rpc<unknown[]>(home, "activity")).length;
  const check = home.getByRole("button", { name: "Check operation outcomes", exact: true });
  for (let time = 1; time <= 2; time++) {
    await check.click();
    await visible(home.getByRole("status").filter({ hasText: /^Status check complete: Checked 1 operation\./ }));
    await visible(home.getByRole("list", { name: "Operation status results" }).getByText("Outcome still unknown", { exact: true }));
    assert.equal(await check.isEnabled(), true, `the check is offered again after check ${time}`);
    assert.equal((await rpc<unknown[]>(home, "unresolved")).length, 1, `still unresolved after check ${time}`);
    assert.equal((await rpc<unknown[]>(home, "activity")).length, rows, `nothing new was recorded by check ${time}`);
  }
});

test("after the lost swap reply, the Overview shows the unresolved operation, and its recorded refusals leave it out", async () => {
  await home.goto(`${dashboard}/a/portfolio/`);
  await visible(home.getByRole("heading", { level: 1, name: "Treasury overview", exact: true }));
  await visible(home.getByRole("heading", { name: "Unresolved operations", exact: true }));
  await visible(home.getByRole("status").filter({ hasText: /^New sends are blocked by 1 unresolved operation\.$/ }));
  // The simulated provider refuses no swap, so the stack records none: the lost swap is in Activity, but it wasn't refused.
  assert.equal((await rpc<unknown[]>(home, "activity")).length, 1);
  await home.getByText("Review recorded refusals", { exact: true }).click();
  await visible(home.getByText("No refusals found in the retained records returned.", { exact: true }));
  assert.deepEqual(await axe(home), []);
});

test("the overview fails while setup loads: Activity still lists the unresolved operation, under the overview's error", async () => {
  // Only this page's overview read is refused, as the provider refuses it; setup and the agent's own records still answer.
  const overview = "**/a/portfolio/rpc/overview";
  await home.route(overview, route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ json: {
    defined: true, code: "BAD_REQUEST", message: "The provider could not complete this request.", data: { kind: "provider", code: "http_error", availableAt: null } } }) }));
  try {
    await home.goto(`${dashboard}/a/portfolio/activity`);
    await visible(home.getByRole("region", { name: "Treasury owner" }));
    await visible(home.getByText("Some agent details could not be loaded.", { exact: true }));
    await visible(home.getByRole("heading", { name: "Operation status", level: 1 }));
    await visible(home.getByRole("status").filter({ hasText: /^New sends are blocked by 1 unresolved operation\.$/ }));
    await visible(home.getByText("submission outcome unknown", { exact: true }));
    await visible(home.getByRole("heading", { name: "Operation history", exact: true }));
    assert.deepEqual(await axe(home), []);
  } finally {
    await home.unroute(overview);
  }
});

// On a stack of its own: once on, the schedule's first run is due at once and the platform checks every minute, so a
// scheduled run (shielding public funds) may move funds and record operations before Turn off. No other test sees them.
test("Strategy: saved with the schedule off, the owner's grant bound to it signed in the owner's page, then autopilot on and off", { timeout: 300_000 }, async () => {
  const { home, dashboard, close } = await attach();
  try {
    await home.goto(`${dashboard}/a/portfolio/automations`);
    await visible(home.getByRole("heading", { level: 1, name: "Strategy", exact: true }));
    const original = await rpc<StrategyStatus>(home, "strategy/get");
    await home.getByRole("button", { name: "Edit strategy", exact: true }).click();
    for (const [label, value] of [["USDC (%)", "60"], ["wNEAR (%)", "20"], ["ETH (%)", "20"], ["Run every (minutes)", "120"]] as const)
      await home.getByLabel(label, { exact: true }).fill(value);
    assert.deepEqual(await axe(home), []);
    await home.getByRole("button", { name: "Save with autopilot off", exact: true }).click();
    // The saved strategy, observed again, opens its review: nothing is signed or turned on by saving.
    await visible(home.getByRole("heading", { name: "Authorize this saved strategy", exact: true }));
    const saved = await rpc<StrategyStatus>(home, "strategy/get");
    assert.notEqual(saved.digest, original.digest);
    assert.deepEqual(saved.strategy.targetBps, { [USDC]: 6000, [WNEAR]: 2000, [ETH]: 2000 });
    assert.equal(saved.strategy.autopilot.everyMin, 120);
    assert.equal(saved.grantMatches, false, "saving unbinds the earlier grant");
    assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, false);
    assert.deepEqual(await axe(home), []);

    const [grant, ...others] = await recorded(home, async () => {
      await home.getByRole("button", { name: "Authorize in wallet", exact: true }).click();
      await home.getByRole("button", { name: "Turn on", exact: true }).waitFor({ timeout: 60_000 });
    });
    assert.equal(others.length, 0, "one owner action per click");
    assert.equal(grant?.type, "grant_issue");
    assert.deepEqual(await status(home, grant!.correlationId), { stage: "submitted", status: "SUCCESS" });
    // The grant is bound to the reviewed strategy by its label, which is how the policy page lists it.
    const authorized = await rpc<StrategyStatus>(home, "strategy/get");
    assert.equal(authorized.digest, saved.digest);
    assert.equal(authorized.grantMatches, true);
    assert.equal(authorized.grant?.label, `treasury:${saved.grantSuffix}`);
    const { grants } = await rpc<{ grants: { label: string; revoked_at: string | null }[] }>(home, "overview");
    assert.ok(grants.some(g => g.label === `treasury:${saved.grantSuffix}` && !g.revoked_at), "the overview's grants list the strategy-bound grant under its own label");
    assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, false, "authorizing doesn't turn the schedule on");

    await home.getByRole("button", { name: "Turn on", exact: true }).click();
    const dialog = home.getByRole("dialog", { name: "Let the agent act on its own?" });
    await visible(dialog);
    assert.deepEqual(await axe(home), []);
    await dialog.getByRole("button", { name: "Turn on", exact: true }).click();
    await visible(home.getByRole("status").filter({ hasText: "Schedule enabled. Operation outcomes are reported separately." }));
    assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, true);
    await visible(home.getByRole("link", { name: "Follow treasury runs", exact: true }));

    await turnOff(home);
    assert.equal((await rpc<{ on: boolean }>(home, "autopilot/get")).on, false);
    // An off schedule offers nothing to turn off.
    await home.getByRole("button", { name: "Turn off", exact: true }).waitFor({ state: "hidden", timeout: 15_000 });
    await visible(home.getByRole("button", { name: "Turn on", exact: true }));
    assert.equal(await home.getByRole("alert").filter({ hasText: /\S/ }).count(), 0, "no error shown");
  } finally {
    await close();
  }
});
