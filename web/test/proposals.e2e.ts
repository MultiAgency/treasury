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
    publicOrigin: origin, deployment: state.app.deployment, trustedProxyHops: 0, ownerRequestsPerMinute: 1_000, audit, consentsPerDay: 100, keyLookup,
    page: await loadPage(join(import.meta.dirname, "..", "dist-proposals")),
  });

  browser = await chromium.launch();
  const context = await browser.newContext();
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
  await context.addInitScript(({ account, publicKey }) => {
    const accounts = [{ accountId: account, publicKey }];
    const wallet = { manifest: { id: "local-test-wallet", name: "Local test wallet", type: "injected", icon: "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>", features: { signMessage: true } },
      signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => {},
      signMessage: (payload: { message: string; recipient: string; nonce: Uint8Array }) =>
        (window as unknown as { __localSign: (p: unknown) => Promise<unknown> }).__localSign({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
      signAndSendTransaction: async () => { throw new Error("This test wallet only signs messages"); } };
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
