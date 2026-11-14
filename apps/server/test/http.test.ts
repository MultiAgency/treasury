import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { parseConsentMessage, proposalList, proposalText, type ProposalView } from "@multiagency/sdk";
import type { AuditEntry } from "../src/audit.ts";
import type { ProposalAnswer } from "../src/platform.ts";
import * as contract from "../src/contract.ts";
import type { IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { join } from "node:path";
import { createDaoRequests } from "../src/dao-requests.ts";
import { createDaoReader } from "../src/dao-reader.ts";
import { createSettle } from "../src/dao-settle.ts";
import { standInDaos, type DaoProposal, type Policy } from "../src/dao.ts";
import { consentText } from "../src/consent.ts";
import { clientAddress, COOKIE, routes } from "../src/http.ts";
import { standInKeyLookup, type KeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { daoKind, daoTransaction, fakePlatform, HOST, ORIGIN, proposal, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
/** A DAO's members: one who may file and vote on its proposals, one who may only file, and one with no rights. */
const council = wallet("council.near"), proposer = wallet("proposer.near"), reader = wallet("reader.near");
const DAO = "agentic.sputnik-dao.near";
const fake = fakePlatform({ portfolio: "owner.near", "elsewhere-agent": "owner.near", transferred: "owner.near", unborn: "owner.near", recreated: "owner.near", theirs: "intruder.near", "dao-treasury": DAO }, {
  daos: ["dao-treasury"],
  daoNext: dao => chainProposals[dao]?.length ?? 0,
  unborn: ["unborn"],
  recreated: { recreated: "id-before" },
  stale: { transferred: "previous.near" },
  foreign: ["elsewhere-agent"],
  failing: {
    revoked: { ok: false, kind: "session", status: 401, error: "Invalid, expired or revoked app credential" },
    down: { ok: false, kind: "unavailable" },
    "bad-gateway": { ok: false, kind: "unavailable", httpStatus: 502 },
    limited: { ok: false, kind: "refused", status: 429, error: "Request limit reached" },
    conflict: { ok: false, kind: "refused", status: 409, error: "Current wallet ownership could not be verified" },
    // The platform's only 403 on this route: a request carrying browser headers, so this server is misconfigured.
    hidden: { ok: false, kind: "forbidden", status: 403, error: "Use the app server, without browser credentials." },
  },
});
const clock = { now: Date.now() };
const audited: AuditEntry[] = [];
/** The DAO requests the server under test files, kept for the tests to read. */
const daoRequests = await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json"));
/** The chain's answer about the owners' keys, replaceable per test. */
const keys: { lookup: KeyLookup } = { lookup: async () => "full" };
/** The DAOs' policies as the chain answers them, replaceable per test; a DAO missing here reads as `unavailable`. */
const policies: Record<string, Policy> = {};
/** The DAOs' proposals on chain, numbered from 0, replaceable per test. */
const chainProposals: Record<string, DaoProposal[]> = {};
/**
 * A DAO's policy: its Group roles name the members. Everyone's rights admit no one, but a member admitted gets them
 * too, as the DAO contract grants them.
 */
const daoPolicy = (groups: Record<string, { members: string[]; permissions: string[] }>, everyone: string[] = []): Policy => ({
  proposal_bond: "100000000000000000000000", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "all", kind: "Everyone", permissions: everyone, vote_policy: {} },
    ...Object.entries(groups).map(([name, { members, permissions }]) => ({ name, kind: { Group: members }, permissions, vote_policy: {} }))],
});
const DAO_POLICY = daoPolicy({
  council: { members: ["council.near"], permissions: ["call:AddProposal", "call:VoteApprove", "call:VoteReject"] },
  proposers: { members: ["proposer.near"], permissions: ["call:AddProposal"] },
  readers: { members: ["reader.near"], permissions: [] },
});
/** Makes the audit trail fail at one stage, as a full disk would. */
const auditFails: { stage?: AuditEntry["stage"] } = {};
let server: Server, base: string;

before(async () => {
  ({ server, base } = await testServer({ platform: fake.platform, wallets: [owner, intruder, council, proposer, reader],
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000, now: () => clock.now }),
    audit: { append: async entry => { if (entry.stage === auditFails.stage) throw new Error("disk full"); audited.push(entry); } },
    keyLookup: async (account, key) => keys.lookup(account, key), daos: standInDaos(policies, chainProposals), daoRequests }));
});
after(() => server.close());

const write = { origin: ORIGIN, "content-type": "application/json" };
const call = (method: string, path: string, { body, cookie, headers = method === "GET" ? {} : write }: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...headers, ...(cookie && { cookie }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });

/** Signs `who` in through the routes, as the browser would, and answers the session cookie. */
async function signIn(who: ReturnType<typeof wallet>) {
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  const response = await call("POST", "/api/session", { body: who.sign(issued.value) });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** A concrete path for a route, with `:agent` filled in. */
const pathOf = (route: { path: string }, agent = "portfolio") => route.path.replace(":agent", agent);

test("sign-in sets a Secure, httpOnly, SameSite=Strict session cookie bound to the signing account", async () => {
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  assert.equal(contract.challenge.parse(issued.value).recipient, HOST);
  const response = await call("POST", "/api/session", { body: owner.sign(issued.value) });
  const answer = await response.json() as { value: unknown };
  assert.deepEqual(contract.session.parse(answer.value), { account: "owner.near" });
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`));
  for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=43200"]) assert.ok(cookie.includes(flag), flag);
});

test("every route that needs a session refuses without one", async () => {
  for (const route of routes.filter(route => route.access !== "public")) {
    assert.deepEqual(await json(await call(route.method, pathOf(route))), { status: 401, body: { ok: false, kind: "not_signed_in" } }, `${route.method} ${route.path}`);
  }
});

test("every agent route refuses a signed-in account that doesn't own the agent, after only the ownership read", async () => {
  const cookie = await signIn(intruder);
  for (const route of routes.filter(route => route.access === "owner" || route.access === "owner-fresh")) {
    fake.calls.length = 0;
    assert.deepEqual(await json(await call(route.method, pathOf(route), { cookie, ...(route.method !== "GET" && { body: {} }) })), { status: 403, body: { ok: false, kind: "not_owner" } }, `${route.method} ${route.path}`);
    const read = route.access === "owner-fresh" ? "identity portfolio (fresh)" : "identity portfolio";
    assert.deepEqual(fake.calls, [read], "nothing but the ownership read reached the platform, read anew on an owner-fresh route");
  }
});

test("an owner-fresh route asks for a fresh ownership read, and an owner route may reuse one", async t => {
  const route = { method: "GET" as const, path: "/api/test-fresh/:agent", access: "owner-fresh" as const, needs: "read" as const, handle: async () => ({ status: 200, body: { ok: true as const, value: {} } }) };
  routes.push(route);
  t.after(() => { routes.splice(routes.indexOf(route), 1); });
  const cookie = await signIn(owner);
  fake.calls.length = 0;
  assert.equal((await call("GET", "/api/test-fresh/portfolio", { cookie })).status, 200);
  assert.equal((await call("GET", "/api/agents/portfolio", { cookie })).status, 200);
  assert.deepEqual(fake.calls, ["identity portfolio (fresh)", "identity portfolio"]);
});

test("every write refuses another origin, a missing origin and a body not sent as JSON", async () => {
  for (const route of routes.filter(route => route.method !== "GET")) {
    const label = `${route.method} ${route.path}`;
    assert.equal((await json(await call(route.method, pathOf(route), { headers: { origin: "https://evil.test", "content-type": "application/json" } }))).body.code, "origin", label);
    assert.equal((await json(await call(route.method, pathOf(route), { headers: { "content-type": "application/json" } }))).body.code, "origin", label);
    assert.equal((await json(await call(route.method, pathOf(route), { body: {}, headers: { origin: ORIGIN, "content-type": "text/plain" } }))).body.code, "content_type", label);
  }
});

test("the owner reads their agent, with one ownership read", async () => {
  const cookie = await signIn(owner);
  fake.calls.length = 0;
  const { status, body } = await json(await call("GET", "/api/agents/portfolio", { cookie }));
  assert.equal(status, 200);
  assert.deepEqual(contract.agent.parse(body.value), { agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test",
    signer: "wallet", account: "owner.near", access: { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true } });
  assert.deepEqual(fake.calls, ["identity portfolio"]);
});

test("an agent name that isn't one is refused before the platform is asked", async () => {
  const cookie = await signIn(owner);
  fake.calls.length = 0;
  assert.equal((await json(await call("GET", "/api/agents/Not_An_Agent", { cookie }))).body.code, "bad_request");
  assert.deepEqual(fake.calls, []);
});

test("a missing agent, one this deployment can't see and someone else's get the same answer, so a stranger can't tell which exist", async () => {
  const cookie = await signIn(intruder);
  const missing = await json(await call("GET", "/api/agents/missing", { cookie }));
  assert.deepEqual(missing, { status: 403, body: { ok: false, kind: "not_owner" } });
  for (const agent of ["portfolio"]) assert.deepEqual(await json(await call("GET", `/api/agents/${agent}`, { cookie })), missing, agent);
});

test("the platform's failures are never forwarded: a revoked credential, an outage, a rate limit, a conflict or a 403 is just unavailable", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  for (const agent of ["revoked", "down", "bad-gateway", "limited", "conflict", "hidden"]) {
    const answer = await json(await call("GET", `/api/agents/${agent}`, { cookie }));
    assert.deepEqual(answer, { status: 503, body: { ok: false, kind: "unavailable" } }, `${agent}: not not_owner, which would tell the owner it isn't theirs`);
    assert.ok(!/credential|limit|ownership/.test(JSON.stringify(answer)), "no platform text reaches the browser");
  }
  const lines = logged.mock.calls.map(call => JSON.parse(String(call.arguments[0])));
  assert.equal(lines.find(line => line.agent === "bad-gateway")?.httpStatus, 502, "an unavailable answer's HTTP status is logged");
  assert.equal(lines.find(line => line.agent === "limited")?.status, 429);
});

test("an identity naming another deployment means this server is misconfigured: logged, and unavailable", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  assert.deepEqual(await json(await call("GET", "/api/agents/elsewhere-agent", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes("deployment_mismatch")));
});

test("a malformed percent-encoding is a bad request, not a server error", async () => {
  const cookie = await signIn(owner);
  assert.deepEqual(await json(await call("GET", "/api/agents/%E0%A4%A", { cookie })), { status: 400, body: { ok: false, kind: "refused", code: "bad_request" } });
});

test("an account ID that isn't one is refused before any verification", async () => {
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  const signed = owner.sign(issued.value);
  assert.equal((await json(await call("POST", "/api/session", { body: { ...signed, accountId: "Owner.NEAR" } }))).body.code, "bad_request");
});

test("a captured sign-in replayed with another encoding of its nonce doesn't sign in", async () => {
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  const signed = owner.sign(issued.value);
  assert.equal((await call("POST", "/api/session", { body: signed })).status, 200);
  const n = signed.nonce;
  for (const nonce of [n.slice(0, -1), `${n}=`, ` ${n}`, `${n.slice(0, 20)}\n${n.slice(20)}`]) {
    const { status, body } = await json(await call("POST", "/api/session", { body: { ...signed, nonce } }));
    assert.deepEqual({ status, code: body.code }, { status: 400, code: "bad_request" }, JSON.stringify(nonce));
  }
});

