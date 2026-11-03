import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as contract from "../src/contract.ts";
import { COOKIE, createServer, routes } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near" });
const clock = { now: Date.now() };
let server: Server, base: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup({ "owner.near": [owner.publicKey], "intruder.near": [intruder.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000, now: () => clock.now }),
    publicOrigin: ORIGIN,
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
  for (const route of routes.filter(route => route.access === "owner")) {
    fake.calls.length = 0;
    assert.deepEqual(await json(await call(route.method, pathOf(route), { cookie, ...(route.method !== "GET" && { body: {} }) })), { status: 403, body: { ok: false, kind: "not_owner" } }, `${route.method} ${route.path}`);
    assert.deepEqual(fake.calls, ["identity portfolio"], "nothing but the ownership read reached the platform");
  }
});

test("every write refuses another origin, a missing origin and a body that isn't JSON", async () => {
  for (const route of routes.filter(route => route.method !== "GET")) {
    const label = `${route.method} ${route.path}`;
    assert.equal((await json(await call(route.method, pathOf(route), { headers: { origin: "https://evil.test", "content-type": "application/json" } }))).body.code, "origin", label);
    assert.equal((await json(await call(route.method, pathOf(route), { headers: { "content-type": "application/json" } }))).body.code, "origin", label);
    assert.equal((await json(await call(route.method, pathOf(route), { headers: { origin: ORIGIN, "content-type": "text/plain" } }))).body.code, "content_type", label);
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

test("an agent name that isn't one is refused before the platform is asked; an unknown agent is the platform's refusal", async () => {
  const cookie = await signIn(owner);
  fake.calls.length = 0;
  assert.equal((await json(await call("GET", "/api/agents/Not_An_Agent", { cookie }))).body.code, "bad_request");
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(await json(await call("GET", "/api/agents/missing", { cookie })), { status: 404, body: { ok: false, kind: "refused", code: "platform", error: "No such agent" } });
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
