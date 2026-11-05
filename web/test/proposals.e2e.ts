// The proposals page, served by the app server, on its own fresh stack (platform at PLATFORM_COMMIT, `--treasury --app`):
// it records operations, so no other test shares the stack. The app server runs in-process against the stack's gateway
// with its operator-issued `tap_` credential and serves the proposals page's build (`dist-proposals/`). The owner's wallet is near-connect's
// injected-wallet interface, as the platform's own specs install it (`test/e2e/wallet.mjs`), signing through the stack's
// `signOwner` control; the stack doesn't publish its chain RPC, so the server's key check is a stand-in for the owner's key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { appClient, proposalText, type ProposalView } from "@multiagency/sdk";
import { chromium, type Browser, type Page } from "playwright";
import { fileAudit } from "../../apps/server/src/audit.ts";
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
import { ETH, fundPublic, setTargets, signOwner, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../scripts/stack.ts";
import { tempDir } from "../../scripts/temp-dirs.ts";

const PLATFORM = process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "..", "..", "..", "platform");
const audit = fileAudit(join(tempDir("treasury-proposals-"), "audit.jsonl"));
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, owner: string;
let server: Server, origin: string, browser: Browser, page: Page;
/** Requests the page made anywhere but this server and the wallet's boundary: none are expected. */
const unexpected: string[] = [];
/** What the owner's wallet was asked to send, in order: it sends nothing on the stack, whose chain takes no transactions. */
const sent: { signerId: string; receiverId: string; actions: { params: { methodName: string; args: Record<string, unknown>; deposit: string } }[] }[] = [];

