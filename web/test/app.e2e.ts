// The app, served by the app server, on its own fresh stack (platform at PLATFORM_COMMIT, `--treasury --app`):
// it records operations, so no other test shares the stack. The app server runs in-process against the stack's gateway
// with its operator-issued `tap_` credential and serves the app's build (`dist/`). The owner's wallet is near-connect's
// injected-wallet interface, as the platform's own specs install it (`test/e2e/wallet.mjs`), signing through the stack's
// `signOwner` control; the stack doesn't publish its chain RPC, so the server's key check is a stand-in for the owner's key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { checkStrategyReview } from "./strategy-review.ts";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { appClient, proposalText, type ProposalView } from "@multiagency/sdk";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createAssistant } from "../../apps/server/src/assistant/assistant.ts";
import { rulesModel } from "../../apps/server/src/assistant/rules-model.ts";
import { chainedFileAudit, verifyChain } from "../../apps/server/src/chain.ts";
import { consentText } from "../../apps/server/src/consent.ts";
import { createCredential } from "../../apps/server/src/credential.ts";
import { createDaoRequests } from "../../apps/server/src/dao-requests.ts";
import { standInDaos } from "../../apps/server/src/dao.ts";
import { createServer } from "../../apps/server/src/http.ts";
import { standInKeyLookup } from "../../apps/server/src/keys.ts";
import { loadPage } from "../../apps/server/src/page.ts";
import { createPlatform } from "../../apps/server/src/platform.ts";
import { createSessions } from "../../apps/server/src/sessions.ts";
import { createSignIn } from "../../apps/server/src/signin.ts";
import { signOnConfirmPage } from "./confirm-page.ts";
import type { Creation } from "../src/server-api.ts";
import { ETH, fundPublic, setTargets, signOwner, signOwnerDelegate, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../scripts/stack.ts";
import { tempDir } from "../../scripts/temp-dirs.ts";

const PLATFORM = process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "..", "..", "..", "platform");
// The store the server records through (`main.ts`): a hash chain, checked before the first append.
const audit = chainedFileAudit(join(tempDir("treasury-proposals-"), "audit.jsonl"));
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, owner: string;
let server: Server, origin: string, browser: Browser, page: Page;
/** Requests the page made anywhere but this server and the wallet's boundary: none are expected. */
const unexpected: string[] = [];
/** What the owner's wallet was asked to send, in order: it sends nothing on the stack, whose chain takes no transactions. */
const sent: { signerId: string; receiverId: string; actions: { params: { methodName: string; args: Record<string, unknown>; deposit: string } }[] }[] = [];

before(async () => {
  await audit.check();
  // `--on-chain-policy-edits`: a provider-enforced policy edit comes back NEP-366, held for the platform's confirm page (#140).
  stack = await startStack({ args: ["--no-browser", "--app", "treasury-test", "--on-chain-policy-edits"] });
  target = stack.target;
  const state = stack.state();
  owner = state.ownerAccount;
  assert.ok(state.app, "the stack was started with --app");
  // The server's origin names its port, so it's listening before it's built.
  let handle: (req: IncomingMessage, res: ServerResponse) => void = (_, res) => { res.writeHead(503).end(); };
  server = createHttpServer((req, res) => handle(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  // localhost, which a browser treats as secure, so the `Secure`, `__Host-` session cookie is kept over plain HTTP.
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const keyLookup = standInKeyLookup({ [owner]: [state.testPublicKey] });
  handle = createServer({
    platform: createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile), timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) }),
    signIn: createSignIn({ recipient: new URL(origin).host, ttlMs: 5 * 60_000, perMinute: 100, keyLookup }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: origin, deployment: state.app.deployment, trustedProxyHops: 0, ownerRequestsPerMinute: 1_000, audit, consentsPerDay: 100, daoFilingsPerDay: 1_000, keyLookup, daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json")),
    page: await loadPage(join(import.meta.dirname, "..", "dist")),
    // The treasury assistant (#219), answered by its deterministic local model: nothing leaves the server in a stack test.
    assistant: createAssistant({ model: rulesModel(), audit: { append: entry => audit.append(entry) }, questionsPerHour: 1_000, platformReadsPerHour: 1_000 }),
    auditLog: async () => [],
    // The stabilization agent isn't run by this server (no watch file), so it has recorded nothing: the Agents page says so.
    latestRisk: async () => null, riskHistory: async () => [], riskStatus: () => ({ configured: false, intervalS: null }),
  });

  browser = await chromium.launch();
  // Reduced motion, which the page honours by dropping transitions: a button whose colours are still fading when the
  // accessibility check reads them (here, the deposit button turning outline once an address is shown) fails it at random.
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname === "/npm/@fastnear/near-connect@0.14.1/+esm")
      return route.fulfill({ contentType: "text/javascript", body: readFileSync(join(PLATFORM, "node_modules", "@fastnear", "near-connect", "cdn", "hot-connect.es.js"), "utf8") });
    if (["cdn.jsdelivr.net", "raw.githubusercontent.com"].includes(url.hostname) && url.pathname.endsWith("/manifest.json"))
      return route.fulfill({ json: { version: "1.0.0", wallets: [] } });
    unexpected.push(url.href);
    await route.abort();
  });
  // The owner's wallet signs as the stack's owner, through its control: never a module of the page replaced.
  await context.exposeFunction("__localSign", (payload: { message: string; recipient: string; nonce: string }) => signOwner(target, payload));
  // The wallet's success for a transaction: recorded, never sent.
  await context.exposeFunction("__localSend", (transaction: (typeof sent)[number]) => { sent.push(transaction); return { status: { SuccessValue: "" } }; });
  await context.addInitScript(({ account, publicKey }) => {
    const accounts = [{ accountId: account, publicKey }];
    const wallet = { manifest: { id: "local-test-wallet", name: "Local test wallet", type: "injected", icon: "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>", features: { signMessage: true } },
      signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => {},
      signMessage: (payload: { message: string; recipient: string; nonce: Uint8Array }) => (window as unknown as { __refuseNext?: boolean }).__refuseNext
        ? (delete (window as unknown as { __refuseNext?: boolean }).__refuseNext, Promise.reject(new Error("The wallet refused the signature")))
        : (window as unknown as { __localSign: (p: unknown) => Promise<unknown> }).__localSign({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
      signAndSendTransaction: (transaction: unknown) => (window as unknown as { __localSend: (t: unknown) => Promise<unknown> }).__localSend(transaction) };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })));
    localStorage.setItem("proposals:selected-wallet:mainnet", "local-test-wallet");
  }, { account: owner, publicKey: state.testPublicKey });
  page = await context.newPage();
}, { timeout: 180_000 });

after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  await stack?.stop();
});

const visible = (locator: ReturnType<Page["getByRole"]>) => locator.waitFor({ state: "visible", timeout: 20_000 });
/** Finish the provider's exit transition before checking the app beneath its popup. */
async function selectTestWallet(selectedPage = page) {
  await selectedPage.getByText("Local test wallet", { exact: true }).click();
  await selectedPage.getByText("Select wallet", { exact: true }).waitFor({ state: "detached" });
}
const axe = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations
  .map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);
const dialog = (name: string) => page.getByRole("dialog", { name });
/** A link of the agent's navigation. */
const nav = (name: string) => page.getByRole("navigation", { name: "Agent pages" }).getByRole("link", { name });
/** The page `address` names, for the agent: its own `<h1>`, and the navigation marking it. */
const here = (path = "") => `${origin}/agents/${target.agent}${path}`;
/** Signs in when the page asks (a test before may have signed out; signed out, the root is the landing), then waits for `shown`. */
async function signInIfAsked(shown: ReturnType<Page["getByRole"]>) {
  const signIn = page.getByRole("button", { name: "Sign in with wallet" }).or(page.getByRole("main").getByRole("button", { name: "Connect wallet" })).first();
  await signIn.or(shown).first().waitFor({ timeout: 20_000 });
  if (await signIn.isVisible()) {
    await signIn.click();
    await selectTestWallet();
  }
  await visible(shown);
}

/**
 * Replaces the connection with one as a page made it before owner came by default: read and treasury only, signed by the
 * owner's wallet and relayed through the page's own session. The server still accepts it, since live consents like it exist.
 */
