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
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { signOwner, startStack, type Stack } from "../../../scripts/stack.ts";
import { fileAudit } from "../src/audit.ts";
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
const audit = fileAudit(join(mkdtempSync(join(tmpdir(), "treasury-stack-")), "audit.jsonl"));
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
    ownerRequestsPerMinute: 1_000,
    trustedProxyHops: 0,
    audit,
    consentsPerDay: 1_000,
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