test("sign-in attempts are limited per client, by the address the trusted proxy saw, and answered 429", async t => {
  const limited = await testServer({ platform: fake.platform, trustedProxyHops: 1,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 2, keyLookup: standInKeyLookup({ "owner.near": [owner.publicKey] }) }) });
  t.after(() => limited.server.close());
  const at = limited.base;
  const post = async (path: string, client: string, body: unknown = {}) => json(await fetch(`${at}${path}`, {
    method: "POST", headers: { ...write, "x-forwarded-for": client }, body: JSON.stringify(body) }));
  const { body: issued } = await post("/api/session/challenge", "203.0.113.1");
  const wrong = owner.sign(issued.value, { message: "a guess" });
  for (let i = 0; i < 2; i++) assert.equal((await post("/api/session", "203.0.113.7", wrong)).body.code, "bad_signature");
  assert.deepEqual(await post("/api/session", "203.0.113.7", owner.sign(issued.value)), { status: 429, body: { ok: false, kind: "refused", code: "rate_limited" } });
  assert.equal((await post("/api/session", "203.0.113.8", owner.sign(issued.value))).status, 200, "another client, by the proxy's address for it");
});

/** A second server with its own platform fake and a low owner-request limit, and a sign-in helper for it. */
async function limitedServer(t: { after(fn: () => void): void }, platform: ReturnType<typeof fakePlatform>["platform"], ownerRequestsPerMinute: number) {
  const limited = await testServer({ platform, wallets: [intruder, owner], ownerRequestsPerMinute });
  t.after(() => limited.server.close());
  const at = limited.base, session = limited.signIn;
  const read = async (cookie: string, agent: string) => json(await fetch(`${at}/api/agents/${agent}`, { headers: { cookie } }));
  return { session, read };
}

test("an account's owner-route requests are limited, so one account can't spend the platform quota every owner shares", async t => {
  const counted = fakePlatform({ portfolio: "owner.near" });
  const { session, read } = await limitedServer(t, counted.platform, 3);
  const stranger = await session(intruder);
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await read(stranger, `nosuch-${i}`));
  assert.deepEqual(answers.map(answer => answer.status), [403, 403, 403, 429]);
  assert.deepEqual(answers[3]!.body, { ok: false, kind: "refused", code: "rate_limited" });
  assert.equal(counted.calls.length, 3, "4 requests, 3 platform calls");
  assert.equal((await read(await session(owner), "portfolio")).status, 200, "another account isn't affected");
});

test("asking twice for the same missing agent is two platform calls, each counted against the limit", async t => {
  const counted = fakePlatform({});
  const { session, read } = await limitedServer(t, counted.platform, 2);
  const stranger = await session(intruder);
  assert.deepEqual([(await read(stranger, "nosuch")).status, (await read(stranger, "nosuch")).status, (await read(stranger, "nosuch")).status], [403, 403, 429]);
  assert.deepEqual(counted.calls, ["identity nosuch", "identity nosuch"], "not read again anew: a refusal that wasn't reused");
});

test("the anew read after a reused refusal counts against the limit too, so strangers can't use it to force fresh reads", async t => {
  const counted = fakePlatform({ transferred: "owner.near" }, { stale: { transferred: "previous.near" } });
  const { session, read } = await limitedServer(t, counted.platform, 2);
  const stranger = await session(intruder);
  assert.equal((await read(stranger, "transferred")).status, 403, "reused answer, then the anew read: two counted");
  assert.equal((await read(stranger, "transferred")).status, 429);
  assert.deepEqual(counted.calls, ["identity transferred (fresh)"], "one platform call");
});

test("after a transfer, a reused answer naming the previous owner is read once more anew, so the new owner isn't locked out", async () => {
  const cookie = await signIn(owner);
  fake.calls.length = 0;
  const { status, body } = await json(await call("GET", "/api/agents/transferred", { cookie }));
  assert.equal(status, 200);
  assert.equal(body.value.owner, "owner.near");
  assert.deepEqual(fake.calls, ["identity transferred (fresh)"]);
});

test("signing in again ends the session the browser carried", async () => {
  const first = await signIn(owner);
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  const again = await call("POST", "/api/session", { body: owner.sign(issued.value), cookie: first });
  const second = again.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(second, first);
  assert.equal((await json(await call("GET", "/api/agents/portfolio", { cookie: first }))).body.kind, "not_signed_in");
  assert.equal((await call("GET", "/api/agents/portfolio", { cookie: second })).status, 200);
});

test("sign-out clears the cookie even when the session has already ended", async () => {
  const cookie = await signIn(owner);
  clock.now += 30 * 60_000 + 1;
  const response = await call("DELETE", "/api/session", { cookie });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  clock.now = Date.now();
});

test("sign-out needs no content type when it has no body, but still checks the origin", async () => {
  const cookie = await signIn(owner);
  const bare = await call("DELETE", "/api/session", { cookie, headers: { origin: ORIGIN } });
  assert.equal(bare.status, 200);
  assert.match(bare.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await call("DELETE", "/api/session", { cookie, headers: {} })).status, 403, "no origin");
  assert.equal((await call("DELETE", "/api/session", { cookie, body: {}, headers: { origin: ORIGIN, "content-type": "text/plain" } })).status, 415, "a body must still be JSON");
});

test("the client's address is the connection's, unless proxies are trusted", () => {
  const req = (forwarded?: string) => ({ socket: { remoteAddress: "10.0.0.1" }, headers: forwarded ? { "x-forwarded-for": forwarded } : {} }) as unknown as IncomingMessage;
  assert.equal(clientAddress(req("6.6.6.6"), 0), "10.0.0.1", "with no trusted proxy, a client can't choose its own address");
  assert.equal(clientAddress(req("6.6.6.6, 203.0.113.9"), 1), "203.0.113.9", "the address the trusted proxy saw");
  assert.equal(clientAddress(req("6.6.6.6, 203.0.113.9, 10.0.0.5"), 2), "203.0.113.9");
});

test("behind trusted proxies, a missing forwarded address falls back to the connection's, and is logged", t => {
  const logged = t.mock.method(console, "error", () => {});
  const req = { socket: { remoteAddress: "10.0.0.1" }, headers: {} } as unknown as IncomingMessage;
  assert.equal(clientAddress(req, 1), "10.0.0.1");
  assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes("proxy_address_missing")));
});

test("sign-out clears the cookie and ends the session", async () => {
  const cookie = await signIn(owner);
  const response = await call("DELETE", "/api/session", { cookie });
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await json(await call("GET", "/api/agents/portfolio", { cookie }))).body.kind, "not_signed_in");
});

test("a session past its idle time is refused like no session", async () => {
  const cookie = await signIn(owner);
  clock.now += 30 * 60_000 + 1;
  assert.equal((await json(await call("GET", "/api/agents/portfolio", { cookie }))).body.kind, "not_signed_in");
});

test("unknown routes, oversized bodies and malformed JSON are refused", async () => {
  assert.equal((await json(await call("GET", "/api/nothing"))).body.code, "not_found");
  assert.equal((await json(await call("POST", "/api/session", { body: "x".repeat(20_000) }))).body.code, "too_large");
  const malformed = await fetch(`${base}/api/session`, { method: "POST", headers: write, body: "{" });
  assert.equal((await malformed.json() as { code: string }).code, "bad_request");
  assert.equal((await json(await call("POST", "/api/session", { body: { accountId: "owner.near" } }))).body.code, "bad_request");
});

test("answers are never cached or sniffed", async () => {
  const response = await call("GET", "/api/nothing");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

/** The owner connects `agent`: the server's text, signed by the owner's wallet as the platform host's recipient. */
async function signedConsent(cookie: string, agent = "portfolio") {
  const { status, body } = await json(await call("POST", `/api/agents/${agent}/consent/text`, { cookie, body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  contract.consentText.parse(body.value);
  const signed = owner.sign(body.value);
  return { text: body.value, submission: { message: body.value.message, nonce: body.value.nonce, publicKey: signed.publicKey, signature: signed.signature } };
}
/** Starts a consent test from nothing: no consents on the platform, no calls, no records, the audit trail writable. */
function clean() { fake.consents.length = 0; fake.calls.length = 0; audited.length = 0; delete auditFails.stage; }
const record = (id: string, change: Partial<(typeof fake.consents)[number]> = {}) => ({ id: id.padEnd(64, "0"), deployment: "treasury", host: "platform.test",
  organization: "owner--near", owner: "owner.near", agent: "portfolio", agentId: "id-portfolio", scopes: ["read", "treasury"] as ("read" | "treasury" | "owner")[],
  expiresAt: Date.now() + 86_400_000, createdAt: 0, publicKey: "k", revoked: false, revokedAt: null, ...change });
const results = () => audited.filter(entry => entry.stage === "result");

test("connecting: the server's text from a fresh identity, the owner's signature over it, relayed once, recorded before and after", async () => {
  clean();
  const cookie = await signIn(owner);
  const { text, submission } = await signedConsent(cookie);
  assert.equal(text.recipient, "platform.test");
  assert.deepEqual(parseConsentMessage(text.message)?.scopes, ["owner", "read", "treasury"], "a wallet owner connects with owner by default");
  assert.equal(parseConsentMessage(text.message)?.organization, "owner--near");
  fake.calls.length = 0;
  const { status, body } = await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission }));
  assert.equal(status, 200);
  assert.ok(contract.consent.parse(body.value).consent, "the page's own schema: what was granted and until when");
  assert.equal(fake.calls[0], "identity portfolio (fresh)", "a write reads the identity anew");
  assert.deepEqual(fake.calls.filter(line => line.startsWith("consents.submit")), [`consents.submit ${submission.nonce}`]);
  const sha = audited[0]!.signedTextSha256;
  assert.match(sha!, /^[0-9a-f]{64}$/);
  assert.deepEqual(audited.slice(0, 2), [
    { who: "owner.near", action: "consent", agent: "portfolio", signedTextSha256: sha, stage: "attempt" },
    { who: "owner.near", action: "consent", agent: "portfolio", signedTextSha256: sha, stage: "result", subject: body.value.consent.id, answer: { ok: true } },
  ], "the attempt is recorded before the platform is asked");
  assert.ok(!JSON.stringify(audited).includes(submission.signature), "no signature in the record");
  const shown = await json(await call("GET", "/api/agents/portfolio/consent", { cookie }));
  contract.consent.parse(shown.body.value);
  assert.deepEqual(shown, { status: 200, body: { ok: true, value: { consent: body.value.consent } } });
});

test("a re-created agent's text names its current ID, not the one a reused answer had", async () => {
  clean();
  const { text } = await signedConsent(await signIn(owner), "recreated");
  assert.equal(parseConsentMessage(text.message)?.agentId, "id-recreated");
});

test("a signed text that isn't the consent this server asks for is refused before the platform sees it", async () => {
  clean();
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  const other = await signedConsent(cookie, "transferred");
  fake.calls.length = 0;
  for (const body of [{ ...other.submission }, { ...submission, message: submission.message.replace('"treasury"]', '"treasury","treasury-execute"]') }]) {
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body })),
      { status: 400, body: { ok: false, kind: "refused", code: "not_this_consent" } });
  }
  for (const body of [{ ...submission, extra: 1 }, { ...submission, message: "x".repeat(2_049) }, { ...submission, nonce: submission.nonce.slice(0, -1) }])
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body })),
      { status: 400, body: { ok: false, kind: "refused", code: "bad_request" } }, "the SDK's own schema, with a canonical nonce");
  assert.ok(!fake.calls.some(line => line.startsWith("consents.submit")), "nothing relayed");
  assert.deepEqual(audited, [], "nothing relayed, so nothing recorded");
});