async function connectWithoutOwner() {
  const state = stack.state();
  const call = (path: string, body?: unknown) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return response.status;
  }, { url: `${origin}/api/agents/${target.agent}${path}`, body });
  assert.equal(await call("/consent/revoke"), 200, "the connection made so far is revoked");
  const app = appClient({ base: state.dashboard as `https://${string}`, credential: readFileSync(state.app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const issued = await app.consents.nonce();
  assert.ok(issued.ok, JSON.stringify(issued));
  const text = consentText({ identity: { agent: target.agent, owner, agentId: state.treasury.agentId, host: new URL(state.dashboard).host }, deployment: state.app!.deployment }, issued.value.nonce);
  const signed = await signOwner(target, text);
  assert.equal(await call("/consent", { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature }), 200, "the older connection is stored");
}

/** Connects the agent when an earlier test left it disconnected (the strategy test ends by disconnecting it), and signs in. */
async function ensureConnected() {
  await page.goto(here());
  const connection = page.getByRole("region", { name: "Connection" });
  await signInIfAsked(connection);
  const status = connection.getByRole("status").first();
  await visible(status);
  if (/^Not connected/.test(await status.innerText())) {
    await connection.getByRole("button", { name: "Connect", exact: true }).click();
    await dialog("Connect this agent to the Treasury app?").getByRole("button", { name: "Sign and connect" }).click();
    await visible(connection.getByRole("status").filter({ hasText: /^Connected: / }));
  }
}

/** Creation responses are intercepted before reaching the platform: these recovery cases leave no real operation unresolved. */
async function withCreationRoutes(check: (fixture: {
  creation: Creation; calls: { prepare: number; review: number; submit: number }; state: {
    record: boolean; phase: "open" | "submitted" | "settled"; abortSubmit: boolean; pastExpiry: boolean; created: boolean;
    actionsRefusal?: string; reviewRefusal?: string; prepareRefusal?: string; fresh?: Creation; beforeReview?: () => Promise<void>;
  }; messages: () => Promise<string[]>; reload: () => Promise<void>;
}) => Promise<void>) {
  const base = `${origin}/api/agents/${target.agent}`, id = "mock-creation";
  const creation: Creation = { correlationId: id, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    intent: { standard: "nep413", payload: { message: "Create the reviewed Treasury agent with its owner and policy.", recipient: "provider.test", nonce: Buffer.alloc(32, 2).toString("base64") } },
    review: { agent: target.agent, owner, host: new URL(stack.state().dashboard).host, publicKey: stack.state().testPublicKey } };
  const calls = { prepare: 0, review: 0, submit: 0 };
  const state: Parameters<typeof check>[0]["state"] = { record: false, phase: "open", abortSubmit: false, pastExpiry: false, created: false };
  const routes: [string, (route: Route) => Promise<void>][] = [
    [base, route => route.fulfill({ json: { ok: true, value: { agent: target.agent, owner, agentId: state.created ? stack.state().treasury.agentId : null, host: creation.review!.host, signer: "wallet", account: owner,
      access: { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true } } } })],
    [`${base}/owner/actions`, route => route.fulfill(state.actionsRefusal ? { status: 409, json: { ok: false, kind: "refused", code: state.actionsRefusal } }
      : { json: { ok: true, value: state.record ? [{ correlationId: id, type: "agent_create", signer: "wallet", stage: state.phase === "open" ? "prepared" : "submitted", phase: state.phase,
        expiresAt: state.pastExpiry ? new Date(Date.now() - 60_000).toISOString() : creation.expiresAt, ownerSucceeded: false, status: null, failureCode: null, payment: null }] : [] } })],
    [`${base}/creation`, async route => { calls.prepare++; state.record = true; await route.fulfill(state.prepareRefusal
      ? { status: 409, json: { ok: false, kind: "refused", code: state.prepareRefusal } } : { json: { ok: true, value: creation } }); }],
    [`${base}/creation/${id}/review`, async route => { calls.review++; await state.beforeReview?.(); await route.fulfill(state.reviewRefusal
      ? { status: 409, json: { ok: false, kind: "refused", code: state.reviewRefusal } } : { json: { ok: true, value: state.fresh ?? creation } }); }],
    [`${base}/creation/${id}`, async route => { if (state.phase === "settled") state.created = true;
      await route.fulfill({ json: { ok: true, value: { stage: state.phase === "open" ? "unknown" : state.phase === "settled" ? "submitted" : "submitting", phase: state.phase,
        ...(state.phase === "settled" && { status: "SUCCESS" }) } } }); }],
    [`${base}/owner/actions/${id}/submit`, async route => { calls.submit++; state.phase = "submitted"; if (state.abortSubmit) await route.abort("failed");
      else await route.fulfill({ json: { ok: true, value: { status: "PENDING", failureCode: null } } }); }],
  ];
  const trackSigning = () => page.evaluate(() => {
    const host = window as unknown as { __localSign: (payload: { message: string }) => Promise<unknown>; __creationMessages: string[] };
    const sign = host.__localSign;
    host.__creationMessages = [];
    host.__localSign = payload => { host.__creationMessages.push(payload.message); return sign(payload); };
  });
  for (const [path, handler] of routes) await page.route(path, handler);
  try {
    await page.goto(here());
    await signInIfAsked(page.getByRole("region", { name: "Create the agent", exact: true }));
    await trackSigning();
    await check({ creation, calls, state, messages: () => page.evaluate(() => (window as unknown as { __creationMessages?: string[] }).__creationMessages ?? []),
      reload: async () => { await page.reload(); await trackSigning(); } });
  } finally {
    await page.goto(`${origin}/`);
    await page.waitForLoadState("networkidle");
    for (const [path, handler] of routes) await page.unroute(path, handler);
  }
}

/** A bound strategy and controllable schedule, with Run now intercepted before it reaches the simulated platform. */
async function withRunNowRoutes(respond: (route: Route, attempt: number) => Promise<void>, check: (calls: { tick: number; stop: number }) => Promise<void>, beforeStop?: () => Promise<void>) {
  await ensureConnected();
  const base = `${origin}/api/agents/${target.agent}`;
  const paths = { strategy: `${base}/strategy`, schedule: `${base}/autopilot`, tick: `${base}/autopilot/tick`, stop: `${base}/autopilot/stop` };
  const calls = { tick: 0, stop: 0 };
  let on = true;
  const strategy = await page.evaluate(async url => (await fetch(url)).json(), paths.strategy) as { ok: boolean; value?: Record<string, unknown> };
  assert.ok(strategy.ok && strategy.value, "the connected owner can read the strategy");
  await page.route(paths.strategy, route => route.fulfill({ json: { ...strategy, value: { ...strategy.value, executor: true, grantMatches: true } } }));
  await page.route(paths.schedule, route => route.fulfill({ json: { ok: true, value: { on, everyMin: 60, maxUsd: 100, lastRun: null, nextRun: null } } }));
  await page.route(paths.tick, async route => { calls.tick++; await respond(route, calls.tick); });
  await page.route(paths.stop, async route => { calls.stop++; await beforeStop?.(); on = false; await route.fulfill({ json: { ok: true, value: {} } }); });
  try {
    await page.goto(here("/strategy"));
    await visible(page.getByRole("region", { name: "Autopilot" }).getByRole("button", { name: "Run now", exact: true }));
    await check(calls);
  } finally {
    // Each check releases deliberately delayed replies before returning; finish refreshes before removing our mocks.
    await page.waitForLoadState("networkidle");
    for (const path of Object.values(paths)) await page.unroute(path);
  }
}

async function askRunNow() {
  await page.getByRole("region", { name: "Autopilot" }).getByRole("button", { name: "Run now", exact: true }).click();
  await dialog("Run the strategy once now?").getByRole("button", { name: "Run now", exact: true }).click();
}

/** The stack's portfolio proposes a swap through the app route, as the app's proposer does (#20 PR 4). */
async function propose(requestId: string): Promise<ProposalView> {
  const state = stack.state();
  const app = appClient({ base: state.dashboard as `https://${string}`, credential: readFileSync(state.app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const made = await app.agent(owner.replaceAll(".", "--"), target.agent).call("proposals/create",
    { requestId, legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  assert.ok(made.ok, JSON.stringify(made));
  return made.value as ProposalView;
}

test("a failed root session read stays visible without a retry loop and Check again recovers it", { timeout: 60_000 }, async t => {
  for (const failure of [
    { status: 503, body: { ok: false, kind: "unavailable" }, text: "The Treasury server or the platform didn't answer. Reading again is safe." },
    { status: 429, body: { ok: false, kind: "refused", code: "rate_limited" }, text: "Too many requests from this account. Wait a minute, then try again." },
  ]) await t.test(`HTTP ${failure.status}`, async t => {
    const rootPage = await page.context().newPage();
    let reads = 0, recovered = false;
    const setup = `${origin}/api/setup`;
    const respond = async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      reads++;
      await route.fulfill(recovered ? { json: { ok: true, value: { account: owner, agents: [] } } }
        : { status: failure.status, json: failure.body });
    };
    t.after(async () => { await rootPage.goto("about:blank"); await rootPage.unrouteAll({ behavior: "wait" }); await rootPage.close(); });
    await rootPage.route(setup, respond);
    await rootPage.goto(`${origin}/`);
    // Observe a quiet interval: the shell and root page share this read, and mounting the error page must not read again.
    await rootPage.waitForTimeout(750);
    assert.equal(reads, 1, "the failed session read must settle instead of remounting and requesting it repeatedly");
    const error = rootPage.getByRole("alert").filter({ hasText: failure.text });
    await visible(error);
    await visible(error.getByRole("button", { name: "Check again", exact: true }));
    assert.equal(await rootPage.getByText("Checking your session…", { exact: true }).count(), 0);

    // Browser-history navigation preserves the query cache; a document reload would conceal observer-mount retries.
    await rootPage.evaluate(() => { history.pushState({}, "", "/missing-session-test"); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); });
    await visible(rootPage.getByRole("heading", { name: "Page not found", exact: true }));
    assert.equal(reads, 1, "leaving the root does not retry its failed read");
    await rootPage.getByRole("main").getByRole("link", { name: "Your treasuries", exact: true }).click();
    await visible(error);
    await rootPage.waitForTimeout(750);
    assert.equal(reads, 2, "returning checks once and the failed page stays mounted without further retries");

    recovered = true;
    await error.getByRole("button", { name: "Check again", exact: true }).click();
    await visible(rootPage.getByRole("heading", { name: "Set up your Treasury", exact: true }));
    await visible(rootPage.getByText(`Signed in as ${owner}`));
    await rootPage.waitForLoadState("networkidle");
    assert.equal(reads, 3, "Check again makes one explicit read and recovers the page");
    assert.equal(await error.count(), 0, "recovery replaces the error");
  });
});

test("signing in offers wallet selection even when one account is already connected", { timeout: 60_000 }, async t => {
  const switchPage = await page.context().newPage();
  t.after(async () => {
    await switchPage.request.delete(`${origin}/api/session`, { headers: { Origin: origin } });
    await switchPage.close();
  });
  await switchPage.goto(here());
  await visible(switchPage.getByRole("heading", { level: 2, name: "Sign in", exact: true }));
  // The saved provider still has one account after the app's server session ends. It must not silently sign again.
  await switchPage.evaluate(() => {
    const state = window as unknown as { __cachedWalletSignatures?: number };
    state.__cachedWalletSignatures = 0;
    const accounts = [{ accountId: "previous-owner.near" }];
    const wallet = {
      manifest: { id: "cached-test-wallet", name: "Previously connected wallet", type: "injected", icon: "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>", features: { signMessage: true } },
      signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => { throw new Error("The provider did not disconnect"); },
      signMessage: async () => { state.__cachedWalletSignatures!++; throw new Error("The previously connected account was asked to sign"); },
    };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })));
    localStorage.setItem("proposals:selected-wallet:mainnet", "cached-test-wallet");
  });
  await switchPage.getByRole("button", { name: "Sign in with wallet", exact: true }).click();
  const chooser = switchPage.getByText("Select wallet", { exact: true });
  await chooser.or(switchPage.getByRole("alert").filter({ hasText: /\S/ })).first().waitFor();
  assert.equal(await chooser.isVisible(), true, `a cached single-account provider must not bypass wallet selection: ${await switchPage.getByRole("alert").allTextContents()}`);
  assert.equal(await switchPage.evaluate(() => (window as unknown as { __cachedWalletSignatures?: number }).__cachedWalletSignatures), 0);
  await selectTestWallet(switchPage);
  await visible(switchPage.getByText(`Signed in as ${owner}`));

  await switchPage.getByRole("button", { name: "Sign out", exact: true }).click();
  await visible(switchPage.getByRole("heading", { level: 2, name: "Sign in", exact: true }));
  await switchPage.goto(`${origin}/`);
  await switchPage.getByRole("main").getByRole("button", { name: "Connect wallet", exact: true }).first().click();
  await visible(chooser);
  await switchPage.keyboard.press("Escape");
  await visible(switchPage.getByRole("alert").filter({ hasText: "User rejected" }));
  assert.equal((await switchPage.request.get(`${origin}/api/setup`)).status(), 401, "cancelling wallet selection leaves the app signed out");
});

test("the owner signs in with their wallet, connects the agent with a consent they read first, and sees no proposals yet", { timeout: 120_000 }, async () => {
  await page.goto(here());
  assert.equal(await page.title(), "Home · Agentic Treasury");
  await visible(page.getByRole("heading", { level: 1, name: "Home" }));
  await visible(page.getByRole("heading", { level: 2, name: "Sign in" }));
  assert.deepEqual(await axe(), [], "signed out");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await selectTestWallet();
  await visible(page.getByText(`Signed in as ${owner}`));

  const connection = page.getByRole("region", { name: "Connection" });
  await visible(connection.getByRole("status").filter({ hasText: "Not connected" }));
  await visible(nav("Home").and(page.locator("[aria-current=page]")));
  assert.deepEqual(await axe(), [], "signed in, not connected");
  // Proposals, like Strategy and Funding, says what's missing and where to get it, rather than failing its read.
  await nav("Proposals").click();
  await visible(page.getByRole("status").filter({ hasText: "This agent isn't connected to the app." }));
  assert.equal(await page.getByText(/No live consent/).count(), 0, "not a failed read");
  await nav("Home").click();
  await visible(connection.getByRole("status").filter({ hasText: "Not connected" }));

  assert.equal(await connection.getByRole("checkbox").count(), 0, "no choice to make: owner actions come with the connection");
  await connection.getByRole("button", { name: "Connect" }).click();
  const consent = dialog("Connect this agent to the Treasury app?");
  await visible(consent);
  const text = await consent.getByLabel("Text to sign").innerText();
  assert.match(text, new RegExp(`${target.agent}`), "the platform's consent text, naming the agent");
  assert.match(text, /treasury/);
  assert.match(text, /owner/, "a wallet owner's consent asks for owner by default");
  await visible(consent.getByText("What the owner scope allows the app"));
  assert.deepEqual(await axe(), [], "the consent dialog");
  await consent.getByRole("button", { name: "Sign and connect" }).click();
  await visible(connection.getByRole("status").filter({ hasText: /^Connected: read, treasury and owner, until / }));
  await visible(page.getByText("Connected. The agent's proposals now reach this app: see them on its Proposals page."));
  assert.deepEqual(await axe(), []);
  await nav("Proposals").click();
  await visible(page.getByRole("heading", { level: 1, name: "Proposals" }));
  await visible(page.getByRole("region", { name: "Proposals" }).getByText(/No proposals yet/));
});

test("Home retains events arriving after its snapshot and does not advance a cached or failed visit (#263)", { timeout: 90_000 }, async () => {
  const key = `treasury:last-visit:${owner}:${target.agent}`;
  let at: string | undefined;
  const runsPath = `${origin}/api/agents/${target.agent}/runs`;
  const runs = (route: Route) => route.fulfill({ json: { ok: true, value: { corrupt: [], ticks: at ? [{
    id: "since-regression", at, trigger: "schedule", schedule: { on: true, everyMin: 60, maxUsd: 1, lastRun: null },
    build: { deployment: null, source: "test", lockfile: null, packageJson: null }, agentId: "test", policy: { revision: null, digest: null, status: "test" },
    strategy: "test", grant: null, end: null,
  }] : [] } } });
  const riskPath = `${origin}/api/agents/${target.agent}/risk/history?*`;
  const failed = (route: Route) => route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } });
  const stored = () => page.evaluate(key => localStorage.getItem(key), key);
  await page.route(runsPath, runs);
  try {
    await page.goto(here());
    await signInIfAsked(page.getByRole("region", { name: "Connection" }));
    await page.evaluate(key => localStorage.removeItem(key), key);
    await page.reload();
    await page.waitForLoadState("networkidle");
    // This event was absent from Home's snapshot. It arrives while the owner stays on that page.
    at = new Date(await page.evaluate(() => Date.now())).toISOString();
    await nav("Strategy").click();
    const cutoff = Number(await stored());
    assert.ok(cutoff > 0 && cutoff < Date.parse(at), "departure records the observed visit start, before the unseen event");
    await nav("Home").click();
    await page.waitForLoadState("networkidle");
    await nav("Strategy").click();
    assert.equal(Number(await stored()), cutoff, "a return using cached snapshots preserves the cutoff");
    await page.goto(here());
    const summary = page.getByRole("region", { name: "Since you last looked" });
    await visible(summary.getByText("Autopilot ran 1 time."));
    assert.deepEqual(await axe(), [], "the visit summary");
    await nav("Strategy").click();
    const observed = await stored();
    await page.route(riskPath, failed);
    await page.goto(here());
    await page.waitForLoadState("networkidle");
    await nav("Strategy").click();
    assert.equal(await stored(), observed, "a failed risk read cannot mark the visit observed");
  } finally {
    await page.unroute(runsPath, runs);
    await page.unroute(riskPath, failed);
  }
});

test("Home requests the visit interval and includes a risk peak older than the latest 20 assessments", { timeout: 90_000 }, async () => {
  await ensureConnected();
  const key = `treasury:last-visit:${owner}:${target.agent}`;
  const since = Date.now() - 3_600_000;
  const riskPath = `${origin}/api/agents/${target.agent}/risk/history?*`;
  let requestedSince: string | null = null;
  const history = (route: Route) => {
    requestedSince = new URL(route.request().url()).searchParams.get("since");
    return route.fulfill({ json: { ok: true, value: { configured: true, intervalS: 300,
      entries: Array.from({ length: 25 }, (_, i) => ({ seq: 25 - i, at: new Date(since + (25 - i) * 60_000).toISOString(),
        level: i === 24 ? 4 : 0, reason: "Visit regression", actions: [], proposed: false, drawdownPct: null })),
    } } });
  };
  await page.route(riskPath, history);
  try {
    await page.evaluate(({ key, since }) => localStorage.setItem(key, String(since)), { key, since });
    await page.goto(here());
    const summary = page.getByRole("region", { name: "Since you last looked" });
    await visible(summary.getByText(/The risk was assessed 25 times;.*reached/));
    assert.equal(requestedSince, String(since), "Home asks for the full interval rather than the recent-history endpoint");
    assert.deepEqual(await axe(), [], "complete risk summary");
  } finally {
    await page.unroute(riskPath, history);
  }
});

