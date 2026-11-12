// The app for a DAO-owned agent, served by the app server, on its own fresh stack (platform at
// PLATFORM_COMMIT, `--dao-treasury --app`). The signed-in member is the DAO's council; their wallet is near-connect's
// injected-wallet interface, signing with the member's own key, and it sends nothing: the transaction it's given is
// checked and recorded, and the DAO's vote on it is the stack's `daoVote` control. The server reads the DAO's policy
// from the stack's chain.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { checkStrategyReview } from "./strategy-review.ts";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { appClient, type ProposalView } from "@multiagency/sdk";
import { chromium, type Browser, type Page } from "playwright";
import { chainedFileAudit } from "../../apps/server/src/chain.ts";
import { createCredential } from "../../apps/server/src/credential.ts";
import { chainDaos, type DaoProposal } from "../../apps/server/src/dao.ts";
import { createDaoRequests } from "../../apps/server/src/dao-requests.ts";
import { createServer } from "../../apps/server/src/http.ts";
import { standInKeyLookup } from "../../apps/server/src/keys.ts";
import { loadPage } from "../../apps/server/src/page.ts";
import { createPlatform } from "../../apps/server/src/platform.ts";
import { createSessions } from "../../apps/server/src/sessions.ts";
import { createSignIn } from "../../apps/server/src/signin.ts";
import { createStrategyProposals, memoryProposalRecords } from "../../apps/server/src/strategy-proposals.ts";
import { wallet } from "../../apps/server/test/fakes.ts";
import { daoConfidentialSetup, daoVote, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../scripts/stack.ts";
import { tempDir } from "../../scripts/temp-dirs.ts";

const PLATFORM = process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "..", "..", "..", "platform");
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, dao: string, council: ReturnType<typeof wallet>;
let chainProposals: DaoProposal[] | undefined;
let server: Server, origin: string, browser: Browser, page: Page;
/** The strategies proposed for the agent, as the server keeps them: a test proposes one here, as Ballast's mandate would. */
let strategyProposals: ReturnType<typeof createStrategyProposals>;
/** Requests the page made anywhere but this server and the wallet's boundary: none are expected. */
const unexpected: string[] = [];
/** What the member's wallet was asked to send, in order. */
const sent: { signerId: string; receiverId: string; actions: unknown[] }[] = [];
/** What Trezu was asked to file as the DAO's proposals, in order: it files nothing on the stack. */
const filed: { signerId: string; receiverId: string; actions: { params: { methodName: string; args: Record<string, unknown> } }[] }[] = [];

/** The NEP-413 hash a member's filing asks the DAO to sign: the argument of its proposal's `v1.signer` call. */
function hashOf(transaction: { actions: unknown[] }): string {
  const [action] = transaction.actions as { params: { methodName: string; args: { proposal: { kind: { FunctionCall: { actions: { args: string }[] } } } } } }[];
  assert.equal(action!.params.methodName, "add_proposal");
  return JSON.parse(Buffer.from(action!.params.args.proposal.kind.FunctionCall.actions[0]!.args, "base64").toString()).request.payload_v2.Eddsa;
}