test("an agent not created yet can't be connected", async () => {
  clean();
  const cookie = await signIn(owner);
  for (const path of ["/api/agents/unborn/consent/text", "/api/agents/unborn/consent"])
    assert.deepEqual(await json(await call("POST", path, { cookie, body: {} })), { status: 409, body: { ok: false, kind: "refused", code: "not_created" } }, path);
});

test("a lost answer resubmits the same signed body once; the platform's answers map to the browser's and are recorded with their code", async () => {
  clean();
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  fake.consentAnswers.push({ ok: false, kind: "unavailable" });
  assert.equal((await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission })).status, 200, "the second try was stored");
  assert.deepEqual(fake.calls.filter(line => line.startsWith("consents.submit")), [`consents.submit ${submission.nonce}`, `consents.submit ${submission.nonce}`]);
  const answers: [Awaited<ReturnType<typeof fake.platform.consents.submit>>[], number, unknown, unknown][] = [
    [[{ ok: false, kind: "unavailable" }, { ok: false, kind: "unavailable" }], 503, { ok: false, kind: "unavailable" }, { ok: false, kind: "unavailable" }],
    [[{ ok: false, kind: "refused", status: 409, error: "The consent names another agent identity." }], 409, { ok: false, kind: "refused", code: "agent_changed" },
      { ok: false, kind: "refused", status: 409, code: "agent_changed" }],
    [[{ ok: false, kind: "refused", status: 400, error: "Signature didn't verify" }], 400, { ok: false, kind: "refused", code: "consent_refused" },
      { ok: false, kind: "refused", status: 400, code: "consent_refused" }],
    // A 429 that isn't the platform's own answer (a proxy's page) proves nothing about the request: unavailable.
    [[{ ok: false, kind: "refused", status: 429, error: "Request limit reached" }], 503, { ok: false, kind: "unavailable" },
      { ok: false, kind: "refused", status: 429 }],
    // The platform's own limit on the deployment's calls: nothing was stored.
    [[{ ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }], 429, { ok: false, kind: "refused", code: "platform_rate_limited" },
      { ok: false, kind: "rate_limited", status: 429, code: "platform_rate_limited" }],
    [[{ ok: false, kind: "forbidden", status: 403, error: "This host has no such agent owned by the signer" }], 403, { ok: false, kind: "not_owner" },
      { ok: false, kind: "forbidden", status: 403, code: "not_owner" }],
  ];
  for (const [queued, status, body, recorded] of answers) {
    clean();
    const fresh = (await signedConsent(cookie)).submission;
    fake.consentAnswers.push(...queued);
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: fresh })), { status, body });
    assert.deepEqual(results().map(entry => entry.stage === "result" && entry.answer), [recorded], "recorded with the platform's status and the browser's code");
    const texts = queued.flatMap(answer => !answer.ok && "error" in answer ? [answer.error] : []);
    assert.ok(!texts.some(text => JSON.stringify(body).includes(text)), "no platform text reaches the browser");
  }
});

test("an agent already connected isn't offered a new signature, and a reconnect revokes the owner's older consents for it", async () => {
  clean();
  const cookie = await signIn(owner);
  const first = (await signedConsent(cookie)).submission, second = (await signedConsent(cookie)).submission;
  const kept = (await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: first }))).body.value.consent;
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/text", { cookie, body: {} })),
    { status: 409, body: { ok: false, kind: "refused", code: "already_connected" } });
  audited.length = 0;
  const latest = (await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: second }))).body.value.consent;
  assert.equal(fake.consents.find(consent => consent.id === kept.id)?.revoked, true, "the older one is revoked");
  assert.equal(fake.consents.find(consent => consent.id === latest.id)?.revoked, false);
  assert.ok(results().some(entry => entry.action === "revoke" && entry.subject === kept.id && entry.answer.ok), "and recorded");
});

test("a wallet owner's consent always carries owner, and a connection without it may add it, which the new consent then replaces", async () => {
  clean();
  const cookie = await signIn(owner);
  const textFor = async (body: unknown) => json(await call("POST", "/api/agents/portfolio/consent/text", { cookie, body }));
  const scopesOf = (text: { message: string }) => parseConsentMessage(text.message)!.scopes;
  assert.deepEqual(scopesOf((await textFor({})).body.value), ["owner", "read", "treasury"], "by default, with no body");
  assert.deepEqual(scopesOf((await textFor({ owner: true })).body.value), ["owner", "read", "treasury"], "an older page's { owner: true } still works");
  assert.equal((await textFor({ owner: false })).status, 400, "only true is a valid body");
  // A live connection without owner, as one made before this default: it is kept, and offered the upgrade.
  fake.consents.push(record("legacy"));
  assert.deepEqual(await textFor({}), { status: 409, body: { ok: false, kind: "refused", code: "already_connected" } }, "a body-less request never replaces a live connection");
  const upgrade = await textFor({ owner: true });
  assert.equal(upgrade.status, 200, "a connection without owner may add it");
  const signed = owner.sign(upgrade.body.value);
  const stored = await json(await call("POST", "/api/agents/portfolio/consent", { cookie,
    body: { message: upgrade.body.value.message, nonce: upgrade.body.value.nonce, publicKey: signed.publicKey, signature: signed.signature } }));
  assert.deepEqual(stored.body.value.consent.scopes, ["owner", "read", "treasury"]);
  assert.equal(fake.consents.find(consent => consent.id === "legacy".padEnd(64, "0"))?.revoked, true, "the one without owner is replaced");
  for (const body of [{}, { owner: true }])
    assert.deepEqual(await textFor(body), { status: 409, body: { ok: false, kind: "refused", code: "already_connected" } }, JSON.stringify(body));
});

test("a signed consent without owner, as an older page's, is still relayed", async () => {
  clean();
  const cookie = await signIn(owner);
  const issued = await fake.platform.consents.nonce();
  assert.ok(issued.ok);
  const text = consentText({ identity: { agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test" }, deployment: "treasury", owner: false }, issued.value.nonce);
  assert.deepEqual(parseConsentMessage(text.message)!.scopes, ["read", "treasury"]);
  const signed = owner.sign(text);
  const stored = await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature } }));
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.deepEqual(stored.body.value.consent.scopes, ["read", "treasury"]);
});

test("new consents are limited per account a day", async t => {
  const counted = fakePlatform({ portfolio: "owner.near" });
  const limited = await testServer({ platform: counted.platform, wallets: [owner], consentsPerDay: 1 });
  t.after(() => limited.server.close());
  const at = limited.base, cookie = await limited.signIn(owner);
  const post = async (path: string, body: unknown) => json(await fetch(`${at}${path}`, { method: "POST", headers: { ...write, cookie }, body: JSON.stringify(body) }));
  const texts = [(await post("/api/agents/portfolio/consent/text", {})).body.value, (await post("/api/agents/portfolio/consent/text", {})).body.value];
  const submit = (text: { message: string; nonce: string }) => { const signed = owner.sign(text as never); return post("/api/agents/portfolio/consent", { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature }); };
  assert.equal((await submit(texts[0])).status, 200);
  assert.deepEqual(await submit(texts[1]), { status: 429, body: { ok: false, kind: "refused", code: "rate_limited" } });
  assert.equal(counted.calls.filter(line => line.startsWith("consents.submit")).length, 1, "the second wasn't relayed");
});

test("the shown consent is the agent's live one with read and treasury, never a setup consent or an earlier agent's", async () => {
  clean();
  const cookie = await signIn(owner);
  fake.consents.push(record("setup", { agentId: "unborn", scopes: ["owner"] }), record("earlier", { agentId: "id-old" }), record("expired", { expiresAt: Date.now() - 1 }));
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/consent", { cookie })), { status: 200, body: { ok: true, value: { consent: null } } });
  assert.equal((await json(await call("POST", "/api/agents/portfolio/consent/text", { cookie, body: {} }))).status, 200, "so it isn't already connected");
});

test("disconnecting revokes this agent's live consents only, found by the platform's list, never by an id the browser sends", async () => {
  clean();
  const cookie = await signIn(owner);
  fake.consents.push(record("live"), record("expired", { expiresAt: Date.now() - 1 }), record("other", { agent: "transferred" }), record("setup", { agentId: "unborn", scopes: ["owner"] }));
  const { status, body } = await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: { id: record("other").id } }));
  assert.deepEqual({ status, body }, { status: 200, body: { ok: true, value: { revoked: 1 } } });
  assert.deepEqual(fake.consents.filter(consent => consent.revoked).map(consent => consent.id), [record("live").id], "not the expired, another agent's, or a setup consent");
  assert.equal(fake.calls[0], "identity portfolio (fresh)", "a write reads the identity anew");
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage, entry.subject]), [["revoke", "attempt", record("live").id], ["revoke", "result", record("live").id]]);
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/consent", { cookie })), { status: 200, body: { ok: true, value: { consent: null } } });
});

test("disconnecting revokes at most five consents a request; the rest answer unavailable, and trying again finishes", async () => {
  clean();
  const cookie = await signIn(owner);
  for (let i = 0; i < 7; i++) fake.consents.push(record(`many${i}`));
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} })), { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.equal(fake.calls.filter(line => line.startsWith("consents.revoke")).length, 5);
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} })), { status: 200, body: { ok: true, value: { revoked: 2 } } });
});

test("a revocation the platform doesn't confirm answers unavailable, is recorded as such, and is safe to try again", async () => {
  clean();
  const cookie = await signIn(owner);
  fake.consents.push(record("live"));
  const revoke = fake.platform.consents.revoke;
  fake.platform.consents.revoke = async () => ({ ok: false, kind: "unavailable" });
  try {
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} })), { status: 503, body: { ok: false, kind: "unavailable" } });
    assert.deepEqual(results().map(entry => entry.stage === "result" && entry.answer), [{ ok: false, kind: "unavailable" }]);
  } finally { fake.platform.consents.revoke = revoke; }
  assert.equal((await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} }))).status, 200, "trying again revokes it");
});

test("an audit trail that can't record the attempt stops the action before the platform sees it", async t => {
  clean();
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  fake.consents.push(record("live"));
  auditFails.stage = "attempt";
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission })), { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} })), { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.ok(!fake.calls.some(line => line.startsWith("consents.submit") || line.startsWith("consents.revoke")), "nothing unrecorded reached the platform");
});

test("a result the audit trail can't record is logged, and the action's answer and the remaining revocations go on", async t => {
  clean();
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  auditFails.stage = "result";
  assert.equal((await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission })).status, 200, "stored, and its attempt is on record");
  fake.consents.length = 0;
  fake.consents.push(record("one"), record("two"));
  assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie, body: {} })), { status: 200, body: { ok: true, value: { revoked: 2 } } });
  assert.ok(logged.mock.calls.filter(call => String(call.arguments[0]).includes("audit_failed")).length >= 3);
});

