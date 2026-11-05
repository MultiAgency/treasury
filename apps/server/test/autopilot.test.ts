import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const owner = wallet("owner.near");
const fake = fakePlatform({ portfolio: "owner.near" });
const audit: AuditEntry[] = [];
const DIGEST = `sha256:${"a".repeat(64)}`;
let server: Server, base: string, cookie: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup({ [owner.accountId]: [owner.publicKey] }) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}), daoRequests: await createDaoRequests(join(tempDir("treasury-autopilot-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
  cookie = (await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(owner.sign(issued.value)) }))
    .headers.get("set-cookie")!.split(";")[0]!;
});
after(() => server.close());

const call = async (method: "GET" | "POST", path: string, body: unknown = {}) => {
  const response = await fetch(`${base}/api/agents/portfolio/${path}`, { method, headers: { cookie, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const made = (prefix: string) => fake.calls.filter(entry => entry.startsWith(prefix));
const reset = () => { fake.calls.length = 0; audit.length = 0; fake.schedules.portfolio = { on: false }; };
const consent = (id: string) => ({ id: id.padEnd(64, "0"), deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near",
  agent: "portfolio", agentId: "id-portfolio", scopes: ["read", "treasury"] as ("read" | "treasury")[], expiresAt: Date.now() + 86_400_000, createdAt: 0,
  publicKey: "k", revoked: false, revokedAt: null });

test("the strategy and the schedule are owner reads: the digest, whether the grant binds it, and why the schedule can't start", async () => {
  reset();
  fake.schedules.portfolio = { on: false, unbound: true };
  const strategy = contract.strategyRead.parse((await call("GET", "strategy")).body.value);
  assert.deepEqual([strategy.digest, strategy.grantMatches, strategy.readiness.canEnable], [DIGEST, false, false]);
  assert.deepEqual(contract.autopilotRead.parse((await call("GET", "autopilot")).body.value).on, false);
  assert.deepEqual(made("autopilot."), ["autopilot.strategy owner--near portfolio", "autopilot.status owner--near portfolio"]);
});

test("autopilot is turned on for the digest the owner saw, run now and turned off, each sent once and recorded before and after", async () => {
  reset();
  assert.deepEqual((await call("POST", "autopilot/enable", { expectedDigest: DIGEST })).body, { ok: true, value: {} });
  assert.equal(contract.tickRead.parse((await call("POST", "autopilot/tick")).body.value).summary, "Ran: nothing to rebalance.");
  assert.deepEqual((await call("POST", "autopilot/stop")).body, { ok: true, value: {} });
  assert.deepEqual(made("autopilot."), [`autopilot.enable owner--near portfolio ${DIGEST}`, "autopilot.tick owner--near portfolio", "autopilot.stop owner--near portfolio"]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage]),
    [["autopilot-on", "attempt"], ["autopilot-on", "result"], ["run-now", "attempt"], ["run-now", "result"], ["autopilot-off", "attempt"], ["autopilot-off", "result"]]);
});

test("a malformed digest is refused unasked; the platform's refusal is autopilot_refused without its text; a lost run is unavailable", async () => {
  reset();
  assert.deepEqual((await call("POST", "autopilot/enable", { expectedDigest: "abc" })).body, { ok: false, kind: "refused", code: "bad_request" });
  fake.autopilotAnswers.enable = [{ ok: false, kind: "refused", status: 409, error: "The saved strategy changed: secret detail" }];
  fake.autopilotAnswers.tick = [new Error("socket hang up")];
  const refusedOn = await call("POST", "autopilot/enable", { expectedDigest: DIGEST });
  assert.deepEqual([refusedOn.status, refusedOn.body], [409, { ok: false, kind: "refused", code: "autopilot_refused" }]);
  assert.ok(!refusedOn.text.includes("secret detail"));
  assert.deepEqual((await call("POST", "autopilot/tick")).status, 503);
  assert.deepEqual(audit.filter(entry => entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "refused", status: 409, code: "autopilot_refused" }, { ok: false, kind: "unavailable" }]);
});

test("disconnecting turns autopilot off first, then revokes; a schedule not confirmed off, or unread, revokes nothing", async () => {
  reset();
  fake.consents.length = 0;
  fake.consents.push(consent("a"));
  fake.schedules.portfolio = { on: true };
  fake.autopilotAnswers.stop = [{ ok: false, kind: "refused", status: 409, error: "busy" }];
  assert.deepEqual((await call("POST", "consent/revoke")).body, { ok: false, kind: "refused", code: "autopilot_not_stopped" });
  assert.equal(fake.consents[0]!.revoked, false, "nothing revoked while autopilot may still run");
  fake.autopilotAnswers.status = [new Error("socket hang up")];
  assert.equal((await call("POST", "consent/revoke")).status, 503);
  assert.equal(fake.consents[0]!.revoked, false);
  assert.deepEqual((await call("POST", "consent/revoke")).body, { ok: true, value: { revoked: 1 } });
  assert.deepEqual([fake.schedules.portfolio!.on, fake.consents[0]!.revoked], [false, true]);
  const order = fake.calls.filter(entry => /autopilot\.stop|consents\.revoke/.test(entry));
  assert.ok(order.at(-2)!.startsWith("autopilot.stop") && order.at(-1)!.startsWith("consents.revoke"), JSON.stringify(order));
});

test("disconnecting with autopilot already off asks nothing to stop it", async () => {
  reset();
  fake.consents.length = 0;
  fake.consents.push(consent("b"));
  assert.deepEqual((await call("POST", "consent/revoke")).body, { ok: true, value: { revoked: 1 } });
  assert.deepEqual(made("autopilot.stop"), []);
});