before(async () => {
  stack = await startStack({ owner: "dao", args: ["--no-browser", "--app", "treasury-test"] });
  target = stack.target;
  const state = stack.state();
  assert.ok(state.app && state.dao, "the stack was started with --dao-treasury --app");
  dao = state.dao.account;
  council = wallet(state.dao.council);
  let handle: (req: IncomingMessage, res: ServerResponse) => void = (_, res) => { res.writeHead(503).end(); };
  server = createHttpServer((req, res) => handle(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const keyLookup = standInKeyLookup({ [council.accountId]: [council.publicKey] });
  // The store the server records through (`main.ts`): a hash chain, checked before the first append.
  const audit = chainedFileAudit(join(tempDir("treasury-dao-proposals-"), "audit.jsonl"));
  await audit.check();
  strategyProposals = createStrategyProposals(memoryProposalRecords(), { audit });
  const daos = chainDaos({ rpcUrl: state.chain.rpc, apiKey: undefined, timeoutMs: 5_000 });
  handle = createServer({
    platform: createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile), timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) }),
    signIn: createSignIn({ recipient: new URL(origin).host, ttlMs: 5 * 60_000, perMinute: 100, keyLookup }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: origin, deployment: state.app.deployment, trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit, consentsPerDay: 100, daoFilingsPerDay: 1_000, keyLookup,
    daos: { ...daos, proposals: async (dao, from) => chainProposals ? { next: chainProposals.length, proposals: chainProposals.filter(p => p.id >= from) } : daos.proposals(dao, from) },
    daoRequests: await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json")),
    strategyProposals,
    page: await loadPage(join(import.meta.dirname, "..", "dist")),
  });

  browser = await chromium.launch();
  // Reduced motion, which the page honours by dropping transitions: a button whose colours are still fading when the
  // accessibility check reads them (here, "Check again" while the request is read again) fails it at random.
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
  await context.exposeFunction("__memberSign", (payload: { message: string; recipient: string; nonce: string }) => council.sign(payload));
  // The wallet's success for a sent transaction; the DAO's proposal it would file passes at once.
  await context.exposeFunction("__memberSend", async (transaction: { signerId: string; receiverId: string; actions: unknown[] }) => {
    sent.push(transaction);
    await daoVote(target, hashOf(transaction));
    return { status: { SuccessValue: "" } };
  });
  // Trezu, connected as the DAO: what it's sent, it would file as the DAO's proposal. Recorded, never filed.
  await context.exposeFunction("__trezuSend", (transaction: (typeof filed)[number]) => { filed.push(transaction); return { status: { SuccessValue: "" } }; });
  await context.addInitScript(({ account, publicKey, dao }) => {
    const accounts = [{ accountId: account, publicKey }];
    const call = (window as unknown as Record<"__memberSign" | "__memberSend" | "__trezuSend", (p: unknown) => Promise<unknown>>);
    const icon = "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
    const daoAccounts = [{ accountId: dao, publicKey }];
    const trezu = { manifest: { id: "trezu-wallet", name: "Trezu", type: "injected", icon, features: {} },
      signIn: async () => daoAccounts, getAccounts: async () => daoAccounts, signOut: async () => {},
      signAndSendTransaction: (transaction: unknown) => call.__trezuSend(transaction) };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: trezu })));
    const memberWallet = { manifest: { id: "local-test-wallet", name: "Local test wallet", type: "injected", icon: "data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>", features: { signMessage: true } },
      signIn: async () => accounts, getAccounts: async () => accounts, signOut: async () => {},
      signMessage: (payload: { message: string; recipient: string; nonce: Uint8Array }) =>
        call.__memberSign({ ...payload, nonce: btoa(String.fromCharCode(...new Uint8Array(payload.nonce))) }),
      signAndSendTransaction: (transaction: unknown) => call.__memberSend(transaction) };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: memberWallet })));
    localStorage.setItem("proposals:selected-wallet:mainnet", "local-test-wallet");
  }, { account: council.accountId, publicKey: council.publicKey, dao: state.dao.account });
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
const fileButton = (scope: ReturnType<Page["getByRole"]>) => scope.getByRole("button", { name: /^File (the DAO proposal|and vote)$/ });