test("the owner approves a proposal by its exact text, executes it once to executed, and rejects another", { timeout: 180_000 }, async () => {
  const first = await propose(`page-${Date.now()}-1`), second = await propose(`page-${Date.now()}-2`);
  // The portfolio is read first, so coming back to it after the execute below shows whether it's read again.
  await page.goto(here());
  const portfolio = page.getByRole("region", { name: "Portfolio" });
  await visible(portfolio.getByRole("button", { name: "Check again", disabled: false }));
  await nav("Proposals").click();
  const list = page.getByRole("list", { name: "Proposals" });
  await visible(list);
  assert.equal(await list.getByRole("link", { name: /^Review proposal / }).count(), 2);
  // The leg as the SDK's own proposal text names it, without its raw units, so the stack's prices don't fix the amounts.
  const leg = proposalText(first, "approve").split("\n").find(line => line.startsWith("1. Swap "))!.slice("1. ".length).replace(/ \(\d+\)/g, "");
  await visible(list.getByText(leg).first());
  await visible(list.getByText(/^Policy revision /).first());
  assert.deepEqual(await axe(), [], "the list");

  await list.getByRole("link", { name: `Review proposal ${first.id.slice(0, 8)}…${first.id.slice(-6)}` }).click();
  await visible(page.getByRole("heading", { level: 1, name: "Proposal" }));
  const state = page.getByRole("region", { name: "State" });
  await visible(state.getByText("Awaiting your decision"));
  assert.equal(await state.getByRole("button", { name: "Execute" }).count(), 0, "not approved, nothing to execute");
  assert.deepEqual(await axe(), [], "a proposal");

  await state.getByRole("button", { name: "Approve" }).click();
  const approve = dialog("Approve this proposal?");
  await visible(approve);
  assert.equal(await approve.getByLabel("Text to sign").innerText(), proposalText(first, "approve"), "exactly the SDK's text, shown before signing");
  assert.deepEqual(await axe(), [], "the approval dialog");
  await approve.getByRole("button", { name: "Sign and approve" }).click();
  await visible(state.getByRole("status").filter({ hasText: "You approved this proposal." }));
  await visible(state.getByText("Approved", { exact: true }));

  await state.getByRole("button", { name: "Execute" }).click();
  const run = dialog("Execute this proposal?");
  await visible(run);
  assert.deepEqual(await axe(), [], "the execute dialog");
  // Recorded from the execute on: the frame (#133) reads the overview on every page, so it is read again the moment the
  // swap invalidates it, not when the Home is next shown.
  const reread: string[] = [];
  const read = (request: { url(): string }) => { const url = new URL(request.url()); if (url.origin === origin) reread.push(url.pathname); };
  page.on("request", read);
  await run.getByRole("button", { name: "Execute now" }).click();
  await visible(state.getByRole("status").filter({ hasText: "Executed. Every swap succeeded." }));
  await visible(state.getByText("Executed", { exact: true }));
  await visible(state.getByRole("list", { name: "Operations" }).getByText("success"));
  assert.equal(await state.getByRole("button", { name: "Execute" }).count(), 0, "it ran once; nothing to execute again");
  assert.deepEqual(await axe(), [], "an executed proposal");
  // What the swap changed is read again when it is next shown: never the book from before it. The Home shows the book, the
  // held payouts and what needs a decision; the history and the books are on the Activity page (#136), read when it is.
  await nav("Home").click();
  await visible(portfolio.getByRole("button", { name: "Check again", disabled: false }));
  for (const changed of ["overview", "held", "unresolved"])
    assert.ok(reread.includes(`/api/agents/${target.agent}/${changed}`), `${changed} read again, not shown from before the swap: ${reread.join(", ")}`);
  assert.ok(!reread.includes(`/api/agents/${target.agent}/activity`), "the Home no longer reads the history: it is on the Activity page");
  await nav("Activity").click();
  await visible(page.getByRole("region", { name: "History" }).getByRole("list", { name: "History" }));
  await page.waitForLoadState("networkidle");
  page.off("request", read);
  for (const changed of ["activity", "books"])
    assert.ok(reread.includes(`/api/agents/${target.agent}/${changed}`), `${changed} read again, not shown from before the swap: ${reread.join(", ")}`);

  await page.goto(`${origin}/agents/${target.agent}/proposals/${second.id}`);
  await state.getByRole("button", { name: "Reject" }).click();
  const reject = dialog("Reject this proposal?");
  await visible(reject);
  assert.equal(await reject.getByLabel("Text to sign").innerText(), proposalText(second, "reject"));
  assert.deepEqual(await axe(), [], "the rejection dialog");
  await reject.getByRole("button", { name: "Sign and reject" }).click();
  await visible(state.getByRole("status").filter({ hasText: "You rejected this proposal." }));
  await visible(state.getByText("Rejected", { exact: true }));
  assert.equal(await state.getByRole("button", { name: "Approve" }).count(), 0);

  const text = readFileSync(audit.file, "utf8");
  assert.ok(verifyChain(text).ok, "the audit trail chains");
  const lines = text.trim().split("\n").map(line => JSON.parse(line).entry);
  assert.deepEqual(lines.map(line => [line.action, line.stage, line.who, line.answer?.ok]), [
    ["consent", "attempt", owner, undefined], ["consent", "result", owner, true],
    ["approve", "attempt", owner, undefined], ["approve", "result", owner, true],
    ["execute", "attempt", owner, undefined], ["execute", "result", owner, true],
    ["reject", "attempt", owner, undefined], ["reject", "result", owner, true],
  ], "each relayed once, in order: one execute");
  assert.deepEqual(unexpected, [], "the page reached nothing but this server and the wallet's boundary");
});

test("signing out ends the server's session: the page asks to sign in again, and so does a reload", { timeout: 60_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await visible(page.getByRole("heading", { level: 2, name: "Sign in" }));
  await page.reload();
  await visible(page.getByRole("heading", { level: 2, name: "Sign in" }));
  assert.equal(await page.getByRole("region", { name: "Connection" }).count(), 0, "nothing of the owner's is shown");
});

test("signed out, the root is the landing outside the app's shell, passes an axe scan, and its Connect wallet is the app's sign-in, refusal included (#194)", { timeout: 90_000 }, async () => {
  // The test before signed out.
  await page.goto(`${origin}/`);
  await visible(page.getByRole("heading", { level: 1, name: "Your treasury. Your limits." }));
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "one h1");
  assert.equal(await page.title(), "Agentic Treasury");
  assert.equal(await page.getByRole("button", { name: "Toggle Sidebar" }).count(), 0, "the shell is for the signed-in pages");
  assert.equal(await page.getByRole("list", { name: "Your treasuries" }).count(), 0, "nothing of the owner's is shown");
  await visible(page.getByRole("navigation", { name: "Landing" }));
  for (const name of ["Product", "How it works", "Security", "FAQ"]) await visible(page.getByRole("region", { name }));
  // Decorative: the vault and the traces are hidden from assistive technology, so the hero's name is its heading.
  assert.equal(await page.locator("canvas:not([aria-hidden=true] canvas)").count(), 0, "no canvas outside an aria-hidden host");
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await axe(), [], "the landing");

  const connect = page.getByRole("main").getByRole("button", { name: "Connect wallet" }).first();
  // A wallet that refuses: the sign-in's own words, and the button offered again.
  await page.evaluate(() => { (window as unknown as { __refuseNext?: boolean }).__refuseNext = true; });
  await connect.click();
  await selectTestWallet();
  await visible(page.getByRole("alert").filter({ hasText: "The wallet didn't sign: The wallet refused the signature" }));
  assert.deepEqual(await axe(), [], "the landing, with the refusal");
  await connect.click();
  await selectTestWallet();
  await visible(page.getByRole("list", { name: "Your treasuries" }));
  await visible(page.getByRole("heading", { level: 1, name: "Your treasuries", exact: true }));
  assert.equal(await page.getByRole("heading", { name: "Your treasury. Your limits." }).count(), 0, "signed in, the landing is gone");
  assert.equal(await page.title(), "Your treasuries · Agentic Treasury");
  assert.deepEqual(unexpected, [], "the landing reached nothing but this server and the wallet's boundary");
});

test("the root lists the signed-in owner's treasuries, linked to each agent's page, and checks a DAO's account before opening its setup", { timeout: 60_000 }, async () => {
  await page.goto(`${origin}/`);
  const treasuries = page.getByRole("list", { name: "Your treasuries" });
  await signInIfAsked(treasuries);
  await visible(treasuries);
  await treasuries.getByRole("link", { name: target.agent }).waitFor();
  assert.equal(await treasuries.getByRole("link", { name: target.agent }).getAttribute("href"), `/agents/${target.agent}`);
  assert.equal(await page.getByRole("heading", { name: "Set up your Treasury" }).count(), 0, "an owner with a Treasury isn't offered another");
  await page.getByLabel("DAO account").fill("Not A DAO");
  await page.getByRole("button", { name: "Open the DAO's Treasury" }).click();
  await visible(page.getByRole("alert").filter({ hasText: "Enter the DAO's NEAR account" }));
  assert.equal(new URL(page.url()).pathname, "/");
});