test("the text's nonce is the one the platform issued: after the owner's wallet stop, a text from before it is refused, and a new one connects", async () => {
  clean();
  const cookie = await signIn(owner);
  const before = await signedConsent(cookie);
  assert.equal(before.text.nonce, fake.issued.at(-1));
  fake.stop("owner.near");
  const stopped = await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: before.submission }));
  assert.deepEqual([stopped.status, stopped.body], [409, { ok: false, kind: "refused", code: "owner_stopped" }]);
  assert.deepEqual(results().map(entry => entry.answer), [{ ok: false, kind: "refused", status: 409, code: "owner_stopped" }]);
  const after = await signedConsent(cookie);
  assert.notEqual(after.text.nonce, before.text.nonce);
  assert.equal((await call("POST", "/api/agents/portfolio/consent", { cookie, body: after.submission })).status, 200);
});

test("no consent text without the platform's nonce: unavailable, or the platform's limit, and never one of this server's", async t => {
  clean();
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  for (const [answer, reply] of [
    [{ ok: false, kind: "unavailable" }, { status: 503, body: { ok: false, kind: "unavailable" } }],
    [{ ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }, { status: 429, body: { ok: false, kind: "refused", code: "platform_rate_limited" } }],
  ] as const) {
    fake.nonceAnswers.push(answer as never);
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent/text", { cookie, body: {} })), reply);
  }
});

test("a consent submission that throws is a lost answer: sent once more, then unavailable, with its result on record", async t => {
  clean();
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  const submit = fake.platform.consents.submit;
  let sent = 0;
  fake.platform.consents.submit = async () => { sent++; throw new Error("socket hang up"); };
  try {
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission })), { status: 503, body: { ok: false, kind: "unavailable" } });
  } finally { fake.platform.consents.submit = submit; }
  assert.equal(sent, 2);
  assert.deepEqual(audited.filter(entry => entry.action === "consent").map(entry => entry.stage === "result" ? entry.answer : entry.stage),
    ["attempt", { ok: false, kind: "unavailable" }]);
});

test("every other relayed action answers what the platform did when its result can't be recorded, and logs the record", async t => {
  clean();
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const actions: [string, unknown][] = [["deposit", { asset: "USDC" }], ["treasury/unlink", {}],
    ["autopilot/stop", {}], ["autopilot/tick", {}], ["proposals", { requestId: "audit-result" }], ["sweep", { execute: true }]];
  auditFails.stage = "result";
  for (const [path, body] of actions)
    assert.equal((await call("POST", `/api/agents/portfolio/${path}`, { cookie, body })).status, 200, path);
  assert.equal(logged.mock.calls.filter(call => String(call.arguments[0]).includes("audit_failed")).length, actions.length);
});

test("the consent routes answer unavailable when the platform's consent list doesn't answer", async () => {
  clean();
  const cookie = await signIn(owner);
  const list = fake.platform.consents.list;
  fake.platform.consents.list = async () => ({ ok: false, kind: "unavailable" });
  try {
    for (const [method, path] of [["GET", "/api/agents/portfolio/consent"], ["POST", "/api/agents/portfolio/consent/revoke"], ["POST", "/api/agents/portfolio/consent/text"]] as const)
      assert.deepEqual(await json(await call(method, path, { cookie, ...(method === "POST" && { body: {} }) })), { status: 503, body: { ok: false, kind: "unavailable" } }, path);
  } finally { fake.platform.consents.list = list; }
});

/** The owner's wallet signs the proposal's own text for a verdict, for the platform's host, as the page will. */
function signedVerdict(view: ProposalView, verdict: "approve" | "reject", text = proposalText(view, verdict), signer = owner) {
  const nonce = randomBytes(32).toString("base64");
  const signed = signer.sign({ message: text, recipient: "platform.test", nonce });
  return { message: text, nonce, publicKey: signed.publicKey, signature: signed.signature };
}
/** Starts a proposals test from nothing: no proposals, no queued answers, no calls, no records, the chain answering. */
function cleanProposals() {
  fake.proposals.length = 0; fake.calls.length = 0; audited.length = 0; delete auditFails.stage;
  for (const action of ["approve", "reject", "execute", "get"] as const) delete fake.proposalAnswers[action];
  keys.lookup = standInKeyLookup({ "owner.near": [owner.publicKey], "intruder.near": [intruder.publicKey] });
}
const mine = (change: Partial<ProposalView> = {}) => ({ ...proposal(change), agent: "portfolio" });
const relayed = (action: string) => fake.calls.filter(line => line.startsWith(`proposals.${action} `)).length;

test("an owner lists and reads only their own agent's proposals, under their own Organization; another owner can't reach them", async () => {
  cleanProposals();
  fake.proposals.push(mine(), { ...proposal({ id: "b".repeat(32), organization: "intruder--near" }), agent: "theirs" });
  const cookie = await signIn(owner), theirs = await signIn(intruder);
  const listed = await json(await call("GET", "/api/agents/portfolio/proposals", { cookie }));
  assert.equal(listed.status, 200);
  assert.deepEqual(proposalList.parse(listed.body.value).proposals.map(item => item.id), ["a".repeat(32)]);
  const read = await json(await call("GET", `/api/agents/portfolio/proposals/${"a".repeat(32)}`, { cookie }));
  assert.equal(contract.proposalRead.parse(read.body.value).proposal.state, "proposed");
  assert.ok(fake.calls.every(line => !line.startsWith("proposals.") || line.includes(" owner--near portfolio")), "always the owner's own Organization");
  for (const path of ["/api/agents/portfolio/proposals", `/api/agents/portfolio/proposals/${"a".repeat(32)}`])
    assert.deepEqual(await json(await call("GET", path, { cookie: theirs })), { status: 403, body: { ok: false, kind: "not_owner" } }, path);
  const own = await json(await call("GET", "/api/agents/theirs/proposals", { cookie: theirs }));
  assert.deepEqual(own.body.value.proposals.map((item: ProposalView) => item.id), ["b".repeat(32)]);
  assert.ok(fake.calls.includes("proposals.list intruder--near theirs"));
  const theirsRead = await json(await call("GET", `/api/agents/theirs/proposals/${"b".repeat(32)}`, { cookie: theirs }));
  assert.equal(theirsRead.body.value.proposal.id, "b".repeat(32), "read under their own Organization");
  assert.deepEqual(await json(await call("GET", `/api/agents/portfolio/proposals/${"c".repeat(32)}`, { cookie })), { status: 404, body: { ok: false, kind: "refused", code: "no_proposal" } });
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/proposals/not-an-id", { cookie })), { status: 400, body: { ok: false, kind: "refused", code: "bad_request" } });
});

test("approving relays the owner's signature over the proposal's exact text, checked against a fresh read, recorded before and after", async () => {
  cleanProposals();
  const view = mine();
  fake.proposals.push(view);
  const cookie = await signIn(owner);
  const body = signedVerdict(view, "approve");
  const { status, body: answer } = await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body }));
  assert.equal(status, 200);
  assert.equal(contract.proposalRead.parse(answer.value).proposal.state, "approved");
  assert.deepEqual(fake.calls.filter(line => line.startsWith("proposals.")), [`proposals.get owner--near portfolio ${view.id}`, `proposals.approve owner--near portfolio ${view.id}`]);
  assert.equal(fake.calls[0], "identity portfolio (fresh)");
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage, entry.subject]), [["approve", "attempt", view.id], ["approve", "result", view.id]]);
  assert.match(audited[0]!.signedTextSha256!, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(audited).includes(body.signature), "no signature in the record");
});

test("rejecting relays the owner's signature over the reject text the same way", async () => {
  cleanProposals();
  const view = mine();
  fake.proposals.push(view);
  const cookie = await signIn(owner);
  const { status, body } = await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/reject`, { cookie, body: signedVerdict(view, "reject") }));
  assert.equal(status, 200);
  assert.equal(body.value.proposal.state, "rejected");
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["reject", "attempt"], ["reject", "result"]]);
});

test("an audit trail that can't record the attempt stops an approve, reject or execute before the platform sees it", async t => {
  t.mock.method(console, "error", () => {});
  t.after(() => { delete auditFails.stage; });
  const cookie = await signIn(owner);
  for (const [action, state] of [["approve", "proposed"], ["reject", "proposed"], ["execute", "approved"]] as const) {
    cleanProposals();
    const view = mine({ state });
    fake.proposals.push(view);
    const body = action === "execute" ? {} : signedVerdict(view, action);
    auditFails.stage = "attempt";
    assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/${action}`, { cookie, body })),
      { status: 503, body: { ok: false, kind: "unavailable" } }, action);
    assert.equal(relayed(action), 0, `${action}: nothing unrecorded reached the platform`);
  }
});

test("a verdict on other terms, on a proposal no longer open, after it expired, or not signed by the owner's key is refused before relaying", async () => {
  const cookie = await signIn(owner);
  const view = mine(), past = new Date(Date.now() - 1).toISOString();
  const cases: [Partial<ProposalView>, () => object, number, string][] = [
    [{}, () => signedVerdict(view, "approve", proposalText({ ...view, legs: [{ ...view.legs[0]!, minAmountOut: "1" }] }, "approve")), 409, "not_this_text"],
    [{}, () => signedVerdict(view, "approve", proposalText(view, "reject")), 409, "not_this_text"],
    [{ state: "approved" }, () => signedVerdict(view, "approve"), 409, "not_open"],
    [{ expiresAt: past }, () => signedVerdict(view, "approve", proposalText({ ...view, expiresAt: past }, "approve")), 409, "expired"],
    [{}, () => signedVerdict(view, "approve", undefined, intruder), 400, "signature_invalid"],
    [{}, () => ({ ...signedVerdict(view, "approve"), signature: signedVerdict(view, "reject").signature }), 400, "signature_invalid"],
  ];
  for (const [change, body, status, code] of cases) {
    cleanProposals();
    fake.proposals.push({ ...view, ...change });
    assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body: body() })),
      { status, body: { ok: false, kind: "refused", code } }, code);
    assert.equal(relayed("approve"), 0, "nothing relayed");
    assert.deepEqual(audited, [], "nothing relayed, so nothing recorded");
  }
  cleanProposals();
  fake.proposals.push({ ...view });
  keys.lookup = async () => "unavailable";
  assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body: signedVerdict(view, "approve") })),
    { status: 503, body: { ok: false, kind: "unavailable" } }, "the chain didn't answer about the key");
  assert.equal(relayed("approve"), 0);
  cleanProposals();
  fake.proposals.push({ ...view });
  assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body: { ...signedVerdict(view, "approve"), nonce: "short" } })),
    { status: 400, body: { ok: false, kind: "refused", code: "bad_request" } });
});

