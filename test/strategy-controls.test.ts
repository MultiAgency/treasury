import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { opsLog } from "../src/ops.js";
import { grantRequest } from "../src/grants.js";
import { api } from "../src/api.js";
import { treasuryPolicy } from "../src/policy.js";
import { DEFAULT_STRATEGY, strategyDigest } from "../src/strategy-digest.js";
import { loadStrategy, saveStrategy, STRATEGY_FILE } from "../src/strategy.js";
import { fixtureGrant, policyView } from "./fixtures/authority.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freshDirectory, offline, TSX } from "./fixtures/harness.js";
import { mayCall } from "../src/gateway/allowlist.js";

freshDirectory("strategy-controls");
beforeEach(() => {
  mock.restoreAll(); offline(); delete process.env.EXECUTOR;
  process.env.AGENT_GRANT_TOKEN = "fixture-strategy-token";
  process.env.AUTOPILOT = "on";
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy));
  mock.method(api, "listGrants", async () => [fixtureGrant()]);
});
const digest = strategyDigest(DEFAULT_STRATEGY);
const changed = { ...DEFAULT_STRATEGY, minLegUsd: 3 };
const controls = () => import("../src/strategy-controls.js");

test("saving a strategy turns the schedule off and refuses stale replacement", async () => {
  const c = await controls();
  await c.saveReviewedStrategy(changed, digest);
  assert.deepEqual(loadStrategy(), changed);
  assert.notEqual(process.env.AUTOPILOT, "on");
  assert.match(readFileSync(".env", "utf8"), /AUTOPILOT=\s*$/);
  await assert.rejects(c.saveReviewedStrategy(DEFAULT_STRATEGY, digest), /changed/);
  assert.deepEqual(loadStrategy(), changed);
});

test("failed replacement leaves schedule durably off", async () => {
  const c = await controls();
  mkdirSync(`${STRATEGY_FILE}.tmp`, { recursive: true });
  await assert.rejects(c.saveReviewedStrategy(changed, digest));
  assert.deepEqual(loadStrategy(), DEFAULT_STRATEGY);
  const env = { ...process.env }; delete env.AUTOPILOT;
  const restarted = spawnSync(process.execPath, ["--env-file=.env", "-e", "if(process.env.AUTOPILOT === 'on') process.exit(1)"], { env });
  assert.equal(restarted.status, 0);
  assert.notEqual(process.env.AUTOPILOT, "on");
  assert.match(readFileSync(".env", "utf8"), /AUTOPILOT=\s*$/);
});

test("only an unchanged authorized strategy enables; unavailable and expired grants refuse", async () => {
  const c = await controls();
  await c.stopSchedule();
  await c.enableSchedule(digest);
  assert.equal(process.env.AUTOPILOT, "on");
  await c.stopSchedule();
  await assert.rejects(c.enableSchedule("stale"), /changed/);
  mock.method(api, "listGrants", async () => [{ ...fixtureGrant(), expires_at: "2000-01-01T00:00:00Z" }]);
  await assert.rejects(c.enableSchedule(digest), /authorization|grant/i);
  mock.method(api, "getPolicy", async () => { throw new Error("unavailable"); });
  await assert.rejects(c.enableSchedule(digest), /unavailable/);
  assert.notEqual(process.env.AUTOPILOT, "on");
});

test("strategy changed during asynchronous preflight cannot enable", async () => {
  const c = await controls();
  await c.stopSchedule();
  mock.method(api, "listGrants", async () => { saveStrategy(changed); return [fixtureGrant()]; });
  await assert.rejects(c.enableSchedule(digest), /changed/);
  assert.notEqual(process.env.AUTOPILOT, "on");
});

test("concurrent save after enable finishes off; stale competing save refuses", async () => {
  const c = await controls();
  await c.stopSchedule();
  const results = await Promise.allSettled([c.enableSchedule(digest), c.saveReviewedStrategy(changed, digest)]);
  assert.ok(results.some(r => r.status === "fulfilled"));
  assert.deepEqual(loadStrategy(), changed);
  assert.notEqual(process.env.AUTOPILOT, "on");
  await assert.rejects(c.saveReviewedStrategy(DEFAULT_STRATEGY, digest), /changed/);
});