test("a council member asks the DAO to connect the agent, files its proposal from their wallet, and the page shows it connected once the vote passes", { timeout: 120_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}`);
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await page.getByText("Local test wallet", { exact: true }).click();
  await visible(page.getByText(`Signed in as ${council.accountId}`));
  const connection = page.getByRole("region", { name: "Connection" });
  await visible(connection.getByRole("status").filter({ hasText: `Not connected. ${dao} consents by its own vote` }));
  assert.deepEqual(await axe(), [], "not connected");

  await connection.getByRole("button", { name: "Ask the DAO to connect it" }).click();
  await visible(connection.getByRole("status").filter({ hasText: `Waiting for the vote of ${dao} to connect this agent.` }));
  assert.ok(await connection.getByRole("list", { name: "What the DAO votes on" }).isVisible());
  assert.deepEqual(await axe(), [], "waiting for the vote");

  await fileButton(connection).click();
  await visible(connection.getByRole("status").filter({ hasText: /^Connected by the vote of / }));
  assert.equal(sent.length, 1, "filed once");
  assert.deepEqual([sent[0]!.signerId, sent[0]!.receiverId], [council.accountId, dao], "from the member's wallet, to the DAO");
  const standing = page.getByRole("region", { name: "Where the agent stands" });
  await visible(standing.getByRole("listitem").filter({ hasText: /^Funds/ }));
  assert.equal(await standing.getByRole("listitem").filter({ hasText: /^Account/ }).count(), 0, "a DAO has no funding-account setup step");
  assert.deepEqual(await axe(), [], "connected");
});

test("a council member asks the DAO to approve a proposal, files the vote from their wallet, and the page shows it approved", { timeout: 120_000 }, async () => {
  const state = stack.state();
  const app = appClient({ base: state.dashboard as `https://${string}`, credential: readFileSync(state.app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const made = await app.agent(dao.replaceAll(".", "--"), target.agent).call("proposals/create",
    { requestId: `dao-page-${Date.now()}`, legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  assert.ok(made.ok, JSON.stringify(made));
  const proposal = made.value as ProposalView;

  await page.goto(`${origin}/agents/${target.agent}/proposals/${proposal.id}`);
  const region = page.getByRole("region", { name: "State" });
  await visible(region.getByRole("button", { name: "Ask the DAO to approve" }));
  await region.getByRole("button", { name: "Ask the DAO to approve" }).click();
  await visible(region.getByRole("status").filter({ hasText: `${dao} votes to approve this proposal.` }));
  assert.deepEqual(await axe(), [], "the DAO's vote waiting");

  // The simulated chain normally has no pending proposals. Supply its read boundary with the exact
  // proposal the server offered, without executing the vote, to exercise approvals through HTTP and the UI.
  const pending = await page.evaluate(async agent => (await (await fetch(`/api/agents/${agent}/proposals/${location.pathname.split("/").at(-1)}`)).json()).value, target.agent);
  const transaction = pending.vote.offer.transaction;
  chainProposals = [{ id: 0, status: "InProgress", submission_time: String(BigInt(Date.now()) * 1_000_000n),
    kind: transaction.actions[0].params.args.proposal.kind, votes: { "alice.near": "Approve", "bob.near": "Reject" } }];
  await region.getByRole("button", { name: "Check again" }).click();
  await visible(region.getByRole("status", { name: "Votes so far" }));
  const treasury = await page.evaluate(async agent => (await (await fetch(`/api/agents/${agent}/treasury`)).json()).value.treasury, target.agent);
  const votes = await region.getByRole("status", { name: "Votes so far" }).innerText();
  assert.ok(votes.includes("Approved by alice.near"));
  assert.ok(!votes.includes("bob.near"));
  for (const approver of treasury.dao.approvers) assert.ok(votes.includes(`${approver.role}: ${approver.threshold}`));
  assert.deepEqual(await axe(), [], "recorded approvals and platform threshold");
  chainProposals = undefined;
  await region.getByRole("button", { name: "Check again" }).click();
  await visible(fileButton(region));

  // The open vote is on the home with its deadline, linking to the proposal where it is filed (#130).
  await page.getByRole("navigation", { name: "Agent pages" }).getByRole("link", { name: "Home" }).click();
  const needs = page.getByRole("region", { name: "Needs your decision" });
  const waiting = needs.getByRole("listitem").filter({ hasText: "Waiting for the DAO's vote to approve a proposal" });
  await visible(waiting);
  await visible(waiting.getByText(/^Expires /));
  assert.deepEqual(await axe(), [], "the home, with the DAO's vote waiting");
  await waiting.getByRole("link", { name: /^Review proposal / }).click();
  await visible(region.getByRole("status").filter({ hasText: `${dao} votes to approve this proposal.` }));

  await fileButton(region).click();
  await visible(region.getByText("Approved", { exact: true }));
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1]!.signerId, sent[1]!.receiverId], [council.accountId, dao]);
  assert.deepEqual(await axe(), [], "approved");
  assert.deepEqual(unexpected, [], "the page reached nothing but this server and the wallet's boundary");
});