test("a connected agent's page shows its portfolio from the owner reads: holdings exactly, what needs attention, activity and runs", { timeout: 60_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}`);
  const portfolio = page.getByRole("region", { name: "Portfolio" });
  await signInIfAsked(portfolio);
  await visible(portfolio);
  const holdings = portfolio.getByRole("table", { name: "Holdings" });
  await holdings.waitFor({ timeout: 20_000 });
  const usdc = holdings.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "USDC" }) });
  await usdc.waitFor();
  // The amount is the raw balance at 6 decimals, exactly: digits and at most one point, never a rounded or exponent form.
  assert.match((await usdc.getByRole("cell").first().textContent())!, /^\d+(\.\d{1,6})?$/);
  for (const name of ["Book", "Allocation", "Held payouts"]) await portfolio.getByRole("heading", { name, exact: true }).waitFor();
  // The history, the autopilot's runs and the books moved to the Activity page (#136).
  for (const name of ["Activity", "Autopilot runs", "Books"]) assert.equal(await portfolio.getByRole("heading", { name, exact: true }).count(), 0, `${name} is not on the home`);
  // The book as figures (#130): its value, the budget, and what is held privately; the allocation against the targets.
  await visible(portfolio.getByText("Book value"));
  await visible(portfolio.getByRole("table", { name: "Allocation" }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: /USDC/ }) }));
  assert.deepEqual(await axe(), []);
  assert.deepEqual(unexpected, []);
});

test("the owner links their own account to fund the agent, sends exactly the reviewed USDC transfer from their wallet, gets a deposit address, and unlinks", { timeout: 90_000 }, async () => {
  await page.goto(here("/funding"));
  const funding = page.getByRole("region", { name: "Funding" });
  await signInIfAsked(funding);
  await visible(funding.getByText("No funding account is linked. Link the NEAR account that funds this agent"));
  assert.deepEqual(await axe(), [], "nothing linked");
  await funding.getByRole("button", { name: `Use ${owner}` }).click();
  await visible(funding.getByRole("status").filter({ hasText: `Funded from ${owner}.` }));

  await funding.getByLabel("Funding amount").fill("1.5");
  await funding.getByRole("button", { name: "Review transfer" }).click();
  const review = funding.getByRole("group", { name: "Funding transfer to sign" });
  await visible(review);
  assert.match(await review.innerText(), /exactly 1\.5 USDC from/);
  const address = (await review.locator("code").first().innerText()).trim();
  assert.deepEqual(await axe(), [], "the review");
  await review.getByRole("button", { name: "Send" }).click();
  await visible(funding.getByRole("status").filter({ hasText: "Sent. The portfolio updates once the deposit lands." }));
  assert.equal(sent.length, 1, "sent once");
  const [transfer] = sent;
  assert.equal(transfer!.signerId, owner, "from the funding account");
  const ft = transfer!.actions.find(action => action.params.methodName === "ft_transfer")!;
  assert.deepEqual([ft.params.args.receiver_id, ft.params.args.amount], [address, "1500000"], "exactly the address and amount reviewed");

  await funding.getByText("Other ways to fund the agent").click();
  await funding.getByRole("button", { name: "Get a deposit address" }).click();
  await visible(funding.getByText("Deposit address", { exact: true }));
  assert.deepEqual(await axe(), [], "a deposit address");

  await funding.getByRole("button", { name: "Unlink" }).click();
  const unlink = dialog("Unlink the funding account?");
  await visible(unlink);
  await unlink.getByRole("button", { name: "Unlink" }).click();
  await visible(funding.getByText("No funding account is linked. Link the NEAR account that funds this agent"));
  assert.deepEqual(unexpected, [], "the page reached nothing but this server and the wallet's boundary");
});

test("the owner previews a public wNEAR balance, shields it once after reviewing it, and reads the books", { timeout: 90_000 }, async () => {
  await fundPublic(target, WNEAR, "1000000000000000000000000");
  await page.goto(here("/funding"));
  const funding = page.getByRole("region", { name: "Funding" });
  await signInIfAsked(funding);
  // Enabled once the account reads a treasury grant held by the executor.
  const preview = funding.getByRole("button", { name: "Preview", exact: true, disabled: false });
  await visible(preview);
  await preview.click();
  const balances = funding.getByRole("list", { name: "Public balances" });
  await visible(balances.getByText(/^1 wNEAR public$/));
  assert.deepEqual(await axe(), [], "a preview");
  await funding.getByRole("button", { name: "Shield", exact: true }).click();
  const review = dialog("Shield these public balances?");
  await visible(review);
  await visible(review.getByRole("list", { name: "Public balances to shield" }).getByText("1 wNEAR", { exact: true }));
  assert.deepEqual(await axe(), [], "the review");
  await review.getByRole("button", { name: "Shield now" }).click();
  await visible(funding.getByRole("status").filter({ hasText: "Shielded." }));
  await visible(balances.getByText(/^1 wNEAR public · shield success$/));
  assert.equal(await funding.getByRole("button", { name: "Shield", exact: true }).isDisabled(), true, "shielded once; a new preview comes first");
  // The books are on the Activity page (#136).
  await nav("Activity").click();
  await visible(page.getByRole("region", { name: "Books" }).getByRole("table", { name: "Books" }));
  assert.deepEqual(unexpected, []);
});

test("the owner asks for a rebalance to the drifted strategy, and reviews the proposal it made, awaiting their decision", { timeout: 90_000 }, async () => {
  await setTargets(target, { [USDC]: 0, [WNEAR]: 0, [ETH]: 10_000 });
  await page.goto(here("/strategy"));
  // A $0 ceiling: autopilot swaps nothing on its own, and the strategy says where swaps come from instead.
  const zero = page.getByRole("region", { name: "Autopilot" }).getByText(/^With a \$0 ceiling, autopilot makes no swaps on its own/);
  await signInIfAsked(zero);
  assert.equal(await zero.getByRole("link", { name: "Propose a rebalance" }).getAttribute("href"), `/agents/${target.agent}/proposals`);
  assert.deepEqual(await axe(), [], "offered");
  await zero.getByRole("link", { name: "Propose a rebalance" }).click();
  const proposals = page.getByRole("region", { name: "Proposals" });
  const ask = proposals.getByRole("button", { name: "Propose a rebalance" });
  await visible(ask);
  await ask.click();
  await visible(proposals.getByRole("status").filter({ hasText: "Proposed. Review it below: nothing is sent until it's approved." }));
  assert.deepEqual(await axe(), [], "proposed");
  await proposals.getByRole("link", { name: "Review the proposal" }).click();
  await visible(page.getByRole("heading", { level: 1, name: "Proposal" }));
  await visible(page.getByRole("region", { name: "State" }).getByText("Awaiting your decision"));
  assert.deepEqual(unexpected, []);
});

test("a page returned to within a minute shows what it read, without reading the platform again", { timeout: 60_000 }, async () => {
  await page.goto(here());
  const portfolio = page.getByRole("region", { name: "Portfolio" }), autopilot = page.getByRole("region", { name: "Autopilot" });
  await signInIfAsked(portfolio.getByRole("button", { name: "Check again", disabled: false }));
  await nav("Strategy").click();
  await visible(autopilot.getByRole("list", { name: "From strategy to autopilot" }));
  const reads: string[] = [];
  const read = (request: { url(): string }) => { const url = new URL(request.url()); if (url.origin === origin && url.pathname.startsWith("/api/")) reads.push(url.pathname); };
  page.on("request", read);
  await nav("Home").click();
  await visible(portfolio.getByRole("button", { name: "Check again", disabled: false }));
  await nav("Strategy").click();
  await visible(autopilot.getByRole("list", { name: "From strategy to autopilot" }));
  await page.waitForTimeout(500);
  page.off("request", read);
  // The visit cutoff changes on departure. Its new risk interval is read from this server's audit log,
  // so it does not consume the deployment's platform allowance. All platform-backed reads stay cached.
  assert.deepEqual(reads.filter(path => path !== `/api/agents/${target.agent}/risk/history`), [],
    "returning to a cached page makes no platform-backed reads");
});

test("the owner allows owner actions: told first that open proposals are withdrawn, then the connection is replaced by one with owner", { timeout: 90_000 }, async () => {
  await setTargets(target, { [USDC]: 10_000, [WNEAR]: 0, [ETH]: 0 });
  await page.goto(`${origin}/agents/${target.agent}`);
  const connection = page.getByRole("region", { name: "Connection" });
  await signInIfAsked(connection.getByRole("status").filter({ hasText: /^Connected: / }));
  await connectWithoutOwner();
  // Made under the connection without owner, and open until the upgrade replaces that connection.
  const open = await propose(`page-${Date.now()}-owner`);
  await page.goto(here(`/proposals/${open.id}`));
  await visible(page.getByRole("region", { name: "State" }).getByText("Awaiting your decision"));
  await page.goto(here());
  await visible(connection.getByRole("status").filter({ hasText: /^Connected: read and treasury, until / }));
  await signInIfAsked(connection.getByRole("button", { name: "Allow owner actions" }));
  await connection.getByRole("button", { name: "Allow owner actions" }).click();
  const allow = dialog("Allow owner actions for this agent?");
  await visible(allow);
  await visible(allow.getByRole("alert").filter({ hasText: "This replaces your current connection. Proposals made under it are withdrawn" }));
  assert.match(await allow.getByLabel("Text to sign").innerText(), /owner/);
  assert.deepEqual(await axe(), [], "the owner consent dialog");
  await allow.getByRole("button", { name: "Sign and allow" }).click();
  await visible(connection.getByRole("status").filter({ hasText: /^Connected: read, treasury and owner, until / }));
  assert.equal(await connection.getByRole("button", { name: "Allow owner actions" }).count(), 0, "not offered again");
  // The platform answers a read of a proposal whose consent ended as withdrawn.
  await page.goto(`${origin}/agents/${target.agent}/proposals/${open.id}`);
  await visible(page.getByText("It was withdrawn: the consent it was made under has ended. Nothing was relayed."));
  assert.deepEqual(unexpected, []);
});

test("a strategy changed while the owner edits it is shown to them, and their draft saved over it only once they've reviewed it", { timeout: 90_000 }, async () => {
  await page.goto(here("/strategy"));
  const autopilot = page.getByRole("region", { name: "Autopilot" });
  await signInIfAsked(autopilot.getByRole("button", { name: "Edit strategy" }));
  await autopilot.getByRole("button", { name: "Edit strategy" }).click();
  const editor = autopilot.getByRole("form", { name: "Edit strategy" });
  await visible(editor);
  await editor.getByLabel("Run every (minutes)").fill("90");
  // Leaving for another of the agent's pages asks first; staying keeps the draft.
  const asked: string[] = [];
  page.once("dialog", dialog => { asked.push(dialog.message()); void dialog.dismiss(); });
  await page.getByRole("navigation", { name: "Agent pages" }).getByRole("link", { name: "Funding" }).click();
  await editor.waitFor({ state: "visible" });
  assert.deepEqual(asked, ["Discard your unsaved changes?"]);
  assert.equal(page.url(), here("/strategy"), "still on Strategy");
  assert.equal(await editor.getByLabel("Run every (minutes)").inputValue(), "90", "the draft is kept");
  // Saved elsewhere meanwhile: this save is refused, and the strategy it was refused for is read and shown.
  await setTargets(target, { [USDC]: 6000, [WNEAR]: 4000, [ETH]: 0 });
  await editor.getByRole("button", { name: "Save with autopilot off" }).click();
  const changed = autopilot.getByRole("alert").filter({ hasText: "Your draft is kept" });
  await visible(changed.getByRole("list", { name: "Current strategy targets" }).getByText("USDC: 60%"));
  assert.equal(await editor.getByLabel("Run every (minutes)").inputValue(), "90", "the draft is kept");
  assert.equal(await editor.getByRole("button", { name: "Save with autopilot off" }).isDisabled(), true, "not saved over a strategy not reviewed");
  assert.deepEqual(await axe(), [], "the editor, its strategy changed");
  await changed.getByRole("button", { name: "Review against the current strategy" }).click();
  await editor.getByRole("button", { name: "Save with autopilot off" }).click();
  await visible(autopilot.getByRole("status").filter({ hasText: "Strategy saved. Authorize it next." }));
  await visible(autopilot.getByText(/every 90 minutes/));
  assert.deepEqual(unexpected, []);
});

test("the home lists what needs the owner: a proposal awaiting a decision, then approved and not executed, then gone once executed", { timeout: 120_000 }, async () => {
  const made = await propose(`page-${Date.now()}-home`);
  const link = `Review proposal ${made.id.slice(0, 8)}…${made.id.slice(-6)}`;
  const needs = () => page.getByRole("region", { name: "Needs your decision" });
  const item = () => needs().getByRole("listitem").filter({ has: page.getByRole("link", { name: link }) });
  await page.goto(here());
  await signInIfAsked(needs());
  await visible(item().getByText(/^Awaiting your decision: Swap 1 USDC for at least [0-9.]+ wNEAR$/));
  await visible(item().getByText(/^Expires /));
  assert.deepEqual(await axe(), [], "the home, a proposal awaiting a decision");

  await item().getByRole("link", { name: link }).click();
  const state = page.getByRole("region", { name: "State" });
  await state.getByRole("button", { name: "Approve" }).click();
  await dialog("Approve this proposal?").getByRole("button", { name: "Sign and approve" }).click();
  await visible(state.getByText("Approved", { exact: true }));
  await nav("Home").click();
  await visible(item().getByText(/^Approved, not executed yet: Swap 1 USDC for at least [0-9.]+ wNEAR$/));
  assert.deepEqual(await axe(), [], "the home, approved and not executed");

  await item().getByRole("link", { name: link }).click();
  await state.getByRole("button", { name: "Execute" }).click();
  await dialog("Execute this proposal?").getByRole("button", { name: "Execute now" }).click();
  await visible(state.getByText("Executed", { exact: true }));
  await nav("Home").click();
  await visible(needs());
  await page.waitForLoadState("networkidle");
  assert.equal(await item().count(), 0, `executed: it no longer needs the owner: ${await needs().innerText()}`);
  assert.deepEqual(await axe(), [], "the home, nothing for it");
  assert.deepEqual(unexpected, []);
});

test("the home says where the agent stands, one line each, linking to its page", { timeout: 60_000 }, async () => {
  await page.goto(here());
  const standing = page.getByRole("region", { name: "Where the agent stands" });
  await signInIfAsked(standing);
  const lines = standing.getByRole("list", { name: "Where the agent stands" }).getByRole("listitem");
  await visible(lines.filter({ hasText: /^Policy(In force|Blocked)/ }));
  await visible(lines.filter({ hasText: /^Strategy(Authorized|Not authorized)/ }));
  await visible(lines.filter({ hasText: /^Autopilot(On|Off)/ }));
  assert.equal(await lines.filter({ hasText: /^Strategy/ }).getByRole("link", { name: "Open" }).getAttribute("href"), `/agents/${target.agent}/strategy`);
  assert.deepEqual(await axe(), []);
});

test("an unfunded wallet owner's Home links both missing funding steps to Funding (#258)", { timeout: 60_000 }, async () => {
  const overviewPath = `${origin}/api/agents/${target.agent}/overview`;
  const treasuryPath = `${origin}/api/agents/${target.agent}/treasury`;
  const empty = async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    assert.equal(body.ok, true);
    await route.fulfill({ response, json: { ...body, value: { ...body.value, book: body.value.book.map((holding: object) => ({ ...holding, public: "0", confidential: "0", usd: 0 })) } } });
  };
  const unlinked = (route: Route) => route.fulfill({ json: { ok: true, value: { treasury: null } } });
  await page.route(overviewPath, empty);
  await page.route(treasuryPath, unlinked);
  try {
    await page.goto(here());
    const standing = page.getByRole("region", { name: "Where the agent stands" });
    await signInIfAsked(standing);
    const lines = standing.getByRole("listitem");
    const funds = lines.filter({ hasText: /^Funds/ });
    const account = lines.filter({ hasText: /^Account/ });
    await visible(funds.getByText("Not funded", { exact: true }));
    await visible(account.getByText("Not linked", { exact: true }));
    for (const line of [funds, account]) assert.equal(await line.getByRole("link", { name: "Open" }).getAttribute("href"), `/agents/${target.agent}/funding`);
    assert.deepEqual(await axe(), [], "first-run funding guidance");
  } finally {
    await page.unroute(overviewPath, empty);
    await page.unroute(treasuryPath, unlinked);
  }
});

test("on an approve-only host the home's Strategy line says so, never that it is not authorized", { timeout: 60_000 }, async () => {
  // The platform answers `grantMatches: null` when the host has no executor.
  const approveOnly = async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json() as { ok: boolean; value?: object };
    await route.fulfill({ response, json: body.ok ? { ...body, value: { ...body.value, grantMatches: null } } : body });
  };
  await page.route("**/api/agents/*/strategy", approveOnly);
  try {
    await page.goto(here());
    const standing = page.getByRole("region", { name: "Where the agent stands" });
    await signInIfAsked(standing);
    const line = standing.getByRole("list", { name: "Where the agent stands" }).getByRole("listitem").filter({ hasText: /^Strategy/ });
    await visible(line.getByText("This host only approves: the strategy is authorized on the agent's executor"));
    await visible(line.getByText("Approve-only", { exact: true }));
    assert.equal(await line.getByText(/Not authorized/).count(), 0);
  } finally {
    await page.unroute("**/api/agents/*/strategy", approveOnly);
  }
});

test("the owner edits the strategy, authorizes it in their wallet, turns autopilot on, runs it once, and disconnecting turns it off first", { timeout: 120_000 }, async () => {
  await page.goto(here("/strategy"));
  const autopilot = page.getByRole("region", { name: "Autopilot" });
  await signInIfAsked(autopilot);
  // The three steps read in order: configure, authorize, turn on.
  await visible(autopilot.getByRole("list", { name: "From strategy to autopilot" }));
  assert.deepEqual(await autopilot.getByRole("list", { name: "From strategy to autopilot" }).getByRole("heading", { level: 3 }).allInnerTexts(),
    ["1. Configure the strategy", "2. Authorize it", "3. Turn autopilot on"]);
  // By keyboard only: Enter opens the editor at its heading, Tab moves through the targets, Enter submits.
  const focused = () => page.evaluate(() => {
    const element = document.activeElement as HTMLInputElement | null;
    return element?.labels?.[0]?.textContent?.trim() ?? element?.textContent?.trim() ?? "";
  });
  const typeHere = async (value: string) => { await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.type(value); };
  await autopilot.getByRole("button", { name: "Edit strategy" }).focus();
  await page.keyboard.press("Enter");
  const editor = autopilot.getByRole("form", { name: "Edit strategy" });
  await visible(editor);
  assert.equal(await focused(), "Edit strategy", "focus starts at the editor");
  const first: Record<string, string> = { "USDC (%)": "50", "wNEAR (%)": "40", "ETH (%)": "0" };
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    const label = await focused();
    assert.ok(label in first, `a target field, not ${label}`);
    await typeHere(first[label]!);
  }
  await page.keyboard.press("Enter");
  await visible(editor.getByText("Target allocations must add up to 100%.").first());
  assert.deepEqual(await axe(), [], "the editor, refusing a total under 100%");
  // Focus went to an invalid target: Tab and Shift+Tab reach wNEAR within the three.
  for (let i = 0; i < 4 && (await focused()) !== "wNEAR (%)"; i++) await page.keyboard.press(i < 2 ? "Tab" : "Shift+Tab");
  assert.equal(await focused(), "wNEAR (%)");
  await typeHere("50");
  await page.keyboard.press("Enter");
  await visible(autopilot.getByRole("status").filter({ hasText: "Strategy saved. Authorize it next." }));
  assert.equal(await focused(), "Edit strategy", "focus returns to Edit strategy");
  await visible(autopilot.getByRole("list", { name: "Strategy targets" }).getByText("USDC: 50%"));
  assert.equal(await autopilot.getByText("Autopilot is off.", { exact: true }).count(), 1, "the schedule's state said once");
  // Saving the strategy unbound the grant: the owner signs a new one here, their connection allowing owner actions.
  await autopilot.getByRole("button", { name: "Authorize this strategy" }).click();
  const authorize = dialog("Authorize this saved strategy?");
  await visible(authorize);
  await checkStrategyReview(page, target.agent);
  assert.deepEqual(await axe(), [], "the authorization review");
  await authorize.getByRole("button", { name: "Sign in wallet" }).click();
  // Once submitted and taken up, the strategy reads bound: the grant step gives way to Turn on.
  await autopilot.getByRole("button", { name: "Turn on", disabled: false }).waitFor({ timeout: 45_000 });
  assert.equal(await autopilot.getByRole("button", { name: "Authorize this strategy" }).count(), 0, "authorized once");
  assert.deepEqual(await axe(), [], "authorized, off");
  await autopilot.getByRole("button", { name: "Turn on", disabled: false }).click();
  const turnOn = dialog("Let the agent act on its own?");
  await visible(turnOn);
  await turnOn.getByRole("button", { name: "Turn on" }).click();
  await visible(autopilot.getByRole("status").filter({ hasText: /^Autopilot is on/ }).first());
  await autopilot.getByRole("button", { name: "Run now" }).click();
  await dialog("Run the strategy once now?").getByRole("button", { name: "Run now" }).click();
  await visible(autopilot.getByRole("status").filter({ hasText: /^Run now: / }));
  assert.deepEqual(await axe(), [], "on, after a run");

  await nav("Home").click();
  const connection = page.getByRole("region", { name: "Connection" });
  await connection.getByRole("button", { name: "Disconnect" }).click();
  const disconnect = dialog("Disconnect this agent?");
  await visible(disconnect.getByText(/^Autopilot is turned off first/));
  await disconnect.getByRole("button", { name: "Disconnect" }).click();
  await visible(connection.getByRole("status").filter({ hasText: "Not connected." }));
  assert.deepEqual(unexpected, []);
});

for (const answer of ["lost", "unavailable"] as const) test(`Run now retry guard: a ${answer} reply holds another attempt across route navigation and leaves Turn off usable`, { timeout: 90_000 }, async () => {
  await withRunNowRoutes(route => answer === "lost" ? route.abort("failed") : route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } }), async calls => {
    await askRunNow();
    await page.waitForLoadState("networkidle");
    const autopilot = page.getByRole("region", { name: "Autopilot" });
    const run = autopilot.getByRole("button", { name: "Run now", exact: true });
    const warning = autopilot.getByRole("status").filter({ hasText: /run's outcome isn't known/i });
    const runs = warning.getByRole("link", { name: "Check this agent's runs", exact: true });
    assert.equal(calls.tick, 1);
    await visible(warning);
    assert.equal(await runs.getAttribute("href"), `/agents/${target.agent}/activity#runs`);
    assert.equal(await run.isDisabled(), true, "an unanswered run is held after the request ends");
    assert.equal(await autopilot.getByRole("button", { name: "Turn off", exact: true }).isEnabled(), true, "stopping the schedule remains possible");

    await runs.click();
    await visible(page.getByRole("heading", { level: 1, name: "Activity", exact: true }));
    await page.waitForFunction(() => location.hash === "#runs");
    await nav("Strategy").click();
    await visible(run);
    await visible(warning);
    await visible(runs);
    assert.equal(await run.isDisabled(), true, "leaving and returning in the same tab does not forget the unanswered run");
    await autopilot.getByRole("button", { name: "Check again", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await visible(warning);
    assert.equal(await run.isDisabled(), true, "fresh observations don't identify or release the unanswered attempt");
    await run.evaluate(button => (button as HTMLButtonElement).click());
    assert.equal(calls.tick, 1, "the disabled control and route changes send no duplicate tick");
    await autopilot.getByRole("button", { name: "Turn off", exact: true }).click();
    await visible(autopilot.getByRole("status").filter({ hasText: /^Autopilot is off\.$/ }));
    assert.equal(calls.stop, 1);
    await visible(warning);
    assert.equal(await run.isDisabled(), true, "stopping the schedule does not prove how the earlier run ended");
  });
  assert.deepEqual(unexpected, []);
});