test("the platform's refusals of a verdict reach the browser as their code; anything else is unavailable, with no platform text", async () => {
  const cookie = await signIn(owner);
  const answers: [Awaited<ReturnType<typeof fake.platform.proposals.approve>>, number, unknown][] = [
    [{ ok: false, kind: "refused", status: 400, code: "signature_invalid", error: "The signature doesn't verify" }, 400, { ok: false, kind: "refused", code: "signature_invalid" }],
    [{ ok: false, kind: "refused", status: 409, code: "invalidated", error: "The policy changed" }, 409, { ok: false, kind: "refused", code: "invalidated" }],
    [{ ok: false, kind: "refused", status: 409, code: "withdrawn", error: "Its consent ended" }, 409, { ok: false, kind: "refused", code: "withdrawn" }],
    [{ ok: false, kind: "refused", status: 409, code: "policy_not_in_force", error: "The policy is not in force" }, 409, { ok: false, kind: "refused", code: "policy_not_in_force" }],
    [{ ok: false, kind: "forbidden", status: 403, error: "No live owner consent covers this Organization and agent" }, 409, { ok: false, kind: "refused", code: "not_connected" }],
    [{ ok: false, kind: "refused", status: 429, error: "Request limit reached" }, 503, { ok: false, kind: "unavailable" }],
  ];
  for (const [queued, status, body] of answers) {
    cleanProposals();
    const view = mine();
    fake.proposals.push(view);
    fake.proposalAnswers.approve = [queued];
    assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body: signedVerdict(view, "approve") })), { status, body });
    assert.equal(audited.filter(entry => entry.stage === "result").length, 1, "the result is recorded whatever it was");
    assert.equal(relayed("approve"), 1, "relayed once");
  }
});

test("after a lost verdict, a thrown call or already_approved, the proposal is read once and its state answers whether the verdict was recorded", async t => {
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const cases: [ProposalAnswer | Error, ProposalView["state"], number, string][] = [
    [{ ok: false, kind: "unknown", procedure: "proposals/approve", identity: {} } as never, "approved", 200, "approved"],
    [{ ok: false, kind: "unavailable" }, "approved", 200, "approved"],
    [new Error("socket hang up"), "approved", 200, "approved"],
    [{ ok: false, kind: "refused", status: 409, code: "already_approved", error: "The owner already approved this proposal." }, "approved", 200, "approved"],
    [{ ok: false, kind: "unknown", procedure: "proposals/approve", identity: {} } as never, "proposed", 503, "unavailable"],
  ];
  for (const [queued, then, status, outcome] of cases) {
    cleanProposals();
    const view = mine();
    fake.proposals.push(view);
    fake.proposalAnswers.approve = [queued];
    const body = signedVerdict(view, "approve");
    const { agent: _agent, ...asShown } = view;
    fake.proposalAnswers.get = [{ ok: true, value: { ...asShown } }];
    view.state = then;
    const answer = await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/approve`, { cookie, body }));
    assert.equal(answer.status, status, String(queued));
    assert.equal(answer.status === 200 ? answer.body.value.proposal.state : answer.body.kind, outcome);
    assert.equal(relayed("approve"), 1, "never relayed twice");
    assert.equal(relayed("get"), 2, "the check's read, then one read after the lost answer");
    assert.deepEqual(audited.map(entry => entry.stage), ["attempt", "result"], "a result is recorded even when the call threw");
  }
  cleanProposals();
  const view = mine();
  fake.proposals.push(view);
  fake.proposalAnswers.reject = [{ ok: false, kind: "unavailable" }];
  const body = signedVerdict(view, "reject");
  const { agent: _agent, ...asShown } = view;
  fake.proposalAnswers.get = [{ ok: true, value: { ...asShown } }];
  view.state = "approved";
  assert.deepEqual(await json(await call("POST", `/api/agents/portfolio/proposals/${view.id}/reject`, { cookie, body })),
    { status: 503, body: { ok: false, kind: "unavailable" } }, "a lost rejection isn't recorded by the proposal reading approved");
});

test("execute is sent only for an approved proposal; any other state is answered from the fresh read without asking the platform", async () => {
  const cookie = await signIn(owner);
  const execute = () => call("POST", `/api/agents/portfolio/proposals/${"a".repeat(32)}/execute`, { cookie, body: {} });
  cleanProposals();
  fake.proposals.push(mine());
  assert.deepEqual(await json(await execute()), { status: 409, body: { ok: false, kind: "refused", code: "not_approved" } });
  for (const [state, result] of [["executing", "pending"], ["unknown", "pending"], ["executed", "final"], ["stopped", "final"], ["rejected", "final"], ["expired", "final"]] as const) {
    cleanProposals();
    fake.proposals.push(mine({ state }));
    const { status, body } = await json(await execute());
    assert.equal(status, 200, state);
    assert.deepEqual([body.value.result, body.value.proposal.state], [result, state], state);
    assert.equal(relayed("execute"), 0, `${state}: no execute sent, no quota spent`);
    assert.deepEqual(audited, [], "nothing relayed, so nothing recorded");
  }
});

test("execute: once per click; its answer is final, pending or not executable, and a lost answer is read, never resent", async t => {
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const execute = () => call("POST", `/api/agents/portfolio/proposals/${"a".repeat(32)}/execute`, { cookie, body: {} });
  const unknown = { ok: false, kind: "unknown", procedure: "proposals/execute", identity: {} } as never;
  const cases: [(ProposalAnswer | Error)[], (ProposalAnswer | Error)[], string, ProposalView["state"] | null][] = [
    [[], [], "final", "executed"],
    [[{ ok: true, value: proposal({ state: "executing" }) }], [], "pending", "executing"],
    [[{ ok: true, value: proposal({ state: "unknown" }) }], [], "pending", "unknown"],
    [[{ ok: true, value: proposal({ state: "stopped" }) }], [], "final", "stopped"],
    [[{ ok: false, kind: "refused", status: 409, code: "not_executable", error: "Price below a signed floor" }], [], "not_executable", "approved"],
    [[{ ok: false, kind: "refused", status: 409, code: "not_executable", error: "claimed meanwhile" }], [{ ok: true, value: proposal({ state: "executed" }) }], "final", "executed"],
    [[{ ok: false, kind: "unavailable" }], [], "pending", "approved"],
    [[unknown], [{ ok: true, value: proposal({ state: "executed" }) }], "final", "executed"],
    [[new Error("socket hang up")], [], "pending", "approved"],
    [[unknown], [{ ok: false, kind: "unavailable" }], "pending", null],
    [[unknown], [new Error("socket hang up")], "pending", null],
  ];
  for (const [executeAnswers, laterReads, result, state] of cases) {
    cleanProposals();
    fake.proposals.push(mine({ state: "approved" }));
    fake.proposalAnswers.execute = [...executeAnswers];
    fake.proposalAnswers.get = [{ ok: true, value: proposal({ state: "approved" }) }, ...laterReads];
    const { status, body } = await json(await execute());
    const label = `${JSON.stringify(executeAnswers[0] ?? "ok")} then ${JSON.stringify(laterReads[0] ?? "read")}`;
    assert.equal(status, 200, label);
    const parsed = contract.executeResult.parse(body.value);
    assert.deepEqual([parsed.result, parsed.proposal?.state ?? null], [result, state], label);
    assert.equal(relayed("execute"), 1, "one execute, never resent after a lost answer");
    assert.equal(fake.calls[0], "identity portfolio (fresh)", "a write reads the identity anew");
    assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["execute", "attempt"], ["execute", "result"]], "a result even when the call threw");
    assert.ok(!JSON.stringify(body).includes("floor"), "no platform text reaches the browser");
  }
  cleanProposals();
  fake.proposals.push(mine({ state: "approved" }));
  fake.proposalAnswers.execute = [{ ok: false, kind: "forbidden", status: 403, error: "No live owner consent covers this Organization and agent" }];
  assert.deepEqual(await json(await execute()), { status: 409, body: { ok: false, kind: "refused", code: "not_connected" } });
});

test("a DAO's member reads its agent: the DAO is the owner, and the member's access comes from its roles in the DAO's policy", async t => {
  policies[DAO] = DAO_POLICY;
  t.after(() => { delete policies[DAO]; });
  const cookie = await signIn(council);
  const { status, body } = await json(await call("GET", "/api/agents/dao-treasury", { cookie }));
  assert.equal(status, 200);
  assert.deepEqual(contract.agent.parse(body.value), { agent: "dao-treasury", owner: DAO, agentId: "id-dao-treasury", host: "platform.test",
    signer: "dao", account: "council.near", access: { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: false } });
});

test("an account no Group role of the DAO names isn't admitted, even with the rights Everyone has: the same answer as a stranger's", async t => {
  policies[DAO] = daoPolicy({ council: { members: ["council.near"], permissions: ["*:*"] } }, ["*:AddProposal", "*:VoteApprove"]);
  t.after(() => { delete policies[DAO]; });
  const cookie = await signIn(intruder);
  for (const route of routes.filter(route => route.access === "owner" || route.access === "owner-fresh")) {
    fake.calls.length = 0;
    const { status, body } = await json(await call(route.method, pathOf(route, "dao-treasury").replace(":id", "0".repeat(32)), { cookie, ...(route.method !== "GET" && { body: {} }) }));
    assert.deepEqual([status, body], [403, { ok: false, kind: "not_owner" }], route.path);
    assert.ok(fake.calls.every(made => made.startsWith("identity ")), `${route.path}: ${fake.calls}`);
  }
});

test("a DAO policy that can't be read admits no one: unavailable, and logged", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(council);
  const { status, body } = await json(await call("GET", "/api/agents/dao-treasury", { cookie }));
  assert.deepEqual([status, body], [503, { ok: false, kind: "unavailable" }]);
  assert.ok(logged.mock.calls.some(c => String(c.arguments[0]).includes("dao_policy_unavailable")));
});

test("each agent route asks for what it needs: a member who may only file is refused execute, one with no rights is refused filing, and no member signs or links", async t => {
  policies[DAO] = DAO_POLICY;
  t.after(() => { delete policies[DAO]; });
  const needs = Object.fromEntries(routes.flatMap(route => route.access === "owner" || route.access === "owner-fresh" ? [[`${route.method} ${route.path}`, route.needs]] : []));
  const members = { council: await signIn(council), proposer: await signIn(proposer), reader: await signIn(reader) };
  // What each member's roles allow, per need: council may file, vote and execute; proposer only file; reader only read.
  const allowed: Record<string, Record<string, boolean>> = {
    read: { council: true, proposer: true, reader: true },
    file: { council: true, proposer: true, reader: false },
    execute: { council: true, proposer: false, reader: false },
    sign: { council: false, proposer: false, reader: false },
    // A deposit address, as filing: anyone who may file a proposal. The funding account is the DAO's own, so no member links it.
    deposit: { council: true, proposer: true, reader: false },
    link: { council: false, proposer: false, reader: false },
    // Shielding executes, as a proposal's execution does.
    sweep: { council: true, proposer: false, reader: false },
    // A rebalance to approve, as filing: anyone who may file a proposal.
    propose: { council: true, proposer: true, reader: false },
    // Autopilot on and Run now execute; turning it off needs execute or manage rights.
    enable: { council: true, proposer: false, reader: false },
    stop: { council: true, proposer: false, reader: false },
    tick: { council: true, proposer: false, reader: false },
    // Saving the strategy is a policy-level act for a DAO: only members who may file and vote on policy changes.
    save: { council: false, proposer: false, reader: false },
  };
  for (const route of routes.filter(route => route.access === "owner" || route.access === "owner-fresh")) {
    const need = needs[`${route.method} ${route.path}`]!;
    for (const [name, cookie] of Object.entries(members)) {
      const response = await call(route.method, pathOf(route, "dao-treasury").replace(":id", "0".repeat(32)), { cookie, ...(route.method !== "GET" && { body: {} }) });
      // A download (the ledger's CSV) isn't JSON: it was allowed.
      const download = /^text\/csv/.test(response.headers.get("content-type") ?? "");
      const status = response.status, body = download ? { csv: await response.text() } as any : await response.json() as any;
      const refusedHere = status === 403 && body.code === "not_permitted";
      assert.equal(refusedHere, !allowed[need]![name], `${name} ${route.method} ${route.path} (${need}): ${status} ${JSON.stringify(body)}`);
    }
  }
});

/** A DAO with the member policy and no requests, proposals or consents yet, for a DAO consent test. */
async function freshDao(t: { after(fn: () => void): void }) {
  policies[DAO] = DAO_POLICY;
  chainProposals[DAO] = [];
  for (const open of daoRequests.open()) await daoRequests.close(open.id);
  fake.daoRequests.length = 0;
  fake.daoVotes.length = 0;
  fake.proposals.splice(0, fake.proposals.length, ...fake.proposals.filter(item => item.agent !== "dao-treasury"));
  fake.consents.splice(0, fake.consents.length, ...fake.consents.filter(consent => consent.owner !== DAO));
  audited.length = 0;
  t.after(() => { delete policies[DAO]; delete chainProposals[DAO]; });
}
/** A proposal on the DAO's chain, numbered next, asking it to sign `hash`, as a member's filing makes it. */
const fileOnChain = (hash: string, status: DaoProposal["status"] = "InProgress") =>
  chainProposals[DAO]!.push({ id: chainProposals[DAO]!.length, kind: daoKind(hash), status, submission_time: String(BigInt(Date.now()) * 1_000_000n) });

test("a member who may file connects a DAO's agent: the consent filed once for the DAO's vote, stored, recorded, and its transaction offered", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  fake.calls.length = 0;
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: { owner: true } })),
    { status: 400, body: { ok: false, kind: "refused", code: "bad_request" } }, "a DAO's consent never carries owner");
  assert.deepEqual(fake.calls.filter(made => made.startsWith("daoConsents")), [], "nothing filed for it");
  const { status, body } = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  const { request } = contract.daoFiled.parse(body.value);
  const filed = fake.daoRequests[0]!;
  assert.equal(request.id, filed.id);
  assert.equal(request.check, `https://platform.test/confirm/dao/${filed.id}`);
  // The council may vote too, and nothing has taken the DAO's next number: file and vote in one transaction.
  assert.deepEqual(request.offer, { state: "file", transaction: daoTransaction(DAO, filed.id, 0) });
  const text = parseConsentMessage(filed.message)!;
  assert.deepEqual([text.owner, text.organization, text.agent, text.scopes], [DAO, "agentic--sputnik-dao--near", "dao-treasury", ["read", "treasury"]]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("dao")), ["daoConsents.file"]);
  assert.equal(daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury")?.id, filed.id, "stored before it's shown");
  const stored = daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury");
  assert.equal(stored?.kind === "consent" && stored.agentId, "id-dao-treasury", "with the identity its consent names");
  // The request is named by its own field, the hash the DAO's vote signs: a consent has no subject until it's stored.
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage, entry.who, entry.subject, entry.request]),
    [["dao-consent", "attempt", "council.near", undefined, undefined], ["dao-consent", "result", "council.near", undefined, filed.id]]);
  assert.equal(audited[0]!.signedTextSha256, createHash("sha256").update(filed.message).digest("hex"));
});

