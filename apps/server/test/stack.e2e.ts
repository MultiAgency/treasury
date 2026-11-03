// The server against the platform's stack (platform at PLATFORM_COMMIT, `--treasury --app`): a real gateway, the
// stack's own Treasury agent `portfolio` and its operator-issued `tap_` credential. Sign-in uses the stack's
// `signOwner` control, as the owner's wallet would. The stack doesn't publish its chain RPC, so the key check uses a
// stand-in built from the stack's own owner account and key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { signOwner, startStack, type Stack } from "../../../scripts/stack.ts";
import { createCredential } from "../src/credential.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createPlatform } from "../src/platform.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { HOST, ORIGIN, wallet } from "./fakes.ts";

/** A fetch that trusts only the running stack's own certificate. */
const stackFetch = (ca: Buffer): typeof fetch => async (input, init) => new Promise((resolve, reject) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const req = request(url, { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers)), ca, signal: init?.signal ?? undefined }, res => {
    const chunks: Buffer[] = [];
    res.on("data", chunk => chunks.push(chunk));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as Record<string, string> })));
  });
  req.on("error", reject);
  req.end(init?.body as string | undefined);
});

const intruder = wallet("intruder.near");
const clock = { now: Date.now() };
let stack: Awaited<ReturnType<typeof startStack>>, target: Stack, owner: string, server: Server, base: string;

before(async () => {
  stack = await startStack({ args: ["--no-browser", "--app", "treasury-test"] });
  target = stack.target;
  const state = stack.state();
  owner = state.ownerAccount;
  assert.ok(state.app, "the stack was started with --app");
  server = createHttpServer(createServer({
    platform: createPlatform({ origin: state.dashboard, credential: createCredential(state.app.credentialFile), timeoutMs: 15_000, fetch: stackFetch(readFileSync(target.ca)) }),
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 100,
      keyLookup: standInKeyLookup({ [owner]: [state.testPublicKey], [intruder.accountId]: [intruder.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000, now: () => clock.now }),
    publicOrigin: ORIGIN,
    deployment: state.app.deployment,
    trustedProxyHops: 0,
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

test("the owner's signature over another recipient, or a reused challenge, doesn't sign in", async () => {
  const issued = await challenge();
  const elsewhere = await signOwner(target, { ...issued, recipient: new URL(stack.state().dashboard).host });
  assert.equal(((await (await post("/api/session", { ...elsewhere, nonce: issued.nonce })).json()) as { code: string }).code, "bad_signature");
  const reused = await signOwner(target, issued);
  assert.equal(((await (await post("/api/session", { ...reused, nonce: issued.nonce })).json()) as { code: string }).code, "unknown_challenge");
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