test("Run now retry guard: a known refusal permits an explicit retry", { timeout: 90_000 }, async () => {
  await withRunNowRoutes((route, attempt) => attempt === 1
    ? route.fulfill({ status: 409, json: { ok: false, kind: "refused", code: "autopilot_refused" } })
    : route.fulfill({ json: { ok: true, value: { summary: "Mocked successful retry." } } }), async calls => {
    await askRunNow();
    await page.waitForLoadState("networkidle");
    const autopilot = page.getByRole("region", { name: "Autopilot" });
    assert.equal(calls.tick, 1, "a refused run is not automatically retried");
    assert.equal(await autopilot.getByRole("button", { name: "Run now", exact: true }).isEnabled(), true);
    await askRunNow();
    await visible(autopilot.getByRole("status").filter({ hasText: /^Run now: Mocked successful retry\.$/ }));
    assert.equal(calls.tick, 2, "only the second explicit confirmation retries it");
    assert.equal(await autopilot.getByRole("button", { name: "Run now", exact: true }).isEnabled(), true, "a proven success leaves Run now available");
  });
  assert.deepEqual(unexpected, []);
});

test("Run now retry guard: an in-flight attempt remains held while its page unmounts, then releases on success", { timeout: 90_000 }, async () => {
  let release!: () => void, entered!: () => void;
  const reply = new Promise<void>(resolve => { release = resolve; });
  const request = new Promise<void>(resolve => { entered = resolve; });
  try {
    await withRunNowRoutes(async route => {
      entered();
      await reply;
      await route.fulfill({ json: { ok: true, value: { summary: "Mocked run completed after navigation." } } });
    }, async calls => {
      try {
        await askRunNow();
        await request;
        await nav("Activity").click();
        await visible(page.getByRole("heading", { level: 1, name: "Activity", exact: true }));
        await nav("Strategy").click();
        const autopilot = page.getByRole("region", { name: "Autopilot" });
        const run = autopilot.getByRole("button", { name: "Run now", exact: true });
        await visible(run);
        assert.equal(await run.isDisabled(), true, "the in-flight attempt belongs to the agent, rather than its unmounted component");
        await autopilot.getByRole("button", { name: "Turn off", exact: true }).click();
        await visible(autopilot.getByRole("status").filter({ hasText: /^Autopilot is off\.$/ }));
        assert.equal(calls.stop, 1, "the schedule can stop before the run replies");
        assert.equal(await run.isDisabled(), true, "stopping the schedule doesn't release the pending run");
        assert.equal(calls.tick, 1);
        release();
        await page.waitForLoadState("networkidle");
        await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(button => button.textContent?.trim() === "Run now" && !button.disabled));
        assert.equal(await run.isEnabled(), true, "the completed reply clears the hold even though the caller unmounted");
        assert.equal(calls.tick, 1);
      } finally { release(); }
    });
  } finally { release(); }
  assert.deepEqual(unexpected, []);
});

test("Run now retry guard: a lost run reply cannot release a stop that is still in flight", { timeout: 90_000 }, async () => {
  let releaseTick!: () => void, tickEntered!: () => void, releaseStop!: () => void, stopEntered!: () => void;
  const tickReply = new Promise<void>(resolve => { releaseTick = resolve; });
  const tickRequest = new Promise<void>(resolve => { tickEntered = resolve; });
  const stopReply = new Promise<void>(resolve => { releaseStop = resolve; });
  const stopRequest = new Promise<void>(resolve => { stopEntered = resolve; });
  await withRunNowRoutes(async route => {
    tickEntered();
    await tickReply;
    await route.fulfill({ status: 503, json: { ok: false, kind: "unavailable" } });
  }, async calls => {
    try {
      await askRunNow();
      await tickRequest;
      const autopilot = page.getByRole("region", { name: "Autopilot" });
      const stop = autopilot.getByRole("button", { name: "Turn off", exact: true });
      await stop.click();
      await stopRequest;
      releaseTick();
      await visible(autopilot.getByText(/run's outcome isn't known/i));
      assert.equal(await stop.isDisabled(), true, "the run's answer doesn't clear the separate stop request's busy state");
      assert.equal(await autopilot.getByRole("button", { name: "Run now", exact: true }).isDisabled(), true);
      assert.deepEqual(calls, { tick: 1, stop: 1 });
      releaseStop();
      await visible(autopilot.getByRole("status").filter({ hasText: /^Autopilot is off\.$/ }));
      assert.equal(await autopilot.getByRole("button", { name: "Run now", exact: true }).isDisabled(), true, "the stop's later reply doesn't forget the unanswered run");
      assert.deepEqual(calls, { tick: 1, stop: 1 });
    } finally { releaseTick(); releaseStop(); }
  }, async () => { stopEntered(); await stopReply; });
  assert.deepEqual(unexpected, []);
});

test("Ask why fills proposal and risk questions without sending, and is hidden without an assistant (#264)", { timeout: 90_000 }, async () => {
  await ensureConnected();
  const made = await propose(`ask-why-${Date.now()}`);
  const posts: string[] = [];
  const track = (request: import("playwright").Request) => { if (request.method() === "POST" && request.url().startsWith(origin)) posts.push(request.url()); };
  page.on("request", track);
  const panel = page.getByRole("dialog", { name: "Treasury assistant" });
  const field = panel.getByRole("textbox", { name: "Your question" });
  const riskPath = `${origin}/api/agents/${target.agent}/risk`;
  const report = (route: Route) => route.fulfill({ json: { ok: true, value: { risk: {
    at: new Date().toISOString(), seq: 7, level: 2, reason: "Test assessment",
    projection: { usable: true, reasons: [], projectedDrawdownPct: 22, expectedShortfallPct: 23, breachProbabilityPct: 4, runwayMonths: 30, monthsToFloor: 24, volatileSharePct: 40 },
    scenarios: [], recommendations: [], derisk: null, proposed: false,
  } } } });
  const unavailable = (route: Route) => route.fulfill({ json: { ok: true, value: { available: false, model: null } } });
  try {
    await page.goto(here(`/proposals/${made.id}`));
    await page.getByRole("button", { name: "Ask why: this proposal" }).click();
    await visible(panel);
    assert.equal(await field.inputValue(), `Why was proposal ${made.id} made, and what happens if I approve it?`);
    assert.deepEqual(posts, [], "opening prepares, signs and sends nothing");
    assert.deepEqual(await axe(), [], "proposal question");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Ask the treasury" }).click();
    await visible(panel);
    assert.equal(await field.inputValue(), "", "the normal trigger does not reuse the question");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    await page.route(riskPath, report);
    await page.goto(here());
    await page.getByRole("button", { name: "Ask why: the risk level" }).click();
    await visible(panel);
    assert.equal(await field.inputValue(), "Why is the risk level what it is, and what would change it?");
    assert.deepEqual(posts, [], "the risk question is also only filled in");
    assert.deepEqual(await axe(), [], "risk question");
    await page.keyboard.press("Escape");
    await page.route(`${origin}/api/assistant`, unavailable);
    await page.goto(here(`/proposals/${made.id}`));
    await visible(page.getByRole("heading", { name: "Proposal", exact: true, level: 1 }));
    assert.equal(await page.getByRole("button", { name: /^Ask why:/ }).count(), 0);
    await page.goto(here());
    await visible(page.getByText("Test assessment", { exact: true }));
    assert.equal(await page.getByRole("button", { name: /^Ask why:/ }).count(), 0);
  } finally {
    page.off("request", track);
    await page.unroute(riskPath, report);
    await page.unroute(`${origin}/api/assistant`, unavailable);
  }
});

test("the assistant answers from the treasury's own records with sources, and a draft opens the strategy editor filled in without sending anything (#219)", { timeout: 150_000 }, async () => {
  await ensureConnected();
  const proposal = await propose(`ask-why-handoff-${Date.now()}`);
  await page.goto(here(`/proposals/${proposal.id}`));
  const ask = page.getByRole("button", { name: "Ask the treasury" });
  await visible(ask);
  await page.getByRole("button", { name: "Ask why: this proposal" }).click();
  const panel = page.getByRole("dialog", { name: "Treasury assistant" });
  await visible(panel);
  assert.deepEqual(await axe(), [], "the assistant panel");
  const question = panel.getByRole("textbox", { name: "Your question" });
  await question.fill("What's the book worth?");
  await question.press("Enter");
  await visible(panel.getByText(/^The book is worth \$/));
  await visible(panel.getByRole("button", { name: /^Source S1:/ }));
  assert.deepEqual(await axe(), [], "the assistant's answer");

  // "Propose a rebalance to 40% wNEAR" drafts new targets: its card opens the strategy editor with them filled in, and
  // nothing is saved or signed by opening it.
  await question.fill("Propose a rebalance to 40% wNEAR");
  await question.press("Enter");
  const open = panel.getByRole("button", { name: "Open in the strategy editor" });
  await visible(open);
  assert.deepEqual(await axe(), [], "the assistant's draft");
  await open.click();
  const editor = page.getByRole("form", { name: "Edit strategy" });
  await visible(editor);
  await visible(editor.getByRole("note", { name: "Filled in by the assistant" }));
  assert.equal(await editor.getByLabel("wNEAR (%)").inputValue(), "40", "the assistant's target is filled in");
  assert.deepEqual(await axe(), [], "the strategy editor the draft opened");

  // Another draft while the owner is editing doesn't replace their edit: the page says to save or cancel it first.
  await editor.getByLabel("wNEAR (%)").fill("45");
  await ask.click();
  await visible(panel);
  assert.equal(await question.inputValue(), "", "opening a draft clears the Ask why prefill too");
  await question.fill("Propose a rebalance to 30% wNEAR");
  await question.press("Enter");
  const again = panel.getByRole("button", { name: "Open in the strategy editor" }).last();
  await visible(again);
  await again.click();
  await visible(page.getByRole("status").filter({ hasText: /^Save or cancel the strategy edit first/ }));
  assert.equal(await editor.getByLabel("wNEAR (%)").inputValue(), "45", "the owner's edit is kept");
  assert.deepEqual(unexpected, []);
});

test("the Agents page shows the stabilization agent and the NEAR agent, each with a conversation that opens a review and sends nothing (#219, #220)", { timeout: 150_000 }, async () => {
  await ensureConnected();
  await page.goto(here());
  await nav("Agents").click();
  await visible(page.getByRole("heading", { name: "Agents", level: 1 }));
  assert.equal(page.url(), here("/ai"));
  // This stack's server doesn't run the stabilization agent, and the page says so rather than showing a level it doesn't have.
  const stabilization = page.locator("#stabilization-agent");
  await visible(stabilization.getByText("Not running", { exact: true }));
  await visible(stabilization.getByText(/No forward risk assessment has been recorded/).first());
  await visible(page.getByRole("heading", { name: "What it has been doing" }));
  assert.deepEqual(await axe(), [], "the Agents page");

  // A what-if with no recorded book says so, in words, instead of a result.
  await page.getByRole("button", { name: "Run what-if" }).click();
  await visible(page.getByRole("status").filter({ hasText: /no risk assessment has been recorded/ }));
  // A value the core would refuse isn't sent.
  await page.getByLabel(/^Value/).fill("500");
  await page.getByRole("button", { name: "Run what-if" }).click();
  await visible(page.getByRole("alert").filter({ hasText: /Enter a number above 0 and at most 100/ }));

  // The stabilization agent answers from its records, citing them, and declines what isn't forward risk.
  const risk = page.getByRole("textbox", { name: "Ask the stabilization agent" });
  await risk.fill("Why is the risk level what it is?");
  await risk.press("Enter");
  await visible(page.getByRole("log", { name: "Ask the stabilization agent: conversation" }).getByText(/No forward risk assessment has been recorded for this agent yet/));
  await risk.fill("Set the daily budget to $200");
  await risk.press("Enter");
  await visible(page.getByText(/The treasury assistant does that/));
  assert.deepEqual(await axe(), [], "the stabilization agent's conversation");

  // The NEAR agent: an autopilot control opens the Strategy page's own controls, and a page draft goes to the page.
  const near = page.getByRole("textbox", { name: "Ask the NEAR agent" });
  await near.fill("Take me to the policy page");
  await near.press("Enter");
  const toPolicy = page.getByRole("button", { name: "Open Policy" });
  await visible(toPolicy);
  await toPolicy.click();
  await visible(page.getByRole("heading", { name: "Policy", level: 1 }));
  await nav("Agents").click();
  await visible(page.getByRole("heading", { name: "Agents", level: 1 }));
  // The conversation is kept while the owner moves between pages.
  await visible(page.getByRole("log", { name: "Ask the NEAR agent: conversation" }).getByText("Take me to the policy page"));
  const nearAgain = page.getByRole("textbox", { name: "Ask the NEAR agent" });
  await nearAgain.fill("Pause autopilot");
  await nearAgain.press("Enter");
  const open = page.getByRole("button", { name: "Open the autopilot controls" });
  await visible(open);
  assert.deepEqual(await axe(), [], "the NEAR agent's autopilot draft");
  await open.click();
  await visible(page.getByRole("heading", { name: "Strategy", level: 1 }));
  // Autopilot is off on the stack, so the draft says so; it is taken only once autopilot's own state is read.
  await visible(page.getByRole("status").filter({ hasText: /^Autopilot is off already\.$/ }));
  assert.deepEqual(unexpected, []);
});