test("another member's click answers the open request, never files another; one who may file but not vote gets the plain filing", async t => {
  await freshDao(t);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie: await signIn(council), body: {} });
  const { body } = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie: await signIn(proposer), body: {} }));
  assert.equal(fake.daoRequests.length, 1);
  assert.deepEqual(body.value.request.offer, { state: "file", transaction: daoTransaction(DAO, fake.daoRequests[0]!.id) });
});

test("two members clicking at once file once", async t => {
  await freshDao(t);
  const [a, b] = [await signIn(council), await signIn(proposer)];
  const answers = await Promise.all([a, b].map(cookie => call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }).then(json)));
  assert.deepEqual(answers.map(answer => answer.status), [200, 200]);
  assert.equal(fake.daoRequests.length, 1);
});

test("once a member's proposal is on the DAO, every member is pointed to vote on it in Trezu, and offered nothing to file", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  fileOnChain("0".repeat(64)); // another proposal took the number first
  fileOnChain(fake.daoRequests[0]!.id);
  for (const member of [council, proposer, reader]) {
    const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie: await signIn(member) }));
    assert.deepEqual(body.value.request.offer, { state: "filed", proposal: 1, vote: "https://trezu.app/agentic.sputnik-dao.near/requests/1" }, member.accountId);
  }
});

test("after the vote, reading the connection stores the consent: the request closed, recorded, and the DAO's older consents revoked", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  // A consent the DAO gave this deployment meanwhile, as another of its servers would store it: the vote supersedes it.
  const text = parseConsentMessage(fake.daoRequests[0]!.message)!;
  const { type: _type, version: _version, expiresAt, ...named } = text;
  const older = { ...named, id: "e".repeat(64), expiresAt: Date.parse(expiresAt) - 1, createdAt: 0, publicKey: "ed25519:dao", revoked: false, revokedAt: null };
  fake.consents.push(older);
  fake.daoRequests[0]!.signed = true;
  audited.length = 0;
  const { status, body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
  assert.equal(status, 200);
  const connection = contract.consent.parse(body.value);
  assert.ok(connection.consent && connection.consent.id !== older.id, "the consent the vote stored");
  assert.equal(connection.request, null);
  assert.equal(daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury"), undefined, "closed");
  assert.equal(older.revoked, true, "the DAO's older consent is revoked");
  // What the DAO's vote did is recorded for the DAO, whichever member's read found it.
  assert.deepEqual(audited.map(entry => [entry.who, entry.action, entry.stage, entry.subject]),
    [[DAO, "dao-consent-stored", "result", connection.consent.id], [DAO, "revoke", "attempt", older.id], [DAO, "revoke", "result", older.id]]);
  assert.equal(audited[0]!.request, fake.daoRequests[0]!.id, "the stored consent names the request its vote passed");
});

test("a request whose vote didn't pass in time, or that a DAO stop ended, is closed and says why; a new one may be filed", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  for (const [code, ended] of [[410, "expired"], [409, "stopped"]] as const) {
    await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
    fake.daoRequests.at(-1)!.ended = code;
    const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
    assert.deepEqual(body.value, { consent: null, request: null, ended });
    assert.equal(daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury"), undefined);
  }
  assert.equal(fake.daoRequests.length, 2, "each was filed anew");
});

test("a request whose DAO proposal was rejected or expired is closed and says why, so a member may ask again (#100)", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  for (const [status, ended] of [["Rejected", "rejected"], ["Expired", "expired"]] as const) {
    await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
    // The platform keeps the request pending until its vote window closes, though the DAO already answered no.
    fileOnChain(fake.daoRequests.at(-1)!.id, status);
    const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
    assert.deepEqual(body.value, { consent: null, request: null, ended }, status);
    assert.equal(daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury"), undefined, status);
  }
  assert.equal(fake.daoRequests.length, 2, "each was filed anew");
});

test("asking again while the DAO's proposal for the open request has ended files a new request", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  const first = fake.daoRequests[0]!.id;
  fileOnChain(first, "Rejected");
  const { status, body } = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(fake.daoRequests.length, 2);
  assert.notEqual(body.value.request.id, first);
  assert.equal(body.value.request.offer.state, "file");
});

test("a vote whose DAO proposal was rejected is closed, and a member may ask for the verdict again", async t => {
  await freshDao(t);
  const id = "1".repeat(32);
  daoProposal(id);
  const cookie = await signIn(council);
  await call("POST", `/api/agents/dao-treasury/proposals/${id}/approve`, { cookie, body: {} });
  fileOnChain(fake.daoVotes[0]!.id, "Rejected");
  const { body } = await json(await call("GET", `/api/agents/dao-treasury/proposals/${id}`, { cookie }));
  assert.equal(body.value.vote, null);
  assert.equal(daoRequests.vote(DAO_ORG, "dao-treasury", id), undefined, "closed");
  const again = await json(await call("POST", `/api/agents/dao-treasury/proposals/${id}/approve`, { cookie, body: {} }));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(fake.daoVotes.length, 2, "filed anew");
});

test("a DAO whose next proposal number can't be read files nothing; one whose proposals can't be read shows the request without an offer", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  t.mock.method(console, "error", () => {});
  delete chainProposals[DAO];
  const { status } = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }));
  assert.equal(status, 503);
  assert.equal(fake.daoRequests.length, 0);
  assert.deepEqual(audited, [], "nothing recorded: nothing was filed");
  chainProposals[DAO] = [];
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  delete chainProposals[DAO];
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
  assert.equal(body.value.request.id, fake.daoRequests[0]!.id, "the request is still shown");
  assert.equal(body.value.request.offer, null);
});

test("the platform's refusals of a filing map to the browser's codes, are recorded with them, and a lost answer isn't filed again", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  const logged = t.mock.method(console, "error", () => {});
  const cases = [
    [{ ok: false, kind: "rate_limited", status: 429, error: "Too many DAO requests today", retryAfterSeconds: 3600 }, 429, "rate_limited"],
    [{ ok: false, kind: "refused", status: 429, error: "Too many DAO requests today" }, 429, "rate_limited"],
    [{ ok: false, kind: "refused", status: 409, error: "Read the agent again" }, 409, "agent_changed"],
    [{ ok: false, kind: "unavailable" }, 503, undefined],
  ] as const;
  for (const [answer, status, code] of cases) {
    fake.daoAnswers.push(answer as never);
    fake.calls.length = 0;
    audited.length = 0;
    const reply = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }));
    assert.equal(reply.status, status);
    assert.equal(reply.body.code, code);
    assert.deepEqual(fake.calls.filter(made => made.startsWith("dao")), ["daoConsents.file"], "asked once");
    assert.equal(audited.at(-1)!.stage, "result");
  }
  assert.equal(daoRequests.consent("agentic--sputnik-dao--near", "dao-treasury"), undefined, "nothing stored");
  assert.ok(logged.mock.calls.some(c => String(c.arguments[0]).includes("platform_dao_consent_failed")));
});