test("the DAO funds its agent from its own account: no link controls, and Trezu files exactly the reviewed USDC transfer as the DAO's proposal", { timeout: 90_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}/funding`);
  const funding = page.getByRole("region", { name: "Funding" });
  await visible(funding);
  await visible(funding.getByRole("status").filter({ hasText: `Funded from ${dao}, a DAO with ` }));
  assert.equal(await funding.getByRole("button", { name: "Unlink" }).count(), 0, "a DAO agent's funding account is fixed");
  assert.deepEqual(await axe(), [], "the DAO's funding account");

  await funding.getByLabel("Funding amount").fill("2");
  await funding.getByRole("button", { name: "Review proposal" }).click();
  const review = funding.getByRole("group", { name: "Funding transfer to sign" });
  await visible(review);
  assert.match(await review.innerText(), new RegExp(`The proposal pays exactly 2 USDC from ${dao.replaceAll(".", "\\.")}`));
  const address = (await review.locator("code").first().innerText()).trim();
  await review.getByRole("button", { name: "File funding proposal" }).click();
  await visible(funding.getByRole("status").filter({ hasText: /^Filed in Trezu\./ }));
  assert.equal(filed.length, 1, "filed once");
  assert.equal(filed[0]!.signerId, dao, "as the DAO, through Trezu");
  const ft = filed[0]!.actions.find(action => action.params.methodName === "ft_transfer")!;
  assert.deepEqual([ft.params.args.receiver_id, ft.params.args.amount], [address, "2000000"]);
  assert.deepEqual(await axe(), [], "filed");
  assert.deepEqual(unexpected, []);
});

test("a confidential DAO is offered both ways to fund its agent, the confidential balance first; Trezu files exactly the reviewed transfer from the public one (#214)", { timeout: 90_000 }, async () => {
  await daoConfidentialSetup(target);
  await page.goto(`${origin}/agents/${target.agent}/funding`);
  const funding = page.getByRole("region", { name: "Funding" });
  const paths = funding.getByRole("region", { name: /^From the (confidential|public) balance$/ });
  await visible(paths.nth(1));
  assert.deepEqual(await paths.evaluateAll(sections => sections.map(section => section.getAttribute("aria-labelledby"))),
    ["money-in-confidential", "money-in-public"], "the confidential path first");
  const confidential = funding.getByRole("region", { name: "From the confidential balance" });
  await visible(confidential.getByRole("link", { name: "Open payment in Trezu" }));
  assert.match(await confidential.locator("code").first().innerText(), /^nearcom:\S+$/);
  assert.deepEqual(await axe(), [], "both paths");

  const open = funding.getByRole("region", { name: "From the public balance" });
  await open.getByLabel("Funding amount").fill("3");
  await open.getByRole("button", { name: "Review proposal" }).click();
  const review = open.getByRole("group", { name: "Funding transfer to sign" });
  await visible(review);
  assert.match(await review.innerText(), new RegExp(`The proposal pays exactly 3 USDC from ${dao.replaceAll(".", "\\.")}`));
  const address = (await review.locator("code").first().innerText()).trim();
  const filedBefore = filed.length;
  await review.getByRole("button", { name: "File funding proposal" }).click();
  await visible(open.getByRole("status").filter({ hasText: /^Filed in Trezu\./ }));
  assert.equal(filed.length, filedBefore + 1, "filed once");
  assert.equal(filed.at(-1)!.signerId, dao, "as the DAO, through Trezu");
  const ft = filed.at(-1)!.actions.find(action => action.params.methodName === "ft_transfer")!;
  assert.deepEqual([ft.params.args.receiver_id, ft.params.args.amount], [address, "3000000"]);
  assert.deepEqual(unexpected, []);
});

test("a council member asks the DAO to authorize the saved strategy: filed from their wallet, voted, and the strategy reads bound", { timeout: 120_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}/strategy`);
  const autopilot = page.getByRole("region", { name: "Autopilot" });
  await visible(autopilot);
  const ask = autopilot.getByRole("button", { name: "Ask the DAO to authorize this strategy" });
  await ask.waitFor({ timeout: 20_000 });
  assert.deepEqual(await axe(), [], "unbound");
  const filedBefore = sent.length;
  await ask.click();
  const authorize = dialog("Authorize this saved strategy?");
  await visible(authorize);
  await checkStrategyReview(page, target.agent);
  await authorize.getByRole("button", { name: "File in your wallet" }).click();
  await visible(autopilot.getByText(/^Filed with your approval\. If the DAO needs more votes/));
  await autopilot.getByRole("button", { name: "Turn on", disabled: false }).waitFor({ timeout: 45_000 });
  assert.equal(sent.length, filedBefore + 1, "filed once, from the member's wallet");
  assert.ok((sent.at(-1)!.actions as { params: { methodName: string } }[]).some(action => action.params.methodName === "act_proposal"), "the filing casts the member's approval");
  assert.deepEqual([sent.at(-1)!.signerId, sent.at(-1)!.receiverId], [council.accountId, dao]);
  assert.deepEqual(await axe(), [], "authorized");
});

