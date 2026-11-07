// The server against the platform's stack (platform at PLATFORM_COMMIT, `--treasury --app`): a real gateway, the
// stack's own Treasury agent `portfolio` and its operator-issued `tap_` credential. Sign-in uses the stack's
// `signOwner` control, as the owner's wallet would. The stack doesn't publish its chain RPC, so the key check uses a
// stand-in built from the stack's own owner account and key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { appClient, proposalText, type ProposalView } from "@multiagency/sdk";
import type { AddressInfo } from "node:net";
import { authorizeStrategy, ETH, fundPublic, setTargets, signOwner, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../../scripts/stack.ts";
import type { z } from "zod";
import { chainedFileAudit, verifyChain } from "../src/chain.ts";
import * as contract from "../src/contract.ts";
import { createCredential } from "../src/credential.ts";
import { createServer } from "../src/http.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createPlatform } from "../src/platform.ts";
import { createRequests } from "../src/requests.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { createWatch } from "../src/watch.ts";
import { HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const intruder = wallet("intruder.near");
const clock = { now: Date.now() };
// The store the server records through (`main.ts`): a hash chain, checked before the first append.
const audit = chainedFileAudit(join(tempDir("treasury-stack-"), "audit.jsonl"));
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, owner: string, server: Server, base: string;
let platform: ReturnType<typeof createPlatform>;

before(async () => {
  await audit.check();
  stack = await startStack({ args: ["--no-browser", "--app", "treasury-test"] });
  target = stack.target;
  const state = stack.state();
  owner = state.ownerAccount;
  assert.ok(state.app, "the stack was started with --app");
  const keyLookup = standInKeyLookup({ [owner]: [state.testPublicKey], [intruder.accountId]: [intruder.publicKey] });
  platform = createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile), timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) });
  server = createHttpServer(createServer({
    platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 100, keyLookup }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000, now: () => clock.now }),
    publicOrigin: ORIGIN,
    deployment: state.app.deployment,
    ownerRequestsPerMinute: 1_000,
    trustedProxyHops: 0,
    audit,
    consentsPerDay: 1_000, daoFilingsPerDay: 1_000,
    keyLookup,
    daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, { timeout: 180_000 });

after(async () => {
  server?.close();
  await stack?.stop();
});

const write = { origin: ORIGIN, "content-type": "application/json" };
const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: { ...write, ...(cookie && { cookie }) }, body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
const challenge = async () => ((await (await post("/api/session/challenge", {})).json()) as { value: { message: string; recipient: string; nonce: string } }).value;
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

test("the stack's owner signs in with their wallet's signature and reads their agent through the platform", async () => {
  const issued = await challenge();
  const signed = await signOwner(target, issued);
  assert.equal(signed.accountId, owner);
  const signedIn = await post("/api/session", { ...signed, nonce: issued.nonce });
  assert.deepEqual(await signedIn.json(), { ok: true, value: { account: owner } });
  const agent = await get(`/api/agents/${target.agent}`, cookieOf(signedIn));
  assert.equal(agent.status, 200);
  const { value } = await agent.json() as { value: { agent: string; owner: string; agentId: string | null; host: string } };
  assert.equal(value.owner, owner);
  assert.equal(value.agentId, stack.state().treasury.agentId);
  assert.equal(value.host, new URL(stack.state().dashboard).host, "the platform's host, the recipient for platform texts");
});

test("a signed-in account that doesn't own the agent is refused, by the platform's own answer about the owner", async () => {
  const signedIn = await post("/api/session", intruder.sign(await challenge()));
  assert.equal(signedIn.status, 200);
  const agent = await get(`/api/agents/${target.agent}`, cookieOf(signedIn));
  assert.deepEqual({ status: agent.status, body: await agent.json() }, { status: 403, body: { ok: false, kind: "not_owner" } });
});

test("the owner's signature over another recipient doesn't sign in, and a challenge signs in once", async () => {
  const issued = await challenge();
  const elsewhere = await signOwner(target, { ...issued, recipient: new URL(stack.state().dashboard).host });
  assert.equal(((await (await post("/api/session", { ...elsewhere, nonce: issued.nonce })).json()) as { code: string }).code, "bad_signature");
  const signed = await signOwner(target, issued);
  assert.equal((await post("/api/session", { ...signed, nonce: issued.nonce })).status, 200, "a bad signature didn't use the challenge up");
  assert.equal(((await (await post("/api/session", { ...signed, nonce: issued.nonce })).json()) as { code: string }).code, "unknown_challenge", "a signed-in challenge is spent");
});