const DAO_ORG = "agentic--sputnik-dao--near";
/** One of the app's proposals for the DAO's agent, open, as `watch` would have made it under the DAO's consent. */
function daoProposal(id: string) {
  const made = { ...proposal({ id, organization: DAO_ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" };
  fake.proposals.push(made);
  return made;
}

test("a filing call that throws answers unavailable, records its result, and stores nothing; the next click files again", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  const subjects = [
    ["dao-consent", "/api/agents/dao-treasury/consent/text", fake.platform.daoConsents],
    ["dao-vote", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, fake.platform.daoVotes],
  ] as const;
  for (const [action, path, calls] of subjects) {
    audited.length = 0;
    const thrown = t.mock.method(calls, "file", async () => { throw new Error("socket hang up"); });
    const { status, body } = await json(await call("POST", path, { cookie, body: {} }));
    assert.deepEqual([status, body], [503, { ok: false, kind: "unavailable" }], action);
    assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [[action, "attempt"], [action, "result"]], action);
    const result = audited[1]!;
    assert.deepEqual(result.stage === "result" && result.answer, { ok: false, kind: "unavailable" }, action);
    thrown.mock.restore();
    const again = await json(await call("POST", path, { cookie, body: {} }));
    assert.equal(again.status, 200, `${action}: ${JSON.stringify(again.body)}`);
  }
});

test("a member who may file asks for the DAO's verdict on a proposal: its vote filed once, from the platform's text, stored and recorded", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  fake.calls.length = 0;
  // The browser sends nothing for a DAO: the platform files the vote from its own text of the proposal.
  const { status, body } = await json(await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie, body: { message: "ignored" } }));
  assert.equal(status, 200, JSON.stringify(body));
  const { request } = contract.daoFiled.parse(body.value);
  const filed = fake.daoVotes[0]!;
  assert.deepEqual([filed.proposal, filed.verdict, request.id, request.verdict], ["1".repeat(32), "approve", filed.id, "approve"]);
  assert.deepEqual(request.offer, { state: "file", transaction: daoTransaction(DAO, filed.id, 0) });
  assert.deepEqual(fake.calls.filter(made => made.startsWith("dao")), [`daoVotes.file ${"1".repeat(32)} approve`]);
  assert.equal(daoRequests.vote(DAO_ORG, "dao-treasury", "1".repeat(32))?.id, filed.id, "stored before it's shown");
  // Both records name the proposal and the verdict asked for; the result adds the request, so the two are linked.
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage, entry.who, entry.subject, entry.verdict, entry.request]),
    [["dao-vote", "attempt", "council.near", "1".repeat(32), "approve", undefined], ["dao-vote", "result", "council.near", "1".repeat(32), "approve", filed.id]]);
});

test("one vote per proposal: another member's opposite verdict is answered with the open vote, and nothing is filed", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie: await signIn(council), body: {} });
  const { body } = await json(await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/reject`, { cookie: await signIn(proposer), body: {} }));
  assert.equal(body.value.request.verdict, "approve", "the open vote, with its verdict: vote against it in Trezu");
  assert.equal(fake.daoVotes.length, 1);
});

test("after the DAO's vote passes, reading the proposal relays it: the proposal approved, the vote closed and recorded for the DAO", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie, body: {} });
  const waiting = await json(await call("GET", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}`, { cookie }));
  assert.equal(waiting.body.value.proposal.state, "proposed");
  assert.equal(waiting.body.value.vote.id, fake.daoVotes[0]!.id, "the vote waits");
  fake.daoVotes[0]!.passed = true;
  audited.length = 0;
  const { body } = await json(await call("GET", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}`, { cookie: await signIn(reader) }));
  assert.equal(contract.proposalRead.parse(body.value).proposal.state, "approved");
  assert.equal(body.value.vote, null);
  assert.equal(daoRequests.vote(DAO_ORG, "dao-treasury", "1".repeat(32)), undefined, "closed");
  assert.deepEqual(audited.map(entry => [entry.who, entry.action, entry.stage, entry.subject, entry.verdict, entry.request]),
    [[DAO, "dao-vote-relayed", "result", "1".repeat(32), "approve", fake.daoVotes[0]!.id]]);
});

test("a vote past its deadline is closed; one the platform can't relay for now (409) stays open and is read again", async t => {
  await freshDao(t);
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(council);
  for (const [code, open] of [[409, true], [410, false]] as const) {
    const id = String(code).padStart(32, "0");
    daoProposal(id);
    await call("POST", `/api/agents/dao-treasury/proposals/${id}/approve`, { cookie, body: {} });
    fake.daoVotes.at(-1)!.ended = code;
    const { body } = await json(await call("GET", `/api/agents/dao-treasury/proposals/${id}`, { cookie }));
    assert.equal(body.value.vote !== null, open, `${code}`);
    assert.equal(daoRequests.vote(DAO_ORG, "dao-treasury", id) !== undefined, open, `${code}`);
  }
});

test("the platform's refusals of a vote map to the browser's codes: not open, not connected, the day's requests spent", async t => {
  await freshDao(t);
  t.mock.method(console, "error", () => {});
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  for (const [answer, code] of [
    [{ ok: false, kind: "refused", status: 409, error: "This proposal is approved" }, "not_open"],
    [{ ok: false, kind: "refused", status: 403, error: "No live DAO consent covers this agent" }, "not_connected"],
    [{ ok: false, kind: "rate_limited", status: 429, error: "Too many DAO requests today", retryAfterSeconds: 3600 }, "rate_limited"],
    [{ ok: false, kind: "refused", status: 429, error: "Too many DAO requests today" }, "rate_limited"],
  ] as const) {
    fake.voteAnswers.push(answer as never);
    const { body } = await json(await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie, body: {} }));
    assert.equal(body.code, code);
  }
  assert.equal(daoRequests.vote(DAO_ORG, "dao-treasury", "1".repeat(32)), undefined, "nothing stored");
});

test("DAO filings are limited per member a day, consents and votes together, since the deployment's 256 are shared", async t => {
  const counted = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const limited = await testServer({ platform: counted.platform, wallets: [council], daoFilingsPerDay: 1, daos: standInDaos({ [DAO]: DAO_POLICY }, { [DAO]: [] }) });
  t.after(() => limited.server.close());
  const at = limited.base, cookie = await limited.signIn(council);
  const post = async (path: string) => json(await fetch(`${at}${path}`, { method: "POST", headers: { ...write, cookie }, body: "{}" }));
  counted.proposals.push({ ...proposal({ id: "1".repeat(32), organization: DAO_ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" });
  assert.equal((await post("/api/agents/dao-treasury/consent/text")).status, 200);
  assert.deepEqual(await post(`/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`), { status: 429, body: { ok: false, kind: "refused", code: "rate_limited" } });
  assert.equal(counted.calls.filter(line => line.startsWith("daoVotes.file")).length, 0, "the vote wasn't filed");
});

test("a filing that never reaches the platform doesn't spend the member's allowance for the day", async t => {
  t.mock.method(console, "error", () => {});
  const counted = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const chain: Record<string, DaoProposal[]> = {};
  const limited = await testServer({ platform: counted.platform, wallets: [council], daoFilingsPerDay: 1, daos: standInDaos({ [DAO]: DAO_POLICY }, chain) });
  t.after(() => limited.server.close());
  const at = limited.base, cookie = await limited.signIn(council);
  const post = async (path: string) => json(await fetch(`${at}${path}`, { method: "POST", headers: { ...write, cookie }, body: "{}" }));
  // The DAO's next proposal number can't be read, so nothing is filed.
  assert.equal((await post("/api/agents/dao-treasury/consent/text")).status, 503);
  chain[DAO] = [];
  assert.equal((await post("/api/agents/dao-treasury/consent/text")).status, 200, "the day's one filing is still there");
  assert.equal(counted.calls.filter(line => line.startsWith("daoConsents.file")).length, 1);
});

test("a consent request whose state can't be read now stays open: shown again, and never filed again", async t => {
  await freshDao(t);
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  const filed = fake.daoRequests[0]!;
  t.mock.method(fake.platform.daoConsents, "state", async () => ({ ok: false, kind: "unavailable" }));
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
  assert.equal(body.value.request.id, filed.id, "still shown");
  assert.equal(daoRequests.consent(DAO_ORG, "dao-treasury")?.id, filed.id, "still open");
  const again = await json(await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }));
  assert.equal(again.body.value.request.id, filed.id);
  assert.equal(fake.daoRequests.length, 1, "never filed again");
});

test("once the DAO's vote is relayed, a member who may execute runs the proposal once; one who may only file can't", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie, body: {} });
  fake.daoVotes[0]!.passed = true;
  await call("GET", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}`, { cookie });
  const refusedHere = await json(await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/execute`, { cookie: await signIn(proposer), body: {} }));
  assert.deepEqual(refusedHere.body, { ok: false, kind: "refused", code: "not_permitted" });
  fake.calls.length = 0;
  const { status, body } = await json(await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/execute`, { cookie, body: {} }));
  assert.equal(status, 200);
  assert.deepEqual([body.value.result, body.value.proposal.state], ["final", "executed"]);
  assert.equal(fake.calls.filter(made => made.startsWith("proposals.execute")).length, 1);
});

test("when the server can't keep another DAO request, nothing is filed: the platform isn't asked, so no request is left unfollowed", async t => {
  const counted = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const full = await createDaoRequests(join(tempDir("treasury-dao-requests-"), "dao-requests.json"), { max: 1 });
  await full.add({ kind: "consent", organization: "other", agent: "other", agentId: "id-other", id: "e".repeat(64), description: "", votingUntil: Date.now() + 1,
    filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, "e".repeat(64)), proposalAndVote: null } } });
  const limited = await testServer({ platform: counted.platform, wallets: [council], daos: standInDaos({ [DAO]: DAO_POLICY }, { [DAO]: [] }), daoRequests: full });
  t.after(() => limited.server.close());
  const logged = t.mock.method(console, "error", () => {});
  const at = limited.base;
  const cookie = await limited.signIn(council);
  const reply = await json(await fetch(`${at}/api/agents/dao-treasury/consent/text`, { method: "POST", headers: { ...write, cookie }, body: "{}" }));
  assert.deepEqual(reply, { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.equal(counted.calls.filter(made => made.startsWith("daoConsents.file")).length, 0, "the platform wasn't asked");
  assert.ok(logged.mock.calls.some(c => String(c.arguments[0]).includes("dao_requests_full")));
});

test("members clicking at once share one filing, but each is offered what their own roles allow", async t => {
  await freshDao(t);
  const [voter, filer] = [await signIn(council), await signIn(proposer)];
  const [forVoter, forFiler] = await Promise.all([voter, filer].map(cookie => call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} }).then(json)));
  assert.equal(fake.daoRequests.length, 1, "one filing");
  const id = fake.daoRequests[0]!.id;
  assert.deepEqual(forVoter!.body.value.request.offer, { state: "file", transaction: daoTransaction(DAO, id, 0) }, "the council may vote too");
  assert.deepEqual(forFiler!.body.value.request.offer, { state: "file", transaction: daoTransaction(DAO, id) }, "the proposer only files");
});

test("why a consent request ended is shown whichever read saw it first: the background reader's too", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  fake.daoRequests[0]!.ended = 410;
  // The background reader's pass sees the end first, and closes the request.
  const reader = createDaoReader({ daoRequests, settle: createSettle({ platform: fake.platform, daoRequests, audit: { append: async () => {} } }) }, { limit: 5 });
  await reader.pass();
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }));
  assert.deepEqual(body.value, { consent: null, request: null, ended: "expired" });
  // A new request clears it.
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  fake.daoRequests[1]!.signed = true;
  assert.equal((await json(await call("GET", "/api/agents/dao-treasury/consent", { cookie }))).body.value.ended, undefined);
});