test("a council member adopts a proposed strategy, shown beside the saved one with its source and reasons; the DAO's grant vote is filed, and the strategy reads bound (#206)", { timeout: 150_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}/strategy`);
  const autopilot = page.getByRole("region", { name: "Autopilot" });
  await visible(autopilot);
  // The saved strategy, read as the page reads it, and a proposal against it: 60% USDC, 40% wNEAR, as the balanced profile compiles.
  const saved = await page.evaluate(async agent => (await (await fetch(`/api/agents/${agent}/strategy`)).json()).value, target.agent) as
    { digest: string; strategy: { minLegUsd: number; autopilot: { everyMin: number; maxUsd: number } } };
  const proposed = await strategyProposals.propose({ agent: target.agent, from: "mandate", against: saved.digest, policyAssets: "any",
    strategy: { targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, "nep141:eth.omft.near": 0 }, minLegUsd: saved.strategy.minLegUsd, maxCostBps: 50, autopilot: saved.strategy.autopilot, cashFloor: { usd: 1, assets: [USDC] } },
    reasons: "Ballast's balanced profile: 40% volatile in wNEAR, and 35% reserve and 25% operating cash in USDC." });
  assert.ok(proposed.ok);

  await autopilot.getByRole("button", { name: "Check again" }).click();
  const proposals = autopilot.getByRole("region", { name: "Proposed strategies" });
  await visible(proposals);
  await visible(proposals.getByRole("heading", { name: "Ballast's mandate" }));
  await visible(proposals.getByText("Ballast's balanced profile: 40% volatile in wNEAR"));
  const wnear = proposals.getByRole("row", { name: /wNEAR target/ });
  assert.match(await wnear.innerText(), /40%/);
  assert.deepEqual(await axe(), [], "a proposal listed");

  await proposals.getByRole("button", { name: "Adopt" }).click();
  const adopt = dialog("Adopt this strategy?");
  await visible(adopt);
  assert.match(await adopt.innerText(), /by the DAO's vote on its grant/);
  await adopt.getByRole("button", { name: "Adopt and save" }).click();
  await visible(autopilot.getByRole("status").filter({ hasText: "Proposal adopted and saved. Authorize it next." }));
  await proposals.waitFor({ state: "detached", timeout: 20_000 });
  await visible(autopilot.getByRole("list", { name: "Strategy targets" }).getByRole("listitem").filter({ hasText: /^\s*wNEAR\s*:\s*40%/ }));

  const filedBefore = sent.length;
  await autopilot.getByRole("button", { name: "Ask the DAO to authorize this strategy" }).click();
  const authorize = dialog("Authorize this saved strategy?");
  await visible(authorize);
  await checkStrategyReview(page, target.agent);
  await authorize.getByRole("button", { name: "File in your wallet" }).click();
  await autopilot.getByRole("button", { name: "Turn on", disabled: false }).waitFor({ timeout: 45_000 });
  assert.equal(sent.length, filedBefore + 1, "the grant filed once, from the member's wallet");
  await visible(autopilot.getByText("Authorized: the agent's grant binds this strategy."));
  assert.equal(await autopilot.getByText("Authorize it next.", { exact: false }).count(), 0, "the prompt to authorize goes once the grant binds");
  assert.deepEqual(await axe(), [], "adopted and authorized");
  assert.deepEqual(unexpected, []);
});

test("a council member proposes to freeze the DAO's agent from the frame: filed from their wallet, its vote shown; then proposes to unfreeze", { timeout: 180_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}`);
  const stop = page.getByRole("region", { name: "Emergency stop" });
  await visible(stop);
  await visible(stop.getByText("Not frozen."));
  assert.equal(await stop.getByRole("button", { name: "Freeze", exact: true }).count(), 0, "a DAO's member proposes, never signs");
  const filedBefore = sent.length;
  await stop.getByRole("button", { name: "Propose to freeze" }).click();
  const confirm = dialog("Freeze this agent?");
  await visible(confirm);
  assert.match(await confirm.innerText(), /with your approval if your roles let you vote; the vote must pass within minutes/);
  assert.deepEqual(await axe(), [], "the freeze dialog, for a DAO");
  await confirm.getByRole("button", { name: "File in your wallet" }).click();
  await visible(stop.getByText(/^Filed with your approval\. If the DAO needs more votes, they must come by /).or(stop.getByText("Frozen: the agent refuses every send.")));
  assert.equal(sent.length, filedBefore + 1, "filed once, from the member's wallet");
  assert.deepEqual([sent.at(-1)!.signerId, sent.at(-1)!.receiverId], [council.accountId, dao]);
  await stop.getByText("Frozen: the agent refuses every send.").waitFor({ timeout: 60_000 });
  assert.deepEqual(await axe(), [], "frozen, by the DAO's vote");

  await stop.getByRole("button", { name: "Propose to unfreeze" }).click();
  const back = dialog("Unfreeze this agent?");
  await visible(back);
  await back.getByRole("button", { name: "File in your wallet" }).click();
  await stop.getByText("Not frozen.").waitFor({ timeout: 60_000 });
  assert.equal(sent.length, filedBefore + 2);
  assert.deepEqual(unexpected, []);
});