test("legacy requests cannot enable without a review or change and enable together", async () => {
  const c = await controls();
  await c.stopSchedule();
  await assert.rejects(c.setLegacySchedule({ on: true, everyMin: 60, maxUsd: 0 }), /review|digest/i);
  await assert.rejects(c.setLegacySchedule({ on: true, everyMin: 120, maxUsd: 0, expectedDigest: digest }), /save|separately/i);
  await c.setLegacySchedule({ on: false, everyMin: 120, maxUsd: 0, expectedDigest: digest });
  assert.equal(loadStrategy().autopilot.everyMin, 120);
  assert.notEqual(process.env.AUTOPILOT, "on");
});

test("strategy controls require their specific capabilities and approve-only hosts refuse direct controls", async () => {
  const c = await controls();
  const reader = { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false };
  for (const route of ["strategy/save", "autopilot/enable", "autopilot/stop"]) {
    assert.equal(mayCall(reader, route), false);
    assert.equal(mayCall({ ...reader, canManage: true, canExecute: true }, route), true);
  }
  assert.equal(mayCall({ ...reader, canManage: true }, "strategy/save"), true);
  assert.equal(mayCall({ ...reader, canManage: true }, "autopilot/enable"), false);
  assert.equal(mayCall({ ...reader, canExecute: true }, "strategy/save"), false);
  assert.equal(mayCall({ ...reader, canExecute: true }, "autopilot/enable"), true);
  assert.equal(mayCall({ ...reader, canExecute: true }, "autopilot/set"), false);
  assert.equal(mayCall({ ...reader, canManage: true }, "autopilot/set"), false);
  process.env.EXECUTOR = "off";
  await assert.rejects(c.saveReviewedStrategy(changed, digest), /executor/i);
  await assert.rejects(c.enableSchedule(digest), /executor/i);
  await assert.rejects(c.stopSchedule(), /executor/i);
});


test("frozen policy and unresolved operations refuse enable, but never prevent stop", async () => {
  const c = await controls();
  await c.stopSchedule();
  mock.method(api, "getPolicy", async () => policyView({ ...treasuryPolicy, frozen: true }));
  await assert.rejects(c.enableSchedule(digest), /frozen/);
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy));
  writeFileSync(opsLog(), JSON.stringify({ at: new Date().toISOString(), idempotencyKey: "uncertain", kind: "swap", request: {} }) + "\n");
  await assert.rejects(c.enableSchedule(digest), /unresolved/);
  await c.stopSchedule();
});

test("Treasury owner preparation requires the reviewed saved digest and derives its suffix", async () => {
  process.env.AUTOPILOT = "";
  const options = { label: "treasury" as const, requireStrategyReview: true };
  await assert.rejects(grantRequest(options), /review|changed/i);
  await assert.rejects(grantRequest({ ...options, expectedStrategyDigest: "stale" }), /review|changed/i);
  await assert.rejects(grantRequest({ ...options, expectedStrategyDigest: digest, suffix: "wrong" }), /suffix/);
  const result = await grantRequest({ ...options, expectedStrategyDigest: digest });
  assert.equal(result.request.label, fixtureGrant().label);
  saveStrategy(changed);
  await assert.rejects(grantRequest({ ...options, expectedStrategyDigest: digest }), /changed/);
  assert.notEqual(process.env.AUTOPILOT, "on");
  assert.equal((await grantRequest({ label: "payout", requireStrategyReview: true })).request.label, "payout");
  process.env.AUTOPILOT = "on";
  await assert.rejects(grantRequest({ ...options, expectedStrategyDigest: strategyDigest(changed) }), /off/);
});


test("separate processes cannot overwrite the same reviewed strategy", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/strategy-control-child.ts", import.meta.url));
  const run = promisify(execFile);
  const results = await Promise.all([3, 4].map(n => run(TSX, [fixture, String(n)], { cwd: process.cwd(), env: process.env })));
  assert.equal(results.filter(r => r.stdout === "saved").length, 1);
  assert.equal(results.filter(r => /changed/.test(r.stdout)).length, 1);
  assert.ok([3, 4].includes(loadStrategy().minLegUsd));
  assert.match(readFileSync(".env", "utf8"), /AUTOPILOT=\s*$/);
});