test("after the consent is revoked, the platform's forbidden asks the owner to reconnect: not_connected on every proposal route, nothing retried", async t => {
  t.mock.method(console, "error", () => {});
  clean(); cleanProposals();
  const cookie = await signIn(owner);
  const { submission } = await signedConsent(cookie);
  assert.equal((await call("POST", "/api/agents/portfolio/consent", { cookie, body: submission })).status, 200);
  fake.proposals.push(mine({ state: "approved" }));
  assert.deepEqual((await json(await call("POST", "/api/agents/portfolio/consent/revoke", { cookie }))).body, { ok: true, value: { revoked: 1 } });
  // The platform now refuses every call under the ended consent, as its app route does.
  const forbidden = { ok: false as const, kind: "forbidden" as const, status: 403 as const, error: "No live owner consent covers this Organization and agent" };
  const { list, get } = fake.platform.proposals;
  fake.platform.proposals.list = async (organization, agent) => { fake.calls.push(`proposals.list ${organization} ${agent}`); return forbidden; };
  fake.platform.proposals.get = async (organization, agent, id) => { fake.calls.push(`proposals.get ${organization} ${agent} ${id}`); return forbidden; };
  t.after(() => { Object.assign(fake.platform.proposals, { list, get }); });
  const id = "a".repeat(32);
  for (const [method, path, body] of [["GET", "/api/agents/portfolio/proposals", undefined], ["GET", `/api/agents/portfolio/proposals/${id}`, undefined],
    ["POST", `/api/agents/portfolio/proposals/${id}/execute`, {}], ["POST", `/api/agents/portfolio/proposals/${id}/approve`, signedVerdict(mine(), "approve")],
    ["POST", `/api/agents/portfolio/proposals/${id}/reject`, signedVerdict(mine(), "reject")]] as const) {
    fake.calls.length = 0;
    assert.deepEqual(await json(await call(method, path, { cookie, ...(body && { body }) })), { status: 409, body: { ok: false, kind: "refused", code: "not_connected" } }, path);
    assert.equal(fake.calls.filter(line => line.startsWith("proposals.")).length, 1, `${path}: one call, never retried`);
  }
  assert.equal(relayed("execute"), 0, "nothing was sent to execute");
  assert.deepEqual((await json(await call("GET", "/api/agents/portfolio/consent", { cookie }))).body.value, { consent: null }, "the page shows Connect");
});

test("the health check answers without a session or an Origin, and says nothing but that the server is up", async () => {
  assert.deepEqual(await json(await call("GET", "/api/health")), { status: 200, body: { ok: true, value: { status: "up" } } });
});

// --- the DAO requests route (#130) ---

test("the DAO requests route lists this agent's open requests, soonest deadline first, to any member who can read, with what the page needs", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const council_ = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie: council_, body: {} });
  await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie: council_, body: {} });
  for (const member of [council, proposer, reader]) {
    const { status, body } = await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie: await signIn(member) }));
    assert.equal(status, 200, member.accountId);
    const { requests } = contract.daoAgentRequests.parse(body.value);
    // The vote's deadline is its proposal's (an hour); the consent's is a week: the vote is first.
    assert.deepEqual(requests.map(request => [request.kind, request.proposal]), [["vote", "1".repeat(32)], ["consent", undefined]], member.accountId);
    assert.ok(requests[0]!.votingUntil < requests[1]!.votingUntil, "soonest first");
    assert.equal(requests[0]!.verdict, "approve");
    assert.equal(requests[1]!.verdict, undefined, "a consent has no verdict");
    for (const request of requests) {
      assert.equal(request.check, `https://platform.test/confirm/dao/${request.id}`);
      assert.ok(request.description.length > 0 && request.offer !== null);
    }
  }
});

test("the DAO requests route lists only this agent's: another agent's request, and a setup, are not", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  const mine = daoRequests.consent(DAO_ORG, "dao-treasury")!;
  await daoRequests.add({ ...mine, agent: "elsewhere", id: "e".repeat(64) } as never);
  await daoRequests.add({ ...mine, organization: "someone--else", id: "d".repeat(64) } as never);
  assert.equal(daoRequests.open().length, 3);
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie }));
  assert.deepEqual(contract.daoAgentRequests.parse(body.value).requests.map(request => request.id), [mine.id]);
});

test("the DAO requests route settles nothing: a vote that passed stays listed until the server's own pass or a proposal's read relays it", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  await call("POST", `/api/agents/dao-treasury/proposals/${"1".repeat(32)}/approve`, { cookie, body: {} });
  fake.daoVotes[0]!.passed = true;
  fake.calls.length = 0;
  audited.length = 0;
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie }));
  assert.equal(contract.daoAgentRequests.parse(body.value).requests.length, 1, "still listed");
  assert.ok(daoRequests.vote(DAO_ORG, "dao-treasury", "1".repeat(32)), "still open");
  assert.deepEqual(audited, [], "nothing relayed, so nothing recorded");
  assert.ok(!fake.calls.some(made => made.startsWith("dao") && !made.startsWith("daoRequest")), `no DAO call to the platform: ${fake.calls.join(", ")}`);
});

test("a request whose DAO proposal ended is closed by the read and not listed, as a proposal's read does", async t => {
  await freshDao(t);
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  const id = fake.daoRequests[0]!.id;
  fileOnChain(id, "Rejected");
  const { body } = await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie }));
  assert.deepEqual(contract.daoAgentRequests.parse(body.value), { requests: [] });
  assert.equal(daoRequests.consent(DAO_ORG, "dao-treasury"), undefined, "closed");
});

test("the DAO requests route answers a wallet owner's agent with an empty list, and another account with not_owner", async t => {
  await freshDao(t);
  const mine = await json(await call("GET", "/api/agents/portfolio/dao-requests", { cookie: await signIn(owner) }));
  assert.deepEqual(mine, { status: 200, body: { ok: true, value: { requests: [] } } });
  const cookie = await signIn(council);
  await call("POST", "/api/agents/dao-treasury/consent/text", { cookie, body: {} });
  assert.deepEqual(await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie: await signIn(intruder) })),
    { status: 403, body: { ok: false, kind: "not_owner" } }, "not a member of the DAO");
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/dao-requests", { cookie: await signIn(intruder) })),
    { status: 403, body: { ok: false, kind: "not_owner" } }, "nor the owner of the wallet's agent");
  assert.deepEqual(await json(await call("GET", "/api/agents/dao-treasury/dao-requests")), { status: 401, body: { ok: false, kind: "not_signed_in" } });
});

// --- the activity downloads and the owner's actions (#136) ---

test("the CSV route relays the ledger once and answers it as a download, never as a page", async () => {
  const cookie = await signIn(owner);
  fake.reads.ledgerCsv = "correlationId,at,kind,status\nc1,2026-11-06T10:00:00Z,swap,success\n";
  fake.calls.length = 0;
  const response = await call("GET", "/api/agents/portfolio/activity.csv", { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="portfolio-activity.csv"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "correlationId,at,kind,status\nc1,2026-11-06T10:00:00Z,swap,success\n", "as the platform wrote it");
  assert.equal(fake.calls.filter(made => made.startsWith("reads.ledgerCsv")).length, 1, "relayed once");
});

test("a CSV whose read fails answers unavailable, or not connected, as JSON and not as a file", async t => {
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  fake.readAnswers.ledgerCsv = [{ ok: false, kind: "unavailable" } as never];
  const failed = await call("GET", "/api/agents/portfolio/activity.csv", { cookie });
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get("content-type")!, /^application\/json/);
  assert.deepEqual(await failed.json(), { ok: false, kind: "unavailable" });
  fake.readAnswers.ledgerCsv = [{ ok: false, kind: "forbidden", status: 403, error: "No live owner consent covers this Organization and agent" } as never];
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/activity.csv", { cookie })), { status: 409, body: { ok: false, kind: "refused", code: "not_connected" } });
  fake.readAnswers.ledgerCsv = [new Error("socket hang up")];
  assert.equal((await call("GET", "/api/agents/portfolio/activity.csv", { cookie })).status, 503, "a call that throws is unavailable too");
});

test("the owner-actions route relays owner/actions once, as the platform answers it, and maps a failure to unavailable", async t => {
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  const action = { correlationId: "g1", type: "grant_issue", expiresAt: "2026-11-06T13:00:00.000Z", signer: "wallet", stage: "submitted", ownerSucceeded: false, status: null, failureCode: null, payment: null };
  fake.reads.ownerActions = [action] as never;
  fake.calls.length = 0;
  const { status, body } = await json(await call("GET", "/api/agents/portfolio/owner/actions", { cookie }));
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(contract.ownerActionsRead.parse(body.value).map(item => [item.correlationId, item.type, item.stage]), [["g1", "grant_issue", "submitted"]]);
  assert.equal(fake.calls.filter(made => made.startsWith("reads.ownerActions")).length, 1, "relayed once");
  fake.reads.ownerActions = [];
  fake.readAnswers.ownerActions = [{ ok: false, kind: "unavailable" } as never];
  assert.deepEqual(await json(await call("GET", "/api/agents/portfolio/owner/actions", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } });
});

test("another account gets not_owner from the CSV and the owner-actions routes, and no session gets not_signed_in", async () => {
  for (const path of ["/api/agents/portfolio/activity.csv", "/api/agents/portfolio/owner/actions"]) {
    fake.calls.length = 0;
    assert.deepEqual(await json(await call("GET", path, { cookie: await signIn(intruder) })), { status: 403, body: { ok: false, kind: "not_owner" } }, path);
    assert.ok(!fake.calls.some(made => made.startsWith("reads.")), `${path}: nothing read for a stranger`);
    assert.deepEqual(await json(await call("GET", path)), { status: 401, body: { ok: false, kind: "not_signed_in" } }, path);
  }
});

test("DAO request approvals come only from its matching chain proposal and survive the browser contract", async t => {
  await freshDao(t);
  daoProposal("1".repeat(32));
  const cookie = await signIn(council);
  const path = `/api/agents/dao-treasury/proposals/${"1".repeat(32)}`;
  const filed = await json(await call("POST", `${path}/approve`, { cookie, body: {} }));
  assert.equal(contract.daoFiled.parse(filed.body.value).request.approvedBy, undefined, "no votes before filing");
  fileOnChain("0".repeat(64));
  chainProposals[DAO]![0]!.votes = { "unrelated.near": "Approve" };
  fileOnChain(fake.daoVotes[0]!.id);
  const matched = chainProposals[DAO]![1]!;
  matched.votes = { "z.near": "Approve", "reject.near": "Reject", "a.near": "Approve", "remove.near": "Remove" };
  const read = await json(await call("GET", path, { cookie }));
  assert.deepEqual(contract.proposalRead.parse(read.body.value).vote!.approvedBy, ["a.near", "z.near"]);
  const listed = await json(await call("GET", "/api/agents/dao-treasury/dao-requests", { cookie }));
  assert.deepEqual(contract.daoAgentRequests.parse(listed.body.value).requests[0]!.approvedBy, ["a.near", "z.near"]);
  matched.votes = {};
  assert.deepEqual(contract.proposalRead.parse((await json(await call("GET", path, { cookie }))).body.value).vote!.approvedBy, []);
  const writes = fake.calls.filter(call => /prepare|submit|execute/.test(call));
  assert.deepEqual(writes, [], "displaying approvals prepares, signs and executes nothing");
});