test("the emergency stop is in the frame of every page, with its own region and controls, and passes an axe scan", { timeout: 90_000 }, async () => {
  await ensureConnected();
  for (const path of ["", "/proposals", "/strategy", "/funding", "/policy", "/activity"]) {
    await page.goto(here(path));
    const stop = page.getByRole("region", { name: "Emergency stop" });
    await visible(stop.getByRole("button", { name: "Freeze" }));
    await visible(stop.getByText("Not frozen."));
    assert.equal(await stop.getByRole("button", { name: "Freeze" }).isEnabled(), true, `${path || "home"}: offered and enabled`);
  }
  assert.deepEqual(await axe(), [], "the stop, on a page");
  assert.deepEqual(unexpected, []);
});

/**
 * Signs the action `region` just prepared on the platform's confirm page, and answers its link: with
 * `--on-chain-policy-edits` the provider enforces a freeze and a policy edit itself, so they come back NEP-366, as in
 * production. A finished action's link stays shown until the next replaces it, so `used` is waited past.
 */
async function signOnConfirmLink(region: ReturnType<Page["getByRole"]>, used?: string) {
  const link = region.getByRole("link", { name: "open the confirm page" });
  let url: string | null = null;
  for (let waited = 0; ; waited += 250) {
    url = (await link.count()) ? await link.getAttribute("href") : null;
    if (url && url !== used) break;
    assert.ok(waited < 20_000, "no new confirm link");
    await page.waitForTimeout(250);
  }
  const signed = await signOnConfirmPage({ browser, target, platform: PLATFORM, url, owner: { accountId: owner, publicKey: stack.state().testPublicKey } });
  assert.equal(signed.asked.filter(item => item.delegate).length, 1, "one delegate signed");
  assert.deepEqual(signed.unexpected, []);
  return url;
}

/**
 * Answers the owner action prepared at `path` (POST) as an intent the wallet signs here: this stack prepares freezes and
 * policy edits for the confirm page, and a wallet's refusal is of an intent. Nothing it answers is ever submitted.
 */
async function answeredAsIntent<T>(path: string, run: () => Promise<T>): Promise<T> {
  const intent = { standard: "nep413", payload: { message: "An owner action", recipient: new URL(origin).host, nonce: Buffer.alloc(32).toString("base64") } };
  const asIntent = (route: Route) => route.request().method() !== "POST" ? route.fallback()
    : route.fulfill({ json: { ok: true, value: { correlationId: `refused-${Date.now()}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), intent } } });
  await page.route(path, asIntent);
  try { return await run(); } finally { await page.unroute(path, asIntent); }
}

test("the owner freezes by keyboard, told first what it does, signs on the platform's confirm page, and unfreezes; the agent's state follows (#140)", { timeout: 150_000 }, async () => {
  await page.goto(here("/strategy"));
  const stop = page.getByRole("region", { name: "Emergency stop" });
  await visible(stop.getByRole("button", { name: "Freeze" }));
  await stop.getByRole("button", { name: "Freeze" }).focus();
  await page.keyboard.press("Enter");
  const confirm = dialog("Freeze this agent?");
  await visible(confirm);
  const text = await confirm.innerText();
  assert.match(text, /refuses every send/);
  assert.match(text, /does not move funds/);
  assert.match(text, /Your wallet signs it/);
  assert.deepEqual(await axe(), [], "the freeze dialog");
  await confirm.getByRole("button", { name: "Sign and freeze" }).click();
  const froze = await signOnConfirmLink(stop);
  await stop.getByText("Frozen: the agent refuses every send.").waitFor({ timeout: 45_000 });
  await visible(stop.getByRole("button", { name: "Unfreeze" }));
  assert.equal(await stop.getByRole("button", { name: "Freeze", exact: true }).count(), 0, "one control at a time");
  assert.deepEqual(await axe(), [], "frozen");

  await stop.getByRole("button", { name: "Unfreeze" }).click();
  const back = dialog("Unfreeze this agent?");
  await visible(back);
  await back.getByRole("button", { name: "Sign and unfreeze" }).click();
  await signOnConfirmLink(stop, froze);
  await stop.getByText("Not frozen.").waitFor({ timeout: 45_000 });
  await visible(stop.getByRole("button", { name: "Freeze" }));
  assert.deepEqual(unexpected, []);
});

test("a wallet that refuses the freeze's signature leaves Freeze enabled again, with nothing to wait for", { timeout: 90_000 }, async () => {
  await page.goto(here("/proposals"));
  const stop = page.getByRole("region", { name: "Emergency stop" });
  await visible(stop.getByRole("button", { name: "Freeze" }));
  await page.evaluate(() => { (window as unknown as { __refuseNext?: boolean }).__refuseNext = true; });
  await answeredAsIntent("**/api/agents/*/freeze", async () => {
    await stop.getByRole("button", { name: "Freeze" }).click();
    await dialog("Freeze this agent?").getByRole("button", { name: "Sign and freeze" }).click();
    await visible(stop.getByText(/The wallet didn't sign: .*Nothing took effect/));
  });
  assert.equal(await stop.getByText(/outcome isn't known yet/).count(), 0, "nothing to wait for");
  await page.waitForFunction(() => !document.querySelector("#emergency-stop button[disabled]"), undefined, { timeout: 10_000 });
  assert.equal(await stop.getByRole("button", { name: "Freeze" }).isEnabled(), true);
  assert.deepEqual(unexpected, []);
});

test("a freeze whose outcome is unknown holds both controls, after a reload too, until the platform's record settles it", { timeout: 120_000 }, async () => {
  await page.goto(here("/proposals"));
  const stop = page.getByRole("region", { name: "Emergency stop" });
  await visible(stop.getByRole("button", { name: "Freeze" }));
  // The platform's own record, as it reads when a freeze was submitted and its outcome isn't recorded yet.
  const submitted = { correlationId: "held-freeze", type: "agent_freeze", expiresAt: new Date(Date.now() - 60_000).toISOString(), signer: "wallet", stage: "prepared", phase: "submitted", ownerSucceeded: false, status: null, failureCode: null, payment: null };
  await page.route("**/api/agents/*/owner/actions", route => route.fulfill({ json: { ok: true, value: [submitted] } }));
  await page.reload();
  await visible(stop.getByText(/outcome isn't known yet/));
  assert.equal(await stop.getByRole("button", { name: "Freeze" }).isDisabled(), true, "held after a reload");
  assert.deepEqual(await axe(), [], "held");
  await page.goto(here("/funding"));
  // The fresh page reads the platform's record before it holds: wait for that, then check.
  await visible(stop.getByText(/outcome isn't known yet/));
  assert.equal(await stop.getByRole("button", { name: "Freeze" }).isDisabled(), true, "and on another page");
  // The platform records it settled: the hold ends.
  await page.unroute("**/api/agents/*/owner/actions");
  await page.route("**/api/agents/*/owner/actions", route => route.fulfill({ json: { ok: true, value: [{ ...submitted, stage: "submitted", phase: "settled", status: "FAILED" }] } }));
  await page.reload();
  await visible(stop.getByRole("button", { name: "Freeze" }));
  await page.waitForFunction(() => !document.querySelector("#emergency-stop button[disabled]"), undefined, { timeout: 30_000 });
  await page.unroute("**/api/agents/*/owner/actions");
  assert.deepEqual(unexpected, []);
});

test("a settled failed freeze reports failure and releases its control without claiming it took effect", { timeout: 90_000 }, async () => {
  const freeze = "**/api/agents/*/freeze", status = "**/api/agents/*/owner/actions/failed-freeze";
  await page.route(freeze, route => route.fulfill({ json: { ok: true, value: {
    correlationId: "failed-freeze", expiresAt: new Date(Date.now() + 600_000).toISOString(),
    confirm: { url: `${origin}/confirm/failed-freeze`, expiresAt: new Date(Date.now() + 600_000).toISOString() },
  } } }));
  await page.route(status, route => route.fulfill({ json: { ok: true, value: { stage: "submitted", phase: "settled", status: "FAILED", failureCode: "provider_refused" } } }));
  try {
    await page.goto(here("/proposals"));
    const stop = page.getByRole("region", { name: "Emergency stop" });
    const freezeButton = stop.getByRole("button", { name: "Freeze", exact: true });
    await visible(freezeButton);
    await freezeButton.click();
    await dialog("Freeze this agent?").getByRole("button", { name: "Sign and freeze" }).click();
    await visible(stop.getByText("The platform couldn't carry it out. Nothing took effect.", { exact: true }));
    assert.equal(await stop.getByText("Done: the platform has it.", { exact: true }).count(), 0);
    await page.waitForFunction(() => !document.querySelector("#emergency-stop button[disabled]"), undefined, { timeout: 10_000 });
    assert.equal(await freezeButton.isEnabled(), true);
  } finally {
    await page.unroute(freeze);
    await page.unroute(status);
  }
  assert.deepEqual(unexpected, []);
});

test("the home lists an owner action waiting for the DAO's vote, until it expires, with a link to where it is voted on", { timeout: 120_000 }, async () => {
  await page.goto(here());
  const needs = page.getByRole("region", { name: "Needs your decision" });
  await visible(needs);
  const waiting = { correlationId: "pending-freeze", type: "agent_freeze", expiresAt: new Date(Date.now() + 600_000).toISOString(), signer: "dao", stage: "prepared", ownerSucceeded: false, status: null, failureCode: null, payment: null };
  await page.route("**/api/agents/*/owner/actions", route => route.fulfill({ json: { ok: true, value: [waiting] } }));
  await page.reload();
  const item = needs.getByRole("listitem").filter({ hasText: "Freeze is waiting for the DAO's vote" });
  await visible(item);
  await visible(item.getByText(/^Expires /));
  assert.deepEqual(await axe(), [], "the home, an owner action waiting for the vote");
  await item.getByRole("link", { name: "Open where it is signed or voted on" }).click();
  await page.waitForFunction(() => location.hash === "#emergency-stop");
  await page.unroute("**/api/agents/*/owner/actions");
  assert.deepEqual(unexpected, []);
});

test("each of the agent's pages opens by its address, with its own heading and the navigation marking it, and passes an axe scan", { timeout: 120_000 }, async () => {
  // An earlier test may have left the agent disconnected: connect it, so every page has what it shows.
  await ensureConnected();
  const made = await propose(`page-${Date.now()}-pages`);
  const pages: [string, string, string][] = [["", "Home", "Home"], ["/", "Home", "Home"], ["/proposals", "Proposals", "Proposals"],
    [`/proposals/${made.id}`, "Proposal", "Proposals"], ["/strategy", "Strategy", "Strategy"], ["/funding", "Funding", "Funding"], ["/policy", "Policy", "Policy"], ["/activity", "Activity", "Activity"]];
  for (const [path, title, current] of pages) {
    await page.goto(here(path));
    await visible(page.getByRole("heading", { level: 1, name: title, exact: true }));
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, `${path}: one h1`);
    assert.equal(await page.title(), `${title} · Agentic Treasury`, path);
    await visible(nav(current).and(page.locator("[aria-current=page]")));
    assert.equal(await page.locator("nav[aria-label='Agent pages'] [aria-current=page]").count(), 1, `${path}: one page marked`);
    assert.deepEqual(await axe(), [], `${path}: the page`);
  }
  // The root and a DAO's setup are pages too: one heading, their own title, no agent navigation, and an axe scan.
  for (const [path, title] of [["/", "Your treasuries"], ["/setup/dao/council.sputnik-dao.near", "A DAO's Treasury"]] as const) {
    await page.goto(`${origin}${path}`);
    await visible(page.getByRole("heading", { level: 1, name: title, exact: true }));
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, `${path}: one h1`);
    assert.equal(await page.title(), `${title} · Agentic Treasury`, path);
    assert.equal(await page.getByRole("navigation", { name: "Agent pages" }).count(), 0, `${path}: no agent navigation`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByText("Checking your session…").count(), 0, `${path}: loaded`);
    assert.deepEqual(await axe(), [], `${path}: the page`);
  }
  assert.deepEqual(unexpected, []);
});

test("the activity page holds the full history with each operation's status, the CSV, the owner's actions, the runs and the books", { timeout: 90_000 }, async () => {
  await page.goto(here("/activity"));
  const history = page.getByRole("region", { name: "History" });
  await signInIfAsked(history);
  const rows = history.getByRole("list", { name: "History" }).getByRole("listitem");
  await visible(rows.first());
  assert.ok(await rows.count() >= 1 && await rows.count() <= 50, "at most a page of 50");
  // The executed proposals' swaps are in it, newest first, with the outcome the platform recorded.
  const texts = await rows.allInnerTexts();
  assert.ok(texts.some(text => /proposal · 1 USDC → wNEAR · SUCCESS/.test(text)), `an executed proposal's swap, with its recorded status: ${JSON.stringify(texts.slice(0, 6))}`);
  const times = await rows.locator("time").evaluateAll(nodes => nodes.map(node => Date.parse((node as HTMLTimeElement).dateTime)));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");
  assert.equal(await history.getByRole("navigation", { name: "History pages" }).getByRole("status").innerText().then(text => /^Page 1 of \d+/.test(text)), true);

  // A row's operation status, by its correlation ID, on a click.
  const withId = rows.filter({ has: page.getByRole("button", { name: /^Check status/ }) }).first();
  await withId.getByRole("button", { name: /^Check status/ }).click();
  await visible(withId.getByRole("status").filter({ hasText: /^Status: / }));

  // The CSV downloads as the platform wrote it.
  const link = history.getByRole("link", { name: "Download CSV" });
  assert.equal(await link.getAttribute("href"), `/api/agents/${target.agent}/activity.csv`);
  assert.ok(await link.getAttribute("download") !== null, "offered as a download");
  const csv = await page.request.get(`${origin}${await link.getAttribute("href")}`);
  assert.equal(csv.status(), 200);
  assert.match(csv.headers()["content-type"] ?? "", /^text\/csv/);
  assert.match(csv.headers()["content-disposition"] ?? "", /^attachment; filename="[^"]+\.csv"$/);

  // The owner's actions, the runs and the books.
  const actions = page.getByRole("region", { name: "Owner actions" });
  await visible(actions.getByRole("list", { name: "Owner actions" }).or(actions.getByText("No owner actions yet.")));
  await visible(page.getByRole("region", { name: "Autopilot runs" }));
  await visible(page.getByRole("region", { name: "Books" }));
  assert.deepEqual(await axe(), [], "the activity page");
  assert.deepEqual(unexpected, []);
});

test("a run opens from the activity page's list, and a bad run ID is shown as such", { timeout: 90_000 }, async () => {
  await page.goto(here("/activity"));
  const runs = page.getByRole("region", { name: "Autopilot runs" });
  await signInIfAsked(runs);
  const open = runs.getByRole("link", { name: /^Open the run of / }).first();
  await visible(open);
  await open.click();
  await visible(page.getByRole("heading", { level: 1, name: "Run", exact: true }));
  await visible(page.getByRole("heading", { level: 2, name: /^Run / }));
  await visible(page.getByText("How it ended"));
  assert.equal(await page.title(), "Run · Agentic Treasury");
  assert.deepEqual(await axe(), [], "a run");
  await page.getByRole("link", { name: "Back to activity" }).click();
  await visible(page.getByRole("heading", { level: 1, name: "Activity", exact: true }));

  await page.goto(here("/activity/runs/no-such-run"));
  await visible(page.getByRole("alert").filter({ hasText: "No run has this ID." }));
  await page.goto(here("/activity/runs/has%20space"));
  await visible(page.getByRole("alert").filter({ hasText: "This address doesn't name a run" }));
  assert.deepEqual(unexpected, []);
});

test("the agent's pages are reached by keyboard alone, the current one marked as it changes", { timeout: 60_000 }, async () => {
  await page.goto(here());
  await visible(page.getByRole("heading", { level: 1, name: "Home", exact: true }));
  await nav("Home").focus();
  for (const title of ["Proposals", "Strategy", "Funding"]) {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), title, `Tab reaches ${title}`);
    await page.keyboard.press("Enter");
    await visible(page.getByRole("heading", { level: 1, name: title, exact: true }));
    await visible(nav(title).and(page.locator("[aria-current=page]")));
  }
  // Back to the first, by shift-tabbing along the navigation.
  for (const title of ["Strategy", "Proposals", "Home"]) {
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), title);
  }
  await page.keyboard.press("Enter");
  await visible(page.getByRole("heading", { level: 1, name: "Home", exact: true }));
  assert.deepEqual(unexpected, []);
});

