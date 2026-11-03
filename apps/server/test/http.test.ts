import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as contract from "../src/contract.ts";
import type { IncomingMessage } from "node:http";
import { clientAddress, COOKIE, createServer, routes } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", "elsewhere-agent": "owner.near" }, {
  foreign: ["elsewhere-agent"],
  failing: {
    revoked: { ok: false, kind: "session", status: 401, error: "Invalid, expired or revoked app credential" },
    down: { ok: false, kind: "unavailable" },
    "bad-gateway": { ok: false, kind: "unavailable", httpStatus: 502 },
    limited: { ok: false, kind: "refused", status: 429, error: "Request limit reached" },
    conflict: { ok: false, kind: "refused", status: 409, error: "Current wallet ownership could not be verified" },
    hidden: { ok: false, kind: "forbidden", status: 403, error: "Not this deployment's agent" },
  },
});
const clock = { now: Date.now() };
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
  assert.deepEqual(contract.agent.parse(body.value), { agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test" });
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
  for (const agent of ["portfolio", "hidden"]) assert.deepEqual(await json(await call("GET", `/api/agents/${agent}`, { cookie })), missing, agent);
});

test("the platform's failures are never forwarded: a revoked credential, an outage, a rate limit or a conflict is just unavailable", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const cookie = await signIn(owner);
  for (const agent of ["revoked", "down", "bad-gateway", "limited", "conflict"]) {
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
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 1,
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