test("without a session, from another origin, or after sign-out or idle time, the agent isn't reachable", async () => {
  assert.equal((await get(`/api/agents/${target.agent}`)).status, 401);
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...await signOwner(target, issued), nonce: issued.nonce }));
  const elsewhere = await fetch(`${base}/api/session`, { method: "DELETE", headers: { origin: "https://evil.test", "content-type": "application/json", cookie } });
  assert.equal(elsewhere.status, 403, "a write from another origin is refused");
  assert.equal((await get(`/api/agents/${target.agent}`, cookie)).status, 200, "and it changed nothing");
  clock.now += 30 * 60_000 + 1;
  assert.equal((await get(`/api/agents/${target.agent}`, cookie)).status, 401, "idle past its limit");
  clock.now = Date.now();
  const again = await challenge();
  const fresh = cookieOf(await post("/api/session", { ...await signOwner(target, again), nonce: again.nonce }));
  await fetch(`${base}/api/session`, { method: "DELETE", headers: { ...write, cookie: fresh } });
  assert.equal((await get(`/api/agents/${target.agent}`, fresh)).status, 401, "signed out");
});

/** Signs the stack's owner in, then connects the agent with a consent the owner's wallet signs; answers both. */
async function connect() {
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const agent = `/api/agents/${target.agent}`;
  const text = ((await (await post(`${agent}/consent/text`, {}, cookie)).json()) as { value: { message: string; nonce: string; recipient: string } }).value;
  assert.equal(text.recipient, new URL(stack.state().dashboard).host);
  const signed = await signOwner(target, text);
  const connected = await post(`${agent}/consent`, { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie);
  const stored = await connected.json() as { value: { consent: { id: string; scopes: string[]; expiresAt: number } } };
  assert.equal(connected.status, 200, JSON.stringify(stored));
  return { cookie, agent, consent: stored.value.consent, signature: signed.signature };
}

test("the owner connects the agent with a consent their wallet signs, the platform stores it, and disconnecting revokes it", async () => {
  const { cookie, agent, consent, signature } = await connect();
  assert.deepEqual(consent.scopes, ["owner", "read", "treasury"], "a wallet owner connects with owner by default (#135)");
  assert.deepEqual(await (await get(`${agent}/consent`, cookie)).json(), { ok: true, value: { consent } }, "the platform's own record");
  const revoked = await post(`${agent}/consent/revoke`, {}, cookie);
  assert.deepEqual(await revoked.json(), { ok: true, value: { revoked: 1 } });
  assert.deepEqual(await (await get(`${agent}/consent`, cookie)).json(), { ok: true, value: { consent: null } });
  const text = readFileSync(audit.file, "utf8");
  assert.ok(verifyChain(text).ok, "the audit trail chains");
  const lines = text.trim().split("\n").map(line => JSON.parse(line).entry);
  assert.deepEqual(lines.map(line => [line.action, line.stage, line.who, line.subject, line.answer?.ok]),
    [["consent", "attempt", owner, undefined, undefined], ["consent", "result", owner, consent.id, true],
     ["revoke", "attempt", owner, consent.id, undefined], ["revoke", "result", owner, consent.id, true]], "each action recorded before and after");
  assert.ok(!readFileSync(audit.file, "utf8").includes(signature), "no signature in the audit trail");
});

test("a rotated credential is used at once, without a restart, and the consent carries over to it", async () => {
  const { cookie, agent, consent } = await connect();
  const { deployment, credentialFile } = stack.state().app!;
  const before = stack.appCredential("list").split("\n").filter(line => line.includes(` ${deployment} `) && !line.includes("revoked")).map(line => line.split(/\s+/)[0]!);
  assert.equal(before.length, 1, "one live credential before");
  const issued = stack.appCredential("issue", deployment, new URL(stack.state().dashboard).host).trim().split("\n");
  writeFileSync(credentialFile, `${issued.at(-1)!}\n`, { mode: 0o600 });
  stack.appCredential("revoke", before[0]!);
  assert.deepEqual(await (await get(`${agent}/consent`, cookie)).json(), { ok: true, value: { consent } },
    "read under the new credential, the old one revoked: consents are bound to the deployment, not the credential");
});

test("the owner reads, approves and executes a proposal through the server, and rejects another; each is recorded", async () => {
  // Connected under the owner's Organization, unless an earlier test left the agent connected.
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const agent = `/api/agents/${target.agent}`;
  if (((await (await get(`${agent}/consent`, cookie)).json()) as { value: { consent: unknown } }).value.consent === null) await connect();
  // Proposals are made by the app's proposer (PR 4); here the test makes them through the platform directly, as the server would.
  const host = new URL(stack.state().dashboard).host;
  const platform = appClient({ base: stack.state().dashboard as `https://${string}`, credential: readFileSync(stack.state().app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const calls = platform.agent(owner.replaceAll(".", "--"), target.agent);
  const propose = async (requestId: string) => {
    const made = await calls.call("proposals/create", { requestId, legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value as ProposalView;
  };
  const verdict = async (view: ProposalView, kind: "approve" | "reject") => {
    const message = proposalText(view, kind), nonce = randomBytes(32).toString("base64");
    const signed = await signOwner(target, { message, recipient: host, nonce });
    const answer = await post(`${agent}/proposals/${view.id}/${kind}`, { message, nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie);
    return { status: answer.status, body: await answer.json() as { ok: boolean; value: { proposal: ProposalView } } };
  };

  const first = await propose(`stack-${Date.now()}-1`);
  const listed = await (await get(`${agent}/proposals`, cookie)).json() as { value: { proposals: ProposalView[] } };
  assert.ok(listed.value.proposals.some(item => item.id === first.id), "listed under the owner's Organization");
  assert.equal(((await (await get(`${agent}/proposals/${first.id}`, cookie)).json()) as { value: { proposal: ProposalView } }).value.proposal.state, "proposed");
  assert.deepEqual(await (await post(`${agent}/proposals/${first.id}/execute`, {}, cookie)).json(), { ok: false, kind: "refused", code: "not_approved" });
  const approved = await verdict(first, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.value.proposal.state, "approved");
  const ran = await (await post(`${agent}/proposals/${first.id}/execute`, {}, cookie)).json() as { value: { result: string; proposal: ProposalView } };
  assert.deepEqual([ran.value.result, ran.value.proposal.state], ["final", "executed"], JSON.stringify(ran));
  assert.ok(ran.value.proposal.operations.some(operation => operation.status === "SUCCESS"), "the swap ran");
  // The ledger downloads as a CSV (#136): the platform's header, then a row per operation its provider's history holds. The
  // platform builds the rows from that history (`ledger.ts`), and the simulated provider's is empty, so on the stack the
  // executed swap's row can't be found: that part of the ticket is for a real provider. What this checks is the download,
  // after an execute, as the platform wrote it.
  const csv = await get(`${agent}/activity.csv`, cookie), csvText = await csv.text();
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(csv.headers.get("content-disposition") ?? "", /^attachment; filename="[^"]+\.csv"$/);
  assert.match(csvText, /^at,settledAt,type,status,failureCode,confidential,assetIn,amountIn,assetOut,amountOut,recipient,correlationId,/, "the platform's own header");
  const again = await (await post(`${agent}/proposals/${first.id}/execute`, {}, cookie)).json() as { value: { result: string; proposal: ProposalView } };
  assert.deepEqual([again.value.result, again.value.proposal.state], ["final", "executed"], "asked again, it answers the state from a read and sends nothing");

  const second = await propose(`stack-${Date.now()}-2`);
  const rejected = await verdict(second, "reject");
  assert.equal(rejected.body.value.proposal.state, "rejected");

  const lines = readFileSync(audit.file, "utf8").trim().split("\n").map(line => JSON.parse(line).entry).filter(line => line.subject === first.id || line.subject === second.id);
  assert.deepEqual(lines.map(line => [line.action, line.stage, line.answer?.ok]), [
    ["approve", "attempt", undefined], ["approve", "result", true], ["execute", "attempt", undefined], ["execute", "result", true],
    ["reject", "attempt", undefined], ["reject", "result", true],
  ], "the second execute was answered from the read: nothing sent, nothing to record");
});

test("watch proposes for the drifted agent under the owner's consent: the request stored, the proposal open, and the next tick held", async () => {
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  if (((await (await get(`/api/agents/${target.agent}/consent`, cookie)).json()) as { value: { consent: unknown } }).value.consent === null) await connect();
  // All of it in wNEAR: whatever the agent holds now, the book drifts from that.
  await setTargets(target, { [USDC]: 0, [WNEAR]: 10_000, [ETH]: 0 });
  const requests = await createRequests(join(tempDir("treasury-stack-watch-"), "requests.json"));
  const watch = createWatch({ platform: platform.watch, requests, publicOrigin: ORIGIN });
  const organization = owner.replaceAll(".", "--");
  const watched = { organization, agent: target.agent, driftPoints: 1, intervalS: 300, proposalHours: 24 };
  const event = await watch.tick(watched);
  assert.ok(event.proposed, JSON.stringify(event));
  const [stored] = requests.of(organization, target.agent);
  assert.equal(stored!.proposalId, event.proposed, "the request on disk names its proposal");
  const read = await platform.watch.get(organization, target.agent, event.proposed as string);
  assert.ok(read.ok, JSON.stringify(read));
  assert.equal(read.value.state, "proposed");
  assert.equal(read.value.requestId, stored!.requestId);
  assert.match(read.value.note ?? "", /^Drift \d+\.\d points from the targets$/);
  assert.deepEqual(await watch.tick(watched), { organization, agent: target.agent, skipped: "live proposal", proposalId: event.proposed, state: "proposed" });
  // Sent again under its requestId, the platform answers the same proposal and stores nothing new.
  const again = await platform.watch.create(organization, target.agent, requests.input(stored!));
  assert.ok(again.ok && again.value.id === event.proposed, JSON.stringify(again));
});

test("the owner's reads reach the stack's portfolio under their consent: overview, activity, held, unresolved and the autopilot's runs, amounts exact", async () => {
  // Connected by the test before (watch's), or connected here.
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  const read = async <S extends z.ZodType>(path: string, schema: S) => {
    const response = await get(`${agent}/${path}`, cookie);
    const body = await response.json() as { ok: boolean; value: unknown };
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
    return schema.parse(body.value);
  };
  const overview = await read("overview", contract.overviewRead);
  assert.ok(overview.book.length > 0, "the portfolio holds its assets");
  // The stack funds the portfolio with simulated USDC: its raw units arrive as a decimal string, read exactly.
  const usdc = overview.book.find(holding => holding.symbol === "USDC")!;
  assert.ok(BigInt(usdc.public) + BigInt(usdc.confidential) > 0n, JSON.stringify(usdc));
  await read("activity", contract.activityRead);
  await read("held", contract.heldRead);
  await read("unresolved", contract.unresolvedRead);
  const runs = await read("runs", contract.runsRead);
  assert.ok(Array.isArray(runs.ticks));
});

test("the owner links their own account to fund the agent, reads it back, gets a USDC deposit address, and unlinks it", async () => {
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  const treasury = async () => {
    const response = await get(`${agent}/treasury`, cookie);
    const body = await response.json() as { value: unknown };
    assert.equal(response.status, 200, JSON.stringify(body));
    return contract.treasuryRead.parse(body.value).treasury;
  };
  if (await treasury()) assert.equal((await post(`${agent}/treasury/unlink`, {}, cookie)).status, 200);
  assert.equal(await treasury(), null);
  const linked = await post(`${agent}/treasury/link`, { accountId: owner }, cookie);
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.equal((await treasury())?.accountId, owner);
  // The stack's simulated provider takes USDC deposits only, and answers the agent's own wallet as the address
  // (platform ce5fec6, test/e2e/provider.mjs): NEAR and a fresh address each time are the unit tests'.
  const deposit = await post(`${agent}/deposit`, { asset: "USDC" }, cookie);
  const body = await deposit.json() as { value: unknown };
  assert.equal(deposit.status, 200, JSON.stringify(body));
  contract.depositRead.parse(body.value);
  assert.equal((await post(`${agent}/treasury/unlink`, {}, cookie)).status, 200);
  assert.equal(await treasury(), null);
  const account = await get(`${agent}/account`, cookie);
  assert.equal(account.status, 200);
  contract.accountRead.parse(((await account.json()) as { value: unknown }).value);
});

test("a public wNEAR balance is previewed and shielded once through the server, each run a well-formed AG-UI run; the books read", async () => {
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  await fundPublic(target, WNEAR, "1000000000000000000000000");
  const sweep = async (execute: boolean) => {
    const response = await post(`${agent}/sweep`, { execute }, cookie);
    const body = await response.json() as { value: unknown };
    assert.equal(response.status, 200, JSON.stringify(body));
    const { events } = contract.sweepRun.parse(body.value);
    assert.deepEqual([events[0]!.type, events.at(-1)!.type], ["RUN_STARTED", "RUN_FINISHED"], JSON.stringify(events));
    const last = events.filter(event => event.type === "ACTIVITY_SNAPSHOT").at(-1)!;
    return contract.sweepActivity.parse(last.type === "ACTIVITY_SNAPSHOT" && last.content);
  };
  const preview = await sweep(false);
  const wnear = preview.exposed.find(holding => holding.asset === WNEAR);
  assert.ok(wnear && BigInt(wnear.public) >= 10n ** 24n, JSON.stringify(preview));
  assert.deepEqual(preview.shields, [], "a preview sends nothing");
  const shielded = await sweep(true);
  assert.deepEqual(shielded.shields.filter(shield => shield.asset === WNEAR).map(shield => shield.status), ["SUCCESS"]);
  const books = await get(`${agent}/books`, cookie);
  assert.equal(books.status, 200);
  contract.booksRead.parse(((await books.json()) as { value: unknown }).value);
});

test("the owner asks for a rebalance to a drifted strategy: proposed under their consent, found by its requestId, nothing executed", async () => {
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  await setTargets(target, { [USDC]: 0, [WNEAR]: 0, [ETH]: 10_000 });
  const requestId = `page-stack-${Date.now()}`;
  const response = await post(`${agent}/proposals`, { requestId }, cookie);
  const body = await response.json() as { value: unknown };
  assert.equal(response.status, 200, JSON.stringify(body));
  const { proposal } = contract.rebalanceMade.parse(body.value);
  assert.deepEqual([proposal.requestId, proposal.state], [requestId, "proposed"]);
  assert.ok(proposal.legs.length > 0, "the strategy's legs, quoted now");
  const found = await (await get(`${agent}/requests/${requestId}`, cookie)).json() as { value: { proposal: { id: string } } };
  assert.equal(found.value.proposal.id, proposal.id);
});

test("autopilot is turned on for the bound strategy, run now and left on; disconnecting turns it off before revoking", async () => {
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  await setTargets(target, { [USDC]: 5_000, [WNEAR]: 5_000, [ETH]: 0 });
  await authorizeStrategy(target);
  const read = async <S extends z.ZodType>(path: string, schema: S) => schema.parse(((await (await get(`${agent}/${path}`, cookie)).json()) as { value: unknown }).value);
  const strategy = await read("strategy", contract.strategyRead);
  assert.deepEqual([strategy.grantMatches, strategy.readiness.canEnable], [true, true], JSON.stringify(strategy.readiness));
  const on = await post(`${agent}/autopilot/enable`, { expectedDigest: strategy.digest }, cookie);
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal((await read("autopilot", contract.autopilotRead)).on, true);
  const ran = await post(`${agent}/autopilot/tick`, {}, cookie);
  assert.equal(ran.status, 200, await ran.clone().text());
  contract.tickRead.parse(((await ran.json()) as { value: unknown }).value);
  const revoked = await post(`${agent}/consent/revoke`, {}, cookie);
  assert.equal(revoked.status, 200, await revoked.clone().text());
  // Read again under a new consent: the schedule was turned off before the old one was revoked.
  const again = await connect();
  const schedule = contract.autopilotRead.parse(((await (await get(`${again.agent}/autopilot`, again.cookie)).json()) as { value: unknown }).value);
  assert.equal(schedule.on, false);
});

test("with owner actions allowed, the owner signs a grant for the saved strategy here; once submitted, it binds the strategy", { timeout: 90_000 }, async () => {
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const agent = `/api/agents/${target.agent}`;
  const text = await post(`${agent}/consent/text`, { owner: true }, cookie);
  const asked = ((await text.json()) as { value: { message: string; nonce: string; recipient: string } }).value;
  if (text.status === 200) {
    const signed = await signOwner(target, asked);
    assert.equal((await post(`${agent}/consent`, { message: asked.message, nonce: asked.nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie)).status, 200);
  }
  await setTargets(target, { [USDC]: 2_500, [WNEAR]: 7_500, [ETH]: 0 });
  const strategyNow = async () => contract.strategyRead.parse(((await (await get(`${agent}/strategy`, cookie)).json()) as { value: unknown }).value);
  const before = await strategyNow();
  assert.equal(before.grantMatches, false, "saving the strategy unbinds the grant");
  const prepared = await post(`${agent}/grant`, { expectedDigest: before.digest }, cookie);
  const preparedBody = await prepared.json() as { value: unknown };
  assert.equal(prepared.status, 200, JSON.stringify(preparedBody));
  const grant = contract.grantPrepared.parse(preparedBody.value);
  assert.ok(grant.intent, JSON.stringify(grant));
  const signed = await signOwner(target, grant.intent.payload);
  const submitted = await post(`${agent}/grant/${grant.correlationId}/submit`, { signedData: { ...grant.intent, public_key: signed.publicKey, signature: signed.signature } }, cookie);
  assert.equal(submitted.status, 200, await submitted.clone().text());
  for (let waited = 0; ; waited += 1_000) {
    const stage = contract.ownerActionStatus.parse(((await (await get(`${agent}/grant/${grant.correlationId}`, cookie)).json()) as { value: unknown }).value).stage;
    if (stage === "submitted" && (await strategyNow()).grantMatches) break;
    assert.ok(waited < 45_000, `still ${stage}`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
});

/** The owner signed in with a connection that allows owner actions (#133), and the calls to freeze and unfreeze from here. */
async function freezing() {
  const issued = await challenge();
  const cookie = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const agent = `/api/agents/${target.agent}`;
  const live = ((await (await get(`${agent}/consent`, cookie)).json()) as { value: { consent: { scopes: string[] } | null } }).value.consent;
  if (!live || !live.scopes.includes("owner")) {
    const text = await post(`${agent}/consent/text`, { owner: true }, cookie);
    const asked = ((await text.json()) as { value: { message: string; nonce: string; recipient: string } }).value;
    const signed = await signOwner(target, asked);
    assert.equal((await post(`${agent}/consent`, { message: asked.message, nonce: asked.nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie)).status, 200);
  }
  const frozen = async () => ((await (await get(`${agent}/overview`, cookie)).json()) as { value: { policy: { policy: { frozen?: boolean } | null } } }).value.policy.policy?.frozen === true;
  const stageOf = async (id: string) => contract.ownerActionStatus.parse(((await (await get(`${agent}/owner/actions/${id}`, cookie)).json()) as { value: unknown }).value).stage;
  /** Prepares the action, and (an intent) signs it here and relays it once, then waits for it to take effect. A confirm page's form answers with its link. */
  const act = async (action: "freeze" | "unfreeze") => {
    const prepared = await post(`${agent}/${action}`, {}, cookie);
    const preparedBody = await prepared.json() as { value: unknown };
    assert.equal(prepared.status, 200, JSON.stringify(preparedBody));
    const made = contract.ownerActionPrepared.parse(preparedBody.value);
    assert.equal([made.intent, made.confirm, made.dao].filter(Boolean).length, 1, `exactly one form: ${JSON.stringify(made)}`);
    if (!made.intent) return { made, signed: false as const };
    const signed = await signOwner(target, made.intent.payload);
    const submitted = await post(`${agent}/owner/actions/${made.correlationId}/submit`, { signedData: { ...made.intent, public_key: signed.publicKey, signature: signed.signature } }, cookie);
    assert.equal(submitted.status, 200, await submitted.clone().text());
    for (let waited = 0; ; waited += 1_000) {
      const stage = await stageOf(made.correlationId);
      if (stage === "submitted" && (await frozen()) === (action === "freeze")) break;
      assert.ok(waited < 45_000, `still ${stage}, frozen ${await frozen()}`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    return { made, signed: true as const };
  };
  return { cookie, agent, frozen, act };
}

test("freeze and unfreeze (#133): prepared in the form the platform chooses, an intent signed here and relayed once, followed to its status", { timeout: 120_000 }, async () => {
  const { frozen, act } = await freezing();
  assert.equal(await frozen(), false, "not frozen to begin with");
  const froze = await act("freeze");
  assert.ok(froze.signed, "the stack answers a freeze with an intent");
  assert.equal(await frozen(), true);
  assert.equal((await act("unfreeze")).signed, true);
  assert.equal(await frozen(), false);
});

// The provider sends freeze and unfreeze as NEP-366 (the platform's docs/app-access.md), so in production a wallet owner
// freezes through the platform's confirm page, a path this stack never answers with: it waits for the confirm-page helper.
test.todo("a freeze answered with the platform's confirm page is signed there, and takes effect (#140)");

test("while the agent is frozen nothing is sent: an earlier approval is invalidated, a new one is refused; after unfreeze a new proposal runs (#133)", { timeout: 150_000 }, async () => {
  const { cookie, agent, frozen, act } = await freezing();
  const host = new URL(stack.state().dashboard).host;
  const platform = appClient({ base: stack.state().dashboard as `https://${string}`, credential: readFileSync(stack.state().app!.credentialFile, "utf8").trim(), fetch: stackFetch(readFileSync(target.ca)) });
  const propose = async () => {
    const made = await platform.agent(owner.replaceAll(".", "--"), target.agent).call("proposals/create",
      { requestId: `stack-frozen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, legs: [{ from: USDC, to: WNEAR, amount: "1000000" }], expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    assert.ok(made.ok, JSON.stringify(made));
    return made.value as ProposalView;
  };
  const approve = async (view: ProposalView) => {
    const message = proposalText(view, "approve"), nonce = randomBytes(32).toString("base64");
    const signed = await signOwner(target, { message, recipient: host, nonce });
    return post(`${agent}/proposals/${view.id}/approve`, { message, nonce, publicKey: signed.publicKey, signature: signed.signature }, cookie);
  };
  const execute = async (view: ProposalView) => ((await (await post(`${agent}/proposals/${view.id}/execute`, {}, cookie)).json()) as { value: { result: string; proposal: ProposalView | null } }).value;

  const early = await propose();
  assert.equal((await approve(early)).status, 200, "approved before the freeze");
  const froze = await act("freeze");
  assert.ok(froze.signed, "the stack answers a freeze with an intent");
  assert.equal(await frozen(), true);
  // Freezing changes the policy: what was approved under the old one can't be executed, and nothing is sent.
  const stopped = await execute(early);
  assert.deepEqual([stopped.result, stopped.proposal?.state, stopped.proposal?.operations.length], ["final", "invalidated", 0], JSON.stringify(stopped.proposal?.reason));
  // A proposal made while frozen can't be approved at all: the policy isn't in force.
  const during = await propose();
  const refused = await approve(during);
  assert.deepEqual([refused.status, await refused.json()], [409, { ok: false, kind: "refused", code: "policy_not_in_force" }]);

  assert.equal((await act("unfreeze")).signed, true);
  const after = await propose();
  assert.equal((await approve(after)).status, 200, "unfrozen: it can be approved");
  const ran = await execute(after);
  assert.deepEqual([ran.result, ran.proposal?.state], ["final", "executed"], "and it runs");
});

test("the owner saves a strategy through the server over the one they saw: autopilot off, the grant no longer binding it, a stale save refused", async () => {
  const issued = await challenge();
  const signedIn = cookieOf(await post("/api/session", { ...(await signOwner(target, issued)), nonce: issued.nonce }));
  const live = ((await (await get(`/api/agents/${target.agent}/consent`, signedIn)).json()) as { value: { consent: unknown } }).value.consent;
  const { cookie, agent } = live ? { cookie: signedIn, agent: `/api/agents/${target.agent}` } : await connect();
  const strategyNow = async () => contract.strategyRead.parse(((await (await get(`${agent}/strategy`, cookie)).json()) as { value: unknown }).value);
  const before = await strategyNow();
  const next = { ...before.strategy, targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, autopilot: { everyMin: 30, maxUsd: 50 } };
  const saved = await post(`${agent}/strategy`, { strategy: next, expectedDigest: before.digest }, cookie);
  const body = await saved.json() as { value: unknown };
  assert.equal(saved.status, 200, JSON.stringify(body));
  const after = await strategyNow();
  assert.equal(after.digest, contract.strategySaved.parse(body.value).digest);
  assert.deepEqual([after.on, after.grantMatches, after.strategy.targetBps], [false, false, next.targetBps]);
  const stale = await post(`${agent}/strategy`, { strategy: before.strategy, expectedDigest: before.digest }, cookie);
  assert.deepEqual(await stale.json(), { ok: false, kind: "refused", code: "strategy_changed" }, "saved over the strategy the owner saw, never another");
});