test("a council member sees the DAO's grants on the policy page, told the vote window before asking to revoke one; the dialog files for the vote, never signs", { timeout: 90_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}/policy`);
  const grants = page.getByRole("region", { name: "Grants" });
  await visible(grants);
  await visible(grants.getByText(/put to the DAO's vote, which has about 5 minutes \(290 seconds\) to pass/));
  const live = grants.getByRole("list", { name: "Live grants" });
  await visible(live.getByRole("listitem").first());
  assert.equal(await grants.getByRole("button", { name: /^Revoke grant/ }).count(), 0, "a DAO's member proposes, never signs");
  const revoke = live.getByRole("button", { name: /^Propose to revoke grant/ }).first();
  await revoke.focus();
  await page.keyboard.press("Enter");
  const confirm = dialog("Revoke this grant?");
  await visible(confirm);
  assert.match(await confirm.innerText(), /with your approval if your roles let you vote; the vote has about 5 minutes \(290 seconds\) to pass, and until then the grant stays live/);
  assert.deepEqual(await axe(), [], "the revoke dialog, for a DAO");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(await axe(), [], "the policy page, for a DAO");
});

test("a council member proposes a policy edit: told the vote windows first, shown the terms before and after, files it from their wallet, and the policy reads the new rate once the vote passes", { timeout: 180_000 }, async () => {
  await page.goto(`${origin}/agents/${target.agent}/policy`);
  const terms = page.getByRole("region", { name: "Policy as signed" });
  await visible(terms.getByText(/about 290 seconds, or 600 seconds for an edit that changes an on-chain field/));
  assert.equal(await terms.getByRole("button", { name: "Edit", exact: true }).count(), 0, "a DAO's member proposes, never signs");
  await terms.getByRole("button", { name: "Propose an edit" }).click();
  const rate = terms.getByLabel("Actions an hour (blank for no cap)");
  await visible(rate);
  const next = (await terms.getByText("7 actions an hour").count()) ? "9" : "7";
  await rate.fill(next);
  await terms.getByRole("button", { name: "Review the changes" }).click();
  const confirm = dialog("Change this policy?");
  await visible(confirm);
  assert.match(await confirm.innerText(), /you compare the terms, then file it/);
  assert.deepEqual(await axe(), [], "the review dialog, for a DAO");
  const filedBefore = sent.length;
  await confirm.getByRole("button", { name: "Prepare for the DAO's vote" }).click();
  const compare = terms.getByRole("region", { name: "Terms before and after" });
  await visible(compare);
  assert.equal(sent.length, filedBefore, "nothing filed until the member has compared");
  await visible(compare.getByRole("table").or(compare.getByText("The platform reported no terms to compare.")));
  assert.deepEqual(await axe(), [], "the comparison");
  await compare.getByRole("button", { name: "File and vote" }).click();
  await terms.getByText(`${next} actions an hour`).waitFor({ timeout: 90_000 });
  assert.equal(sent.length, filedBefore + 1, "filed once, from the member's wallet");
  assert.deepEqual([sent.at(-1)!.signerId, sent.at(-1)!.receiverId], [council.accountId, dao]);
  assert.deepEqual(unexpected, []);
});