before(async () => {
  stack = await startStack({ args: ["--no-browser", "--app", "treasury-test"] });
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
    page: await loadPage(join(import.meta.dirname, "..", "dist-proposals")),
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
      signMessage: (payload: { message: string; recipient: string; nonce: Uint8Array }) =>
        (window as unknown as { __localSign: (p: unknown) => Promise<unknown> }).__localSign({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
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
const axe = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations
  .map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);
const dialog = (name: string) => page.getByRole("dialog", { name });
/** A link of the agent's navigation. */
const nav = (name: string) => page.getByRole("navigation", { name: "Agent pages" }).getByRole("link", { name });
/** The page `address` names, for the agent: its own `<h1>`, and the navigation marking it. */
const here = (path = "") => `${origin}/agents/${target.agent}${path}`;
/** Signs in when the page asks (a test before may have signed out), then waits for `shown`. */
async function signInIfAsked(shown: ReturnType<Page["getByRole"]>) {
  const signIn = page.getByRole("button", { name: "Sign in with wallet" });
  await signIn.or(shown).first().waitFor({ timeout: 20_000 });
  if (await signIn.isVisible()) await signIn.click();
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
  const text = consentText({ identity: { agent: target.agent, owner, agentId: state.treasury.agentId, host: new URL(state.dashboard).host }, deployment: state.app!.deployment });
  const signed = await signOwner(target, text);
  assert.equal(await call("/consent", { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature }), 200, "the older connection is stored");
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

test("the owner signs in with their wallet, connects the agent with a consent they read first, and sees no proposals yet", { timeout: 120_000 }, async () => {
  await page.goto(here());
  assert.equal(await page.title(), "Treasury proposals · Home");
  await visible(page.getByRole("heading", { level: 1, name: "Home" }));
  await visible(page.getByRole("heading", { level: 2, name: "Sign in" }));
  assert.deepEqual(await axe(), [], "signed out");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await visible(page.getByText(`Signed in as ${owner}`));

  const connection = page.getByRole("region", { name: "Connection" });
  await visible(connection.getByRole("status").filter({ hasText: "Not connected" }));
  await visible(nav("Home").and(page.locator("[aria-current=page]")));
  assert.deepEqual(await axe(), [], "signed in, not connected");

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
  await visible(page.getByText("Connected. The agent's proposals now reach this page."));
  assert.deepEqual(await axe(), []);
  await nav("Proposals").click();
  await visible(page.getByRole("heading", { level: 1, name: "Proposals" }));
  await visible(page.getByRole("region", { name: "Proposals" }).getByText(/No proposals yet/));
});

test("the owner approves a proposal by its exact text, executes it once to executed, and rejects another", { timeout: 180_000 }, async () => {
  const first = await propose(`page-${Date.now()}-1`), second = await propose(`page-${Date.now()}-2`);
  await page.goto(here("/proposals"));
  const list = page.getByRole("list", { name: "Proposals" });
  await visible(list);
  assert.equal(await list.getByRole("link", { name: /^Review proposal / }).count(), 2);
  await visible(list.getByText("Swap 1 USDC for at least 0.4995 wNEAR").first());
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
  await run.getByRole("button", { name: "Execute now" }).click();
  await visible(state.getByRole("status").filter({ hasText: "Executed. Every swap succeeded." }));
  await visible(state.getByText("Executed", { exact: true }));
  await visible(state.getByRole("list", { name: "Operations" }).getByText("success"));
  assert.equal(await state.getByRole("button", { name: "Execute" }).count(), 0, "it ran once; nothing to execute again");
  assert.deepEqual(await axe(), [], "an executed proposal");

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

  const lines = readFileSync(audit.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
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
  for (const name of ["Needs attention", "Activity", "Autopilot runs"]) await portfolio.getByRole("heading", { name }).waitFor();
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
  // The books are on the home page, with the rest of the portfolio.
  await nav("Home").click();
  await visible(page.getByRole("region", { name: "Portfolio" }).getByRole("table", { name: "Books" }));
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

test("the owner allows owner actions: told first that open proposals are withdrawn, then the connection is replaced by one with owner", { timeout: 90_000 }, async () => {
  await setTargets(target, { [USDC]: 10_000, [WNEAR]: 0, [ETH]: 0 });
  const open = await propose(`page-${Date.now()}-owner`);
  await page.goto(`${origin}/agents/${target.agent}`);
  const connection = page.getByRole("region", { name: "Connection" });
  await signInIfAsked(connection.getByRole("status").filter({ hasText: /^Connected: / }));
  await connectWithoutOwner();
  await page.reload();
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

test("each of the agent's pages opens by its address, with its own heading and the navigation marking it, and passes an axe scan", { timeout: 120_000 }, async () => {
  // Disconnecting ended the last test with the agent not connected: connect it again, so every page has what it shows.
  await page.goto(here());
  const connection = page.getByRole("region", { name: "Connection" });
  await signInIfAsked(connection);
  await connection.getByRole("button", { name: "Connect" }).click();
  await dialog("Connect this agent to the Treasury app?").getByRole("button", { name: "Sign and connect" }).click();
  await visible(connection.getByRole("status").filter({ hasText: /^Connected: / }));
  const made = await propose(`page-${Date.now()}-pages`);
  const pages: [string, string, string][] = [["", "Home", "Home"], ["/", "Home", "Home"], ["/proposals", "Proposals", "Proposals"],
    [`/proposals/${made.id}`, "Proposal", "Proposals"], ["/strategy", "Strategy", "Strategy"], ["/funding", "Funding", "Funding"]];
  for (const [path, title, current] of pages) {
    await page.goto(here(path));
    await visible(page.getByRole("heading", { level: 1, name: title, exact: true }));
    assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, `${path}: one h1`);
    assert.equal(await page.title(), `Treasury proposals · ${title}`, path);
    await visible(nav(current).and(page.locator("[aria-current=page]")));
    assert.equal(await page.locator("nav[aria-label='Agent pages'] [aria-current=page]").count(), 1, `${path}: one page marked`);
    assert.deepEqual(await axe(), [], `${path}: the page`);
  }
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
  assert.equal(await page.title(), "Treasury proposals · Page not found");
  assert.deepEqual(await axe(), [], "a bad agent name");

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
