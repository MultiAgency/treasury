import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near");
const fake = fakePlatform({ portfolio: "owner.near" });
const audit: AuditEntry[] = [];
const DIGEST = `sha256:${"a".repeat(64)}`;
let server: Server, base: string, cookie: string;

before(async () => {
  const started = await testServer({ platform: fake.platform, wallets: [owner], audited: audit });
  ({ server, base } = started);
  cookie = await started.signIn(owner);
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
