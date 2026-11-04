// The server against the platform's stack (platform at PLATFORM_COMMIT, `--treasury --app`): a real gateway, the
// stack's own Treasury agent `portfolio` and its operator-issued `tap_` credential. Sign-in uses the stack's
// `signOwner` control, as the owner's wallet would. The stack doesn't publish its chain RPC, so the key check uses a
// stand-in built from the stack's own owner account and key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { appClient, proposalText, type ProposalView } from "@multiagency/sdk";
import type { AddressInfo } from "node:net";
import { ETH, setTargets, signOwner, stackFetch, startStack, USDC, WNEAR, type Stack } from "../../../scripts/stack.ts";
import { fileAudit } from "../src/audit.ts";
import { createCredential } from "../src/credential.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createPlatform } from "../src/platform.ts";
import { createRequests } from "../src/requests.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { createWatch } from "../src/watch.ts";
import { HOST, ORIGIN, wallet } from "./fakes.ts";

const intruder = wallet("intruder.near");
const clock = { now: Date.now() };
const audit = fileAudit(join(mkdtempSync(join(tmpdir(), "treasury-stack-")), "audit.jsonl"));
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, owner: string, server: Server, base: string;
let platform: ReturnType<typeof createPlatform>;

before(async () => {
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
    consentsPerDay: 1_000,
    keyLookup,
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
  assert.deepEqual(consent.scopes, ["read", "treasury"]);
  assert.deepEqual(await (await get(`${agent}/consent`, cookie)).json(), { ok: true, value: { consent } }, "the platform's own record");
  const revoked = await post(`${agent}/consent/revoke`, {}, cookie);
  assert.deepEqual(await revoked.json(), { ok: true, value: { revoked: 1 } });
  assert.deepEqual(await (await get(`${agent}/consent`, cookie)).json(), { ok: true, value: { consent: null } });
  const lines = readFileSync(audit.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
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
  const again = await (await post(`${agent}/proposals/${first.id}/execute`, {}, cookie)).json() as { value: { result: string; proposal: ProposalView } };
  assert.deepEqual([again.value.result, again.value.proposal.state], ["final", "executed"], "asked again, it answers the state from a read and sends nothing");

  const second = await propose(`stack-${Date.now()}-2`);
  const rejected = await verdict(second, "reject");
  assert.equal(rejected.body.value.proposal.state, "rejected");

  const lines = readFileSync(audit.file, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(line => line.subject === first.id || line.subject === second.id);
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
  const requests = await createRequests(join(mkdtempSync(join(tmpdir(), "treasury-stack-watch-")), "requests.json"));
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