test("following a link from a page's content moves the focus to the new page's heading, not back to the top of the document", { timeout: 60_000 }, async () => {
  const made = await propose(`page-${Date.now()}-focus`);
  await page.goto(here("/proposals"));
  const link = page.getByRole("list", { name: "Proposals" }).getByRole("link", { name: `Review proposal ${made.id.slice(0, 8)}…${made.id.slice(-6)}` });
  await visible(link);
  await link.focus();
  await page.keyboard.press("Enter");
  await visible(page.getByRole("heading", { level: 1, name: "Proposal", exact: true }));
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1", "the link unmounted with its page: focus is on the new heading");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Proposal");
  // A link of the navigation stays mounted, and keeps the focus it was given.
  await nav("Strategy").focus();
  await page.keyboard.press("Enter");
  await visible(page.getByRole("heading", { level: 1, name: "Strategy", exact: true }));
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Strategy");
  assert.deepEqual(unexpected, []);
});

test("an address that names nothing is shown as such: a bad proposal ID, a bad agent name, and a page that doesn't exist", { timeout: 60_000 }, async () => {
  await page.goto(here("/proposals/not-an-id"));
  await visible(page.getByRole("heading", { level: 1, name: "Proposal", exact: true }));
  await visible(page.getByRole("alert").filter({ hasText: "This address doesn't name a proposal: a proposal's ID is 32 lowercase hexadecimal characters." }));
  await page.getByRole("link", { name: "Back to proposals" }).click();
  await visible(page.getByRole("heading", { level: 1, name: "Proposals", exact: true }));
  assert.deepEqual(await axe(), [], "a bad proposal ID, and its way back");

  await page.goto(`${origin}/agents/Bad_Name`);
  await visible(page.getByRole("heading", { level: 1, name: "Page not found", exact: true }));
  await visible(page.getByRole("alert").filter({ hasText: "This address doesn't name an agent" }));
  assert.equal(await page.title(), "Page not found · Agentic Treasury");
  assert.deepEqual(await axe(), [], "a bad agent name");

  await page.goto(here("/proposals/%E0%A4%A"));
  await visible(page.getByRole("heading", { level: 1, name: "Page not found", exact: true }));
  assert.equal(await page.title(), "Page not found · Agentic Treasury", "the title and the page agree on a malformed escape");

  await page.goto(here("/nothing-here"));
  await visible(page.getByRole("heading", { level: 1, name: "Page not found", exact: true }));
  await page.getByRole("link", { name: "Your treasuries" }).click();
  await visible(page.getByRole("heading", { level: 1, name: "Your treasuries", exact: true }));
  assert.deepEqual(unexpected, []);
});

test("the link a watch notice sends opens the proposal", { timeout: 60_000 }, async () => {
  const made = await propose(`page-${Date.now()}-notice`);
  // As `watch` builds it: the server's origin, then /agents/<agent>/proposals/<id>.
  await page.goto(`${origin}/agents/${target.agent}/proposals/${made.id}`);
  await visible(page.getByRole("heading", { level: 1, name: "Proposal", exact: true }));
  await visible(page.getByRole("region", { name: "State" }).getByText("Awaiting your decision"));
});

test("the policy page leads with the terms as signed, then limits and grants, and keeps the revisions and the mandate digest collapsed", { timeout: 90_000 }, async () => {
  await ensureConnected();
  await page.goto(here("/policy"));
  const terms = page.getByRole("region", { name: "Policy as signed" });
  await visible(terms.getByText("Owner approval", { exact: true }));
  await visible(terms.getByText(/^Revision \d+/));
  await visible(page.getByRole("region", { name: "Limits" }).getByRole("table", { name: "USD budget windows" }));
  await visible(page.getByRole("region", { name: "Grants" }));
  const evidence = page.getByRole("region", { name: "Revisions and mandate digest" });
  assert.equal(await evidence.getByText(/^sha256:[0-9a-f]{64}$/).isVisible(), false, "collapsed");
  await evidence.getByText("Show the digest and the revisions").click();
  await visible(evidence.getByText(/^sha256:[0-9a-f]{64}$/));
  await visible(evidence.getByRole("list", { name: "Revisions" }).or(evidence.getByText("No revision records returned.")));
  assert.deepEqual(await axe(), [], "the policy page, evidence open");
  assert.deepEqual(unexpected, []);
});

test("the owner edits the policy by keyboard: told what changes first, signs it on the platform's confirm page, and the page reads the new revision (#140)", { timeout: 150_000 }, async () => {
  await ensureConnected();
  await page.goto(here("/policy"));
  const terms = page.getByRole("region", { name: "Policy as signed" });
  const before = Number((await terms.getByText(/^Revision \d+/).innerText()).match(/\d+/)![0]);
  await terms.getByRole("button", { name: "Edit", exact: true }).focus();
  await page.keyboard.press("Enter");
  const rate = terms.getByLabel("Actions an hour (blank for no cap)");
  await visible(rate);
  assert.equal(await terms.getByRole("button", { name: "Review the changes" }).isDisabled(), true, "nothing changed yet");
  assert.deepEqual(await axe(), [], "the editor");
  // A rate that is not the one in force, whatever the stack signed.
  const next = (await terms.getByText(/ actions an hour$/).count()) && (await terms.getByText("7 actions an hour").count()) ? "9" : "7";
  await rate.fill(next);
  await terms.getByRole("button", { name: "Review the changes" }).click();
  const confirm = dialog("Change this policy?");
  await visible(confirm);
  await visible(confirm.getByRole("list", { name: "Changes" }).getByText(new RegExp(`^Actions an hour: .+ → ${next}$`)));
  assert.match(await confirm.innerText(), /Your wallet signs it/);
  assert.deepEqual(await axe(), [], "the review dialog");
  await confirm.getByRole("button", { name: "Sign and apply" }).click();
  await signOnConfirmLink(terms);
  await terms.getByText(`${next} actions an hour`).waitFor({ timeout: 45_000 });
  const after = Number((await terms.getByText(/^Revision \d+/).innerText()).match(/\d+/)![0]);
  assert.equal(after, before + 1, "the new revision");
  assert.deepEqual(await axe(), [], "after the edit");
});

/** Opens the policy editor with a rate that differs from the one in force, ready to review. */
async function draftRateEdit() {
  await ensureConnected();
  await page.goto(here("/policy"));
  const terms = page.getByRole("region", { name: "Policy as signed" });
  await terms.getByRole("button", { name: "Edit", exact: true }).click();
  const rate = terms.getByLabel("Actions an hour (blank for no cap)");
  await visible(rate);
  await rate.fill((await rate.inputValue()) === "5" ? "6" : "5");
  return terms;
}

test("an assistant's policy draft doesn't replace an edit the owner has open: the page says to save or cancel it first (#219)", { timeout: 150_000 }, async () => {
  const terms = await draftRateEdit();
  const rate = terms.getByLabel("Actions an hour (blank for no cap)");
  const edited = await rate.inputValue();
  await page.getByRole("button", { name: "Ask the treasury" }).click();
  const panel = page.getByRole("dialog", { name: "Treasury assistant" });
  const question = panel.getByRole("textbox", { name: "Your question" });
  await question.fill("Set the monthly budget to $500");
  await question.press("Enter");
  const open = panel.getByRole("button", { name: "Open in the policy editor" }).last();
  await visible(open);
  await open.click();
  await visible(page.getByRole("status").filter({ hasText: /^Save or cancel the policy edit first/ }));
  assert.equal(await rate.inputValue(), edited, "the owner's edit is kept");
  await terms.getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(unexpected, []);
});

test("an edit that expires before it was signed keeps the editor open and says so", { timeout: 120_000 }, async () => {
  const terms = await draftRateEdit();
  // The signed edit is taken without applying it, and the platform reads it as expired, as it does once its window has passed.
  await page.route("**/api/agents/*/owner/actions/*", route => route.fulfill({ json: { ok: true, value: route.request().method() === "GET" ? { stage: "expired" } : {} } }));
  try {
    await terms.getByRole("button", { name: "Review the changes" }).click();
    await dialog("Change this policy?").getByRole("button", { name: "Sign and apply" }).click();
    await visible(terms.getByText("It expired before it was signed or voted on. The policy is unchanged."));
    assert.equal(await terms.getByLabel("Actions an hour (blank for no cap)").count(), 1, "the editor is still open");
  } finally {
    await page.unroute("**/api/agents/*/owner/actions/*");
  }
});

