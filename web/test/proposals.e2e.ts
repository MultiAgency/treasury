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
import { createCredential } from "../../apps/server/src/credential.ts";
import { createDaoRequests } from "../../apps/server/src/dao-requests.ts";
import { standInDaos } from "../../apps/server/src/dao.ts";
import { createServer } from "../../apps/server/src/http.ts";
import { standInKeyLookup } from "../../apps/server/src/keys.ts";
import { loadPage } from "../../apps/server/src/page.ts";
import { createPlatform } from "../../apps/server/src/platform.ts";
import { createSessions } from "../../apps/server/src/sessions.ts";
import { createSignIn } from "../../apps/server/src/signin.ts";
import { signOwner, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../scripts/stack.ts";
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
/** Signs in when the page asks (a test before may have signed out), then waits for `shown`. */
async function signInIfAsked(shown: ReturnType<Page["getByRole"]>) {
  const signIn = page.getByRole("button", { name: "Sign in with wallet" });
  await signIn.or(shown).first().waitFor({ timeout: 20_000 });
  if (await signIn.isVisible()) await signIn.click();
  await visible(shown);
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
  await page.goto(`${origin}/agents/${target.agent}`);
  assert.equal(await page.title(), "Treasury proposals");
  await visible(page.getByRole("heading", { level: 1, name: "Treasury proposals" }));
  await visible(page.getByRole("heading", { level: 2, name: "Sign in" }));
  assert.deepEqual(await axe(), [], "signed out");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await visible(page.getByText(`Signed in as ${owner}`));

  const connection = page.getByRole("region", { name: "Connection" });
  await visible(connection.getByRole("status").filter({ hasText: "Not connected" }));
  await visible(page.getByRole("region", { name: "Proposals" }).getByText(/No proposals yet|isn't connected|No live consent/));
  assert.deepEqual(await axe(), [], "signed in, not connected");

  await connection.getByRole("button", { name: "Connect" }).click();
  const consent = dialog("Connect this agent to the Treasury app?");
  await visible(consent);
  const text = await consent.getByLabel("Text to sign").innerText();
  assert.match(text, new RegExp(`${target.agent}`), "the platform's consent text, naming the agent");
  assert.match(text, /treasury/);
  assert.deepEqual(await axe(), [], "the consent dialog");
  await consent.getByRole("button", { name: "Sign and connect" }).click();
  await visible(connection.getByRole("status").filter({ hasText: /^Connected: read and treasury, until / }));
  await visible(page.getByText("Connected. The agent's proposals now reach this page."));
  assert.deepEqual(await axe(), []);
});

test("the owner approves a proposal by its exact text, executes it once to executed, and rejects another", { timeout: 180_000 }, async () => {
  const first = await propose(`page-${Date.now()}-1`), second = await propose(`page-${Date.now()}-2`);
  await page.goto(`${origin}/agents/${target.agent}`);
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
  await page.goto(`${origin}/agents/${target.agent}`);
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
