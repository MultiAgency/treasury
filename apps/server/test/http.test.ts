import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { parseConsentMessage, proposalList, proposalText, type ProposalView } from "@multiagency/sdk";
import type { AuditEntry } from "../src/audit.ts";
import type { ProposalAnswer } from "../src/platform.ts";
import * as contract from "../src/contract.ts";
import type { IncomingMessage } from "node:http";
import { clientAddress, COOKIE, createServer, routes } from "../src/http.ts";
import { standInKeyLookup, type KeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, proposal, wallet } from "./fakes.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", "elsewhere-agent": "owner.near", transferred: "owner.near", unborn: "owner.near", recreated: "owner.near", theirs: "intruder.near" }, {
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
/** The chain's answer about the owners' keys, replaceable per test. */
const keys: { lookup: KeyLookup } = { lookup: async () => "full" };
/** Makes the audit trail fail at one stage, as a full disk would. */
const auditFails: { stage?: AuditEntry["stage"] } = {};
let server: Server, base: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup({ "owner.near": [owner.publicKey], "intruder.near": [intruder.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000, now: () => clock.now }),
    publicOrigin: ORIGIN,
    deployment: "treasury",
    trustedProxyHops: 0,
    ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { if (entry.stage === auditFails.stage) throw new Error("disk full"); audited.push(entry); } },
    consentsPerDay: 1_000,
    keyLookup: async (account, key) => keys.lookup(account, key),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  const route = { method: "GET" as const, path: "/api/test-fresh/:agent", access: "owner-fresh" as const, handle: async () => ({ status: 200, body: { ok: true as const, value: {} } }) };
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
  assert.deepEqual(contract.agent.parse(body.value), { agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test", signer: "wallet", member: null });
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
  const limited = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 2, keyLookup: standInKeyLookup({ "owner.near": [owner.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 1, ownerRequestsPerMinute: 1_000, audit: { append: async () => {} }, consentsPerDay: 1_000, keyLookup: async () => "full",
  }));
  await new Promise<void>(resolve => limited.listen(0, "127.0.0.1", resolve));
  t.after(() => limited.close());
  const at = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
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
  const limited = createHttpServer(createServer({
    platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup({ "intruder.near": [intruder.publicKey], "owner.near": [owner.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute, audit: { append: async () => {} }, consentsPerDay: 1_000, keyLookup: async () => "full",
  }));
  await new Promise<void>(resolve => limited.listen(0, "127.0.0.1", resolve));
  t.after(() => limited.close());
  const at = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  const session = async (who: ReturnType<typeof wallet>) => {
    const { body: issued } = await json(await fetch(`${at}/api/session/challenge`, { method: "POST", headers: write }));
    return (await fetch(`${at}/api/session`, { method: "POST", headers: write, body: JSON.stringify(who.sign(issued.value)) })).headers.get("set-cookie")!.split(";")[0]!;
  };
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
  assert.deepEqual(parseConsentMessage(text.message)?.scopes, ["read", "treasury"]);
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
    [[{ ok: false, kind: "refused", status: 429, error: "Request limit reached" }], 503, { ok: false, kind: "unavailable" },
      { ok: false, kind: "refused", status: 429 }],
    [[{ ok: false, kind: "forbidden", status: 403, error: "This host has no such agent owned by the signer" }], 403, { ok: false, kind: "not_owner" },
      { ok: false, kind: "forbidden", status: 403, code: "not_owner" }],
  ];
  for (const [queued, status, body, recorded] of answers) {
    clean();
    const fresh = (await signedConsent(cookie)).submission;
    fake.consentAnswers.push(...queued);
    assert.deepEqual(await json(await call("POST", "/api/agents/portfolio/consent", { cookie, body: fresh })), { status, body });
    assert.deepEqual(results().map(entry => entry.stage === "result" && entry.answer), [recorded], "recorded with the platform's status and the browser's code");
    assert.ok(!JSON.stringify(body).match(/identity|verify|signer|limit/), "no platform text reaches the browser");
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

test("new consents are limited per account a day, since even revoked ones count against the deployment's cap", async t => {
  const counted = fakePlatform({ portfolio: "owner.near" });
  const limited = createHttpServer(createServer({
    platform: counted.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup({ "owner.near": [owner.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000, audit: { append: async () => {} }, consentsPerDay: 1, keyLookup: async () => "full",
  }));
  await new Promise<void>(resolve => limited.listen(0, "127.0.0.1", resolve));
  t.after(() => limited.close());
  const at = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  const { body: issued } = await json(await fetch(`${at}/api/session/challenge`, { method: "POST", headers: write }));
  const cookie = (await fetch(`${at}/api/session`, { method: "POST", headers: write, body: JSON.stringify(owner.sign(issued.value)) })).headers.get("set-cookie")!.split(";")[0]!;
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

test("a refused execute (a price below the signed floor) leaves the proposal approved: nothing was claimed, and it may be executed later", async t => {
  t.mock.method(console, "error", () => {});
  cleanProposals();
  fake.proposals.push(mine({ state: "approved" }));
  const cookie = await signIn(owner);
  const execute = () => call("POST", `/api/agents/portfolio/proposals/${"a".repeat(32)}/execute`, { cookie, body: {} });
  fake.proposalAnswers.execute = [{ ok: false, kind: "refused", status: 409, code: "not_executable", error: "A quote is below the signed floor (setPrice)" }];
  const refusedRun = await json(await execute());
  assert.deepEqual([refusedRun.status, refusedRun.body.value.result, refusedRun.body.value.proposal.state], [200, "not_executable", "approved"]);
  assert.ok(!JSON.stringify(refusedRun.body).includes("floor"), "the platform's text stays on the server");
  assert.deepEqual(audited.at(-1), { who: "owner.near", action: "execute", agent: "portfolio", subject: "a".repeat(32), stage: "result",
    answer: { ok: false, kind: "refused", status: 409 } }, "recorded as refused");
  const read = await json(await call("GET", `/api/agents/portfolio/proposals/${"a".repeat(32)}`, { cookie }));
  assert.equal(read.body.value.proposal.state, "approved", "a later read still says approved");
  assert.equal(relayed("execute"), 1);
  const later = await json(await execute());
  assert.deepEqual([later.body.value.result, later.body.value.proposal.state], ["final", "executed"], "asked again later, it runs");
  assert.equal(relayed("execute"), 2, "one execute per click, never a retry by the server");
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
    ["POST", `/api/agents/portfolio/proposals/${id}/execute`, {}], ["POST", `/api/agents/portfolio/proposals/${id}/approve`, signedVerdict(mine(), "approve")]] as const) {
    fake.calls.length = 0;
    assert.deepEqual(await json(await call(method, path, { cookie, ...(body && { body }) })), { status: 409, body: { ok: false, kind: "refused", code: "not_connected" } }, path);
    assert.equal(fake.calls.filter(line => line.startsWith("proposals.")).length, 1, `${path}: one call, never retried`);
  }
  assert.equal(relayed("execute"), 0, "nothing was sent to execute");
  assert.deepEqual((await json(await call("GET", "/api/agents/portfolio/consent", { cookie }))).body.value, { consent: null }, "the page shows Connect");
});