test("a wallet that refuses the edit's signature leaves Review the changes enabled again", { timeout: 90_000 }, async () => {
  const terms = await draftRateEdit();
  await page.evaluate(() => { (window as unknown as { __refuseNext?: boolean }).__refuseNext = true; });
  await answeredAsIntent("**/api/agents/*/policy", async () => {
    await terms.getByRole("button", { name: "Review the changes" }).click();
    await dialog("Change this policy?").getByRole("button", { name: "Sign and apply" }).click();
    await visible(terms.getByText(/The wallet didn't sign: .*Nothing took effect/));
  });
  assert.equal(await terms.getByText(/outcome isn't known yet/).count(), 0, "nothing to wait for");
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].some(button => button.textContent?.includes("Review the changes") && button.disabled), undefined, { timeout: 10_000 });
  assert.equal(await terms.getByRole("button", { name: "Review the changes" }).isEnabled(), true);
});

test("a refusal because the policy isn't in force links to the Policy page", { timeout: 90_000 }, async () => {
  await ensureConnected();
  const made = await propose(`policy-link-${Date.now()}`);
  await page.route("**/api/agents/*/proposals/*/approve", route => route.fulfill({ status: 409, json: { ok: false, kind: "refused", code: "policy_not_in_force" } }));
  await page.goto(here(`/proposals/${made.id}`));
  const state = page.getByRole("region", { name: "State" });
  await state.getByRole("button", { name: "Approve" }).click();
  await dialog("Approve this proposal?").getByRole("button", { name: "Sign and approve" }).click();
  const link = page.getByRole("link", { name: "Open the Policy page" });
  await visible(link);
  await link.click();
  await visible(page.getByRole("heading", { level: 1, name: "Policy", exact: true }));
  await page.unroute("**/api/agents/*/proposals/*/approve");
});

test("the policy page lists the treasury grant, and the owner revokes it by keyboard, told first what it does: signed once, it reads ended", { timeout: 150_000 }, async () => {
  await ensureConnected();
  await page.goto(here("/policy"));
  const grants = page.getByRole("region", { name: "Grants" });
  const live = grants.getByRole("list", { name: "Live grants" });
  await visible(live.getByText("treasury", { exact: true }));
  assert.deepEqual(await axe(), [], "the policy page");
  const revoke = live.getByRole("button", { name: "Revoke grant treasury", exact: true });
  await revoke.focus();
  await page.keyboard.press("Enter");
  const confirm = dialog("Revoke this grant?");
  await visible(confirm);
  const text = await confirm.innerText();
  assert.match(text, /stops acting at once/);
  assert.match(text, /does not move funds/);
  assert.match(text, /Your wallet signs it/);
  assert.deepEqual(await axe(), [], "the revoke dialog");
  // The simulated provider performs `grant_revoke` (since 49b8d51) and prepares it as an intent the wallet signs here.
  // The tests after this one need no grant.
  await confirm.getByRole("button", { name: "Sign and revoke" }).click();
  await grants.getByText("Done: the platform has the revocation, and the grant no longer acts.").waitFor({ timeout: 45_000 });
  await visible(grants.getByText(/^Ended grants \(1\)/));
  assert.equal(await live.getByText("treasury", { exact: true }).count(), 0, "no longer live");
  assert.equal(await grants.getByRole("alert").filter({ hasText: /\S/ }).count(), 0, "no error shown");
  assert.deepEqual(await axe(), [], "after the revocation");
});

test("the owner signs a policy edit the platform holds for its confirm page: the helper connects the wallet, signs the link and the delegate, and the new revision reads (#140)", { timeout: 150_000 }, async () => {
  const show = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
  const state = stack.state();
  const app = appClient({ base: state.dashboard as `https://${string}`, credential: readFileSync(state.app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const agent = app.agent(owner.replaceAll(".", "--"), target.agent);
  const overview = async () => { const read = await agent.call("overview"); assert.ok(read.ok, show(read)); return read.value as { policy: { revision: number | null }; digest: string | null }; };
  const before = await overview();
  // The hourly action cap is enforced by the provider itself, so changing it comes back NEP-366: only a link, never the bytes.
  // (The stack's policy has owner approval off already, so turning it off would change no enforced field.)
  const held = await agent.call("owner/prepare", { action: { type: "policy_update", expectedPolicy: { revision: before.policy.revision!, digest: before.digest! }, changes: { max_actions_per_hour: 11 } }, signer: "wallet" });
  assert.ok(held.ok, show(held));
  const prepared = held.value as { correlationId: string; intent?: unknown; confirm?: { url: string } };
  assert.equal(prepared.intent, undefined, "the app never holds the delegate bytes");
  const confirm = prepared.confirm;
  assert.ok(confirm?.url.startsWith(`${state.dashboard}/confirm/`), "a confirm link on the platform's host");
  const signed = await signOnConfirmPage({ browser, target, platform: PLATFORM, url: confirm!.url, owner: { accountId: owner, publicKey: state.testPublicKey } });
  assert.equal(signed.asked.filter(item => item.delegate).length, 1, "one delegate signed");
  assert.deepEqual(signed.asked.filter(item => !item.delegate).map(item => item.message?.split("\n")[0]), ["Open a MultiAgency confirm page."], "first the link's readable text");
  assert.deepEqual(signed.unexpected, []);
  for (let waited = 0; ; waited += 1_000) {
    const status = await agent.call("owner/status", { correlationId: prepared.correlationId });
    if (status.ok && (status.value as { status: string | null }).status === "SUCCESS") break;
    assert.ok(waited < 45_000, `still ${show(status)}`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  assert.equal((await overview()).policy.revision, before.policy.revision! + 1, "the overview reads the new revision");
});

test("the stack's owner signs a delegate action through its control, as the confirm page asks the wallet for it (#140)", async () => {
  const signed = await signOwnerDelegate(target, { receiverId: "outlayer.near", actions: [{ type: "FunctionCall", params: { methodName: "store_wallet_policy", args: { wallet_pubkey: "x", encrypted_data: "y" }, gas: "30000000000000", deposit: "0" } }] });
  assert.equal(signed.accountId, owner);
  assert.match(signed.signedDelegate, /^[A-Za-z0-9+/]+=*$/, "a signed delegate, base64");
  await assert.rejects(() => signOwnerDelegate(target, { receiverId: "outlayer.near", actions: [] }), "no actions is refused");
});

test("the owner issues a token for software acting for them: it reads and proposes, and once revoked its next call is refused (#139)", { timeout: 120_000 }, async () => {
  await ensureConnected();
  const access = page.getByRole("region", { name: "Access for your agent" });
  await visible(access);
  assert.deepEqual(await axe(), [], "the access section");
  await access.getByLabel("Name (optional)").fill("e2e rebalancer");
  await access.getByRole("button", { name: "Create a token" }).click();
  const shown = access.getByTestId("new-token");
  await visible(shown);
  const token = (await shown.innerText()).trim();
  assert.match(token, /^tre1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  await visible(access.getByRole("list", { name: "Access tokens" }).getByText(/^e2e rebalancer · ends .* · never used$/));
  assert.deepEqual(await axe(), [], "a token shown once");

  // Software with the token: no cookie, no origin. It reads, and proposes under a requestId it names.
  const call = (method: "GET" | "POST", path: string, body?: unknown, as = token) => fetch(`${origin}/api/agents/${target.agent}/${path}`,
    { method, headers: { authorization: `Bearer ${as}`, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  for (const path of ["overview", "strategy", "proposals"]) assert.equal((await call("GET", path)).status, 200, path);
  const proposed = await call("POST", "proposals", { requestId: `agent-${Date.now()}` });
  const answer = await proposed.json() as { ok: boolean; value?: { proposal: { id: string; state: string } }; code?: string };
  if (answer.ok) {
    assert.equal(answer.value!.proposal.state, "proposed");
    assert.equal((await call("GET", `proposals/${answer.value!.proposal.id}`)).status, 200, "one proposal");
  } else assert.ok(["nothing_to_propose", "too_many_proposals"].includes(answer.code ?? ""), `relayed and refused by the platform, not by auth: ${JSON.stringify(answer)}`);
  // What the owner decides stays the owner's.
  const approve = await call("POST", "proposals/abc/approve", {});
  assert.deepEqual([approve.status, await approve.json()], [403, { ok: false, kind: "refused", code: "token_not_allowed" }]);
  assert.equal((await call("POST", "freeze", {})).status, 403);

  // The listing says it was used; the owner revokes it, and the next call is refused.
  await page.reload();
  await signInIfAsked(access);
  const row = access.getByRole("list", { name: "Access tokens" }).getByRole("listitem").filter({ hasText: "e2e rebalancer" });
  await visible(row.getByText(/last used /));
  await row.getByRole("button", { name: "Revoke" }).click();
  await dialog("Revoke this token?").getByRole("button", { name: "Revoke the token" }).click();
  await visible(access.getByText("No tokens yet."));
  const refused = await call("GET", "overview");
  assert.deepEqual([refused.status, await refused.json()], [401, { ok: false, kind: "refused", code: "invalid_token" }]);
  assert.deepEqual(unexpected, []);
});

test("hosted creation: the exact intent is reviewed, reread before signing, and wallet refusal resumes without another preparation", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ creation, calls, messages }) => {
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    await visible(review);
    assert.equal(await review.getByLabel("Text to sign", { exact: true }).innerText(), creation.intent!.payload.message);
    assert.deepEqual(await messages(), [], "preparing never opens the wallet signature prompt");
    assert.deepEqual(await axe(), [], "the readable creation review is accessible");
    await page.evaluate(() => { (window as unknown as { __refuseNext?: boolean }).__refuseNext = true; });
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(review.getByRole("alert").filter({ hasText: "The wallet didn't sign" }));
    assert.deepEqual([calls.prepare, calls.review, calls.submit], [1, 1, 0]);
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(page.getByRole("status").filter({ hasText: "Signed; the platform is submitting it." }));
    assert.deepEqual([calls.prepare, calls.review, calls.submit], [1, 2, 1]);
    assert.deepEqual(await messages(), [creation.intent!.payload.message]);
  });
});

test("hosted creation: changed review bytes are shown again before any wallet signature", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ creation, calls, state, messages }) => {
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    await visible(review);
    state.fresh = { ...creation, intent: { ...creation.intent!, payload: { ...creation.intent!.payload, message: "Updated creation terms to review." } } };
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(review.getByRole("alert").filter({ hasText: "The creation changed" }));
    assert.equal(await review.getByLabel("Text to sign", { exact: true }).innerText(), state.fresh.intent!.payload.message);
    assert.deepEqual(await messages(), []);
    assert.equal(calls.submit, 0);
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(page.getByRole("status").filter({ hasText: "Signed; the platform is submitting it." }));
    assert.deepEqual(await messages(), [state.fresh.intent!.payload.message]);
  });
});

test("hosted creation: canceling and reopening resumes the unsigned review", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ creation, calls, messages }) => {
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    await visible(review);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    await visible(review);
    assert.equal(await review.getByLabel("Text to sign", { exact: true }).innerText(), creation.intent!.payload.message);
    assert.equal(calls.submit, 0);
    assert.deepEqual(await messages(), []);
  });
});

test("hosted creation: navigating to a cached agent during the final review read cannot sign the departed agent", { timeout: 60_000 }, async () => {
  const second = "cached-creation", base = `${origin}/api/agents/${second}`;
  const identity = async (route: Route) => route.fulfill({ json: { ok: true, value: { agent: second, owner, account: owner, agentId: null,
    host: new URL(stack.state().dashboard).host, signer: "wallet", access: { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true } } } });
  const actions = async (route: Route) => route.fulfill({ json: { ok: true, value: [] } });
  await page.route(base, identity);
  await page.route(`${base}/owner/actions`, actions);
  const navigate = async (agent: string) => {
    // A browser-history navigation preserves React and the query cache. A full document load would miss scope reuse.
    await page.evaluate(path => { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); }, `/agents/${agent}/`);
    await visible(page.getByRole("main").getByText(agent, { exact: true }));
    await visible(page.getByRole("region", { name: "Create the agent", exact: true }));
  };
  try {
    await withCreationRoutes(async ({ calls, state, messages }) => {
      await navigate(second);
      await navigate(target.agent);
      await page.getByRole("button", { name: "Create the agent", exact: true }).click();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      state.beforeReview = () => gate;
      try {
        const requested = page.waitForRequest(request => request.url().endsWith("/creation/mock-creation/review"));
        await dialog("Create this Treasury agent?").getByRole("button", { name: "Sign and create" }).click();
        await requested;
        await navigate(second);
        release();
        await page.waitForLoadState("networkidle");
        assert.deepEqual(await messages(), [], "the old scope cannot reach the wallet after its review read returns");
        assert.equal(calls.submit, 0);
      } finally { release(); }
    });
  } finally {
    await page.unroute(base, identity);
    await page.unroute(`${base}/owner/actions`, actions);
  }
});

test("hosted creation: a lost submission stays held after reload and signing expiry without another signature or POST", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ calls, state, messages, reload }) => {
    state.abortSubmit = true;
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    await dialog("Create this Treasury agent?").getByRole("button", { name: "Sign and create" }).click();
    await visible(page.getByRole("alert").filter({ hasText: "The answer was lost" }));
    assert.equal((await messages()).length, 1);
    state.pastExpiry = true;
    await reload();
    const create = page.getByRole("button", { name: "Create the agent", exact: true });
    await visible(page.getByRole("status").filter({ hasText: "An earlier one's outcome isn't known" }));
    assert.ok(await create.count() === 0 || await create.isDisabled(), "the durable submitted phase survives expiry and reload");
    assert.deepEqual([calls.prepare, calls.submit], [1, 1]);
    state.phase = "settled";
    await reload();
    await visible(page.getByRole("region", { name: "Connection", exact: true }));
    assert.equal(await page.getByRole("region", { name: "Create the agent", exact: true }).count(), 0, "settled creation status refreshes the cached unborn identity without another prepare");
    assert.deepEqual([calls.prepare, calls.submit], [1, 1]);
  });
});

test("hosted creation: proven expired setup offers renewal, including expiry during review", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ calls, state, messages, reload }) => {
    state.actionsRefusal = "not_set_up";
    await reload();
    await visible(page.getByRole("button", { name: "Set it up again", exact: true }));
    assert.equal(calls.prepare, 0, "ended authority never prepares another creation");
    state.actionsRefusal = undefined;
    await reload();
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    state.reviewRefusal = "not_set_up";
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(review.getByRole("alert").filter({ hasText: "The setup this agent was reserved with has lapsed" }));
    assert.equal(await review.getByRole("button", { name: "Sign and create" }).isDisabled(), true, "an ended review isn't offered for signing");
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await visible(page.getByRole("button", { name: "Set it up again", exact: true }));
    assert.equal(await page.getByRole("button", { name: "Create the agent", exact: true }).isDisabled(), true, "renew the ended setup before creating");
    assert.deepEqual(await messages(), []);
    assert.equal(calls.submit, 0);
  });
});

test("hosted creation: a reread that finds it submitted elsewhere or expired ends the review, then the page follows it or offers another", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ calls, state, messages }) => {
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    // Another tab signed it meanwhile: the platform's record reads it submitted.
    state.reviewRefusal = "action_pending";
    state.phase = "submitted";
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(review.getByRole("alert"));
    assert.equal(await review.getByRole("button", { name: "Sign and create" }).isDisabled(), true, "the reviewed text isn't offered again");
    assert.equal(calls.review, 1);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await visible(page.getByRole("status").filter({ hasText: "Signed; the platform is submitting it." }));
    assert.deepEqual(await messages(), []);
    assert.deepEqual([calls.prepare, calls.submit], [1, 0]);
  });
  await withCreationRoutes(async ({ calls, state, messages }) => {
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    const review = dialog("Create this Treasury agent?");
    // Its signing window closed while the owner read it: the platform's record reads it expired.
    state.reviewRefusal = "creation_expired";
    state.pastExpiry = true;
    await review.getByRole("button", { name: "Sign and create" }).click();
    await visible(review.getByRole("alert").filter({ hasText: "This creation expired unsigned" }));
    assert.equal(await review.getByRole("button", { name: "Sign and create" }).isDisabled(), true);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    state.reviewRefusal = undefined;
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    await visible(dialog("Create this Treasury agent?"));
    assert.equal(await dialog("Create this Treasury agent?").getByRole("button", { name: "Sign and create" }).isDisabled(), false, "a new review is offered again");
    assert.deepEqual(await messages(), []);
    assert.deepEqual([calls.prepare, calls.submit], [2, 0]);
  });
});

test("hosted creation: a lost unsigned review explains expiry recovery instead of exposing its refusal code", { timeout: 60_000 }, async () => {
  await withCreationRoutes(async ({ state, calls, messages }) => {
    state.prepareRefusal = "creation_review_unavailable";
    await page.getByRole("button", { name: "Create the agent", exact: true }).click();
    await visible(page.getByRole("alert").filter({ hasText: "Wait for its signing window to expire" }));
    assert.equal(await page.getByText("The server refused the request (creation_review_unavailable).", { exact: true }).count(), 0);
    assert.deepEqual(await messages(), []);
    assert.equal(calls.submit, 0);
  });
});
