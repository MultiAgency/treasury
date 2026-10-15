import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { beforeEach, mock, test } from "node:test";
import { createRouterClient } from "@orpc/server";
import { router } from "../src/router.js";
import { api } from "../src/api.js";
import { freshDirectory } from "./fixtures/harness.js";
import { parseRecording, serializeRecording } from "../src/agui.js";

freshDirectory("run-log-export");
const client = createRouterClient(router);
const agent = process.env.AGENT_ID!;
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const start = (id: string, minute = 0, agentId = agent) => ({ kind: "start", id, agentId, at: at(minute), trigger: "schedule",
  schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
  build: { deployment: null, source: "fixture", lockfile: null, packageJson: null },
  policy: { revision: 1, digest: "fixture", status: "APPLIED" }, strategy: "fixture", grant: null });
const seen = (minute: number) => ({ at: at(minute), book: [{ asset: "usdc", public: "0", confidential: "10", usd: 10 }],
  weightsBps: {}, targetBps: {}, driftBps: 0, budget: null, unresolved: 0 });
const end = (id: string, minute = 1) => ({ kind: "end", id, endedAt: at(minute), before: seen(minute - 1), after: seen(minute),
  plan: null, steps: [], shields: [], rejected: [], refusal: null, outcome: "book on target" });
const evidence = (rows: unknown[]) => {
  mkdirSync(".evidence", { recursive: true });
  writeFileSync(`.evidence/${agent}.jsonl`, rows.map((r) => typeof r === "string" ? r : JSON.stringify(r)).join("\n"));
};
let tokenReads = 0;
beforeEach(() => {
  tokenReads = 0;
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => assert.fail("unexpected network call"));
  mock.method(api, "getTokens", async () => { tokenReads++; return [{ asset_id: "usdc", symbol: "USDC", decimals: 6 }]; });
});

test("missing evidence and an unknown tick return NOT_FOUND before provider reads, without creating state", async () => {
  await assert.rejects(client.autopilot.log({}), { code: "NOT_FOUND" });
  assert.equal(existsSync(".evidence"), false);
  evidence([start("old"), end("old")]);
  await assert.rejects(client.autopilot.log({ tickId: "absent" }), { code: "NOT_FOUND" });
  assert.equal(tokenReads, 0);
  assert.equal(existsSync(".ops"), false);
});

test("latest and selected older exports are exact, self-contained and do not alter evidence", async () => {
  evidence([start("old"), end("old"), start("new", 2), end("new", 3)]);
  const before = readFileSync(`.evidence/${agent}.jsonl`, "utf8");
  const latest = await client.autopilot.log({});
  assert.equal(latest.tickId, "new");
  const old = await client.autopilot.log({ tickId: "old" });
  assert.equal(old.tickId, "old");
  assert.deepEqual(parseRecording(serializeRecording(old)), old);
  assert.deepEqual(old.display.assets, [{ asset: "usdc", symbol: "USDC", decimals: 6 }]);
  assert.ok(old.gaps.some((g) => g.code === "journal_missing"));
  assert.equal(readFileSync(`.evidence/${agent}.jsonl`, "utf8"), before);
  assert.equal(existsSync(".ops"), false);
});

test("a foreign start record cannot select another agent's tick or leak it", async () => {
  evidence([start("mine"), end("mine"), start("foreign", 2, "other-agent"), end("foreign", 3)]);
  await assert.rejects(client.autopilot.log({ tickId: "foreign" }), { code: "NOT_FOUND" });
  const own = await client.autopilot.log({});
  assert.equal(own.tickId, "mine");
  assert.doesNotMatch(JSON.stringify(own), /other-agent|foreign/);
  assert.ok(own.gaps.some((g) => g.code === "evidence_agent_mismatch"));
});

test("malformed end stays incomplete and token failure is a gap, not failed export", async () => {
  evidence([start("broken"), '{"kind":"end",']);
  mock.method(api, "getTokens", async () => { throw new Error("private provider details"); });
  const recording = await client.autopilot.log({});
  assert.equal(recording.completion, "no-recorded-end");
  assert.equal(recording.events.length, 1);
  assert.ok(recording.gaps.some((g) => g.code === "evidence_malformed_line"));
  assert.doesNotMatch(JSON.stringify(recording), /private provider details/);
});

test("malformed selected tick and duplicate boundaries are refused, not silently replaced", async () => {
  evidence([start("old"), end("old"), start("new", 2), { ...end("new", 3), steps: "invalid" }]);
  await assert.rejects(client.autopilot.log({ tickId: "new" }), { code: "PRECONDITION_FAILED" });
  evidence([start("same"), start("same"), end("same")]);
  await assert.rejects(client.autopilot.log({ tickId: "same" }), { code: "PRECONDITION_FAILED" });
});

test("extra agent/path inputs and oversized evidence are refused", async () => {
  await assert.rejects(client.autopilot.log({ tickId: "a", agentId: "other" } as never), { code: "BAD_REQUEST" });
  evidence([" ".repeat(8_000_001)]);
  await assert.rejects(client.autopilot.log({}), { code: "PRECONDITION_FAILED" });
  assert.equal(tokenReads, 0);
});

test("a completed tick exports raw asset identities when token metadata is unavailable", async () => {
  evidence([start("complete"), end("complete")]);
  mock.method(api, "getTokens", async () => { throw new Error("private provider detail"); });
  const value = await client.autopilot.log({ tickId: "complete" });
  assert.equal(value.completion, "recorded-end");
  assert.deepEqual(value.display.assets, []);
  assert.ok(value.gaps.some((g) => g.code === "asset_display_unavailable"));
  assert.ok(value.gaps.some((g) => g.code === "asset_display_missing" && g.ref === "usdc"));
  assert.doesNotMatch(JSON.stringify(value), /private provider detail/);
});

test("approve-only hosts refuse export rather than presenting their local records as the executor's", async () => {
  const previous = process.env.EXECUTOR;
  process.env.EXECUTOR = "off";
  try {
    await assert.rejects(client.autopilot.log({}), { code: "PRECONDITION_FAILED" });
    assert.equal(tokenReads, 0);
  } finally {
    if (previous === undefined) delete process.env.EXECUTOR;
    else process.env.EXECUTOR = previous;
  }
});

const progress = (id: string, rows: { at: string; event: unknown }[]) => {
  mkdirSync(`.evidence/progress/${agent}`, { recursive: true });
  writeFileSync(`.evidence/progress/${agent}/${id}.jsonl`, rows.map((row, index) =>
    JSON.stringify({ version: 1, agentId: agent, tickId: id, sequence: index + 1, ...row })).join("\n"));
};

test("accepted submission without a final step exports later reconciliation and preserves the failed run", async () => {
  evidence([{ ...start("accepted"), progressVersion: 1 }, { ...end("accepted", 3), outcome: "Failed: status unavailable" }]);
  progress("accepted", [{ at: at(2), event: { type: "CUSTOM", name: "treasury.observation",
    value: { stage: "submission", method: "shield", correlationId: "accepted-op" } } }]);
  mkdirSync(".ops", { recursive: true });
  const journal = [
    { at: at(1), idempotencyKey: "accepted-key", kind: "shield", method: "shield", request: {} },
    { at: at(2), idempotencyKey: "accepted-key", correlation_id: "accepted-op", status: "SENT" },
    { at: at(4), idempotencyKey: "accepted-key", correlation_id: "accepted-op", status: "SUCCESS" },
  ].map(row => JSON.stringify(row)).join("\n");
  writeFileSync(`.ops/${agent}.jsonl`, journal);
  const recording = await client.autopilot.log({});
  assert.deepEqual(recording.laterObservations.map(row => row.record.status), ["SUCCESS"]);
  const finish = recording.events.at(-1)!;
  assert.ok(finish.type === "RUN_ERROR");
  assert.equal(finish.code, "tick_failed");
  assert.equal(finish.metadata.tickResult.outcome, "Failed: status unavailable");
  assert.equal(recording.events.some(row => row.type === "CUSTOM" && row.value.stage === "shield"), false);
  assert.equal(readFileSync(`.ops/${agent}.jsonl`, "utf8"), journal);
});

test("progress beyond export time leaves a readable prefix and an explicit clock gap", async () => {
  evidence([{ ...start("clock"), progressVersion: 1 }]);
  progress("clock", [
    { at: at(1), event: { type: "STEP_STARTED", stepName: "planning" } },
    { at: "2099-01-01T00:00:00.000Z", event: { type: "STEP_FINISHED", stepName: "planning" } },
  ]);
  const recording = await client.autopilot.log({});
  assert.equal(recording.completion, "no-recorded-end");
  assert.deepEqual(recording.events.map(row => row.type), ["RUN_STARTED", "STEP_STARTED"]);
  assert.ok(recording.gaps.some(row => row.code === "clock_inconsistent"));
  assert.deepEqual(parseRecording(serializeRecording(recording)), recording);
});

test("clock quarantine preserves a recorded end and never associates a discarded submission", async () => {
  const future = "2099-01-01T00:00:00.000Z";
  evidence([{ ...start("clock-ended"), progressVersion: 1 }, { ...end("clock-ended", 3), endedAt: future }]);
  progress("clock-ended", [
    { at: at(1), event: { type: "STEP_STARTED", stepName: "sweep" } },
    { at: future, event: { type: "CUSTOM", name: "treasury.observation",
      value: { stage: "submission", method: "shield", correlationId: "discarded-op" } } },
  ]);
  const recording = await client.autopilot.log({});
  assert.equal(recording.completion, "recorded-end");
  const terminal = recording.events.at(-1)!;
  assert.ok(terminal.type === "RUN_ERROR");
  assert.equal(terminal.code, "progress_incomplete");
  assert.ok(recording.gaps.some(row => row.code === "clock_inconsistent"));
  assert.doesNotMatch(JSON.stringify(recording), /discarded-op/);
  const imported = structuredClone(recording);
  const stage = imported.events.find(row => row.type === "STEP_STARTED")!;
  stage.timestamp = Date.parse(future);
  stage.metadata.recordedAt = future;
  assert.throws(() => parseRecording(JSON.stringify(imported)), /Invalid progress timing/);
});

test("repeated exports reuse display metadata but reread the operation journal", async () => {
  evidence([start("cached"), { ...end("cached", 3), shields: [{ asset: "usdc", correlationId: "cached-op", status: "SENT" }] }]);
  mkdirSync(".ops", { recursive: true });
  const rows = [
    { at: at(1), idempotencyKey: "cached-key", kind: "shield", method: "shield", request: {} },
    { at: at(2), idempotencyKey: "cached-key", correlation_id: "cached-op", status: "SENT" },
  ];
  writeFileSync(`.ops/${agent}.jsonl`, rows.map(row => JSON.stringify(row)).join("\n"));
  const first = await client.autopilot.log({});
  writeFileSync(`.ops/${agent}.jsonl`, [...rows, { at: at(4), idempotencyKey: "cached-key", correlation_id: "cached-op", status: "SUCCESS" }].map(row => JSON.stringify(row)).join("\n"));
  const second = await client.autopilot.log({});
  assert.equal(tokenReads, 1);
  assert.equal(first.laterObservations.length, 0);
  assert.equal(second.laterObservations[0]?.record.status, "SUCCESS");
  assert.equal(first.display.asOf, second.display.asOf);
});

test("concurrent recording reads share one display metadata request", async () => {
  evidence([start("concurrent"), end("concurrent")]);
  await Promise.all([client.autopilot.log({}), client.autopilot.log({})]);
  assert.equal(tokenReads, 1);
});

test("expired display metadata is refreshed; failed reads are not cached or replaced with stale data", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 1, 1) });
  evidence([start("expiry"), end("expiry")]);
  const first = await client.autopilot.log({});
  t.mock.timers.tick(5 * 60_000);
  mock.method(api, "getTokens", async () => { tokenReads++; throw new Error("offline"); });
  const failed = await client.autopilot.log({});
  assert.equal(tokenReads, 2);
  assert.deepEqual(failed.display.assets, []);
  assert.ok(failed.gaps.some(g => g.code === "asset_display_unavailable"));
  mock.method(api, "getTokens", async () => { tokenReads++; return [{ asset_id: "usdc", symbol: "NEW", decimals: 6 }]; });
  const recovered = await client.autopilot.log({});
  assert.equal(tokenReads, 3);
  assert.equal(recovered.display.assets[0]?.symbol, "NEW");
  assert.notEqual(recovered.display.asOf, first.display.asOf);
});

test("growing evidence exports latest and old ticks without hiding distant duplicates", async () => {
  const rows = Array.from({ length: 10_100 }, (_, i) => [start(`history-${i}`, i * 2), end(`history-${i}`, i * 2 + 1)]).flat();
  evidence(rows);
  assert.ok(readFileSync(`.evidence/${agent}.jsonl`).length > 8_000_000);
  assert.equal((await client.autopilot.log({})).tickId, "history-10099");
  assert.equal((await client.autopilot.log({ tickId: "history-0" })).tickId, "history-0");
  evidence([...rows, start("history-0")]);
  await assert.rejects(client.autopilot.log({ tickId: "history-0" }), { code: "PRECONDITION_FAILED" });
});

test("chunk boundaries preserve UTF-8 and malformed-line evidence", async () => {
  // Put the first byte of a multibyte ID at the end of a 64 KiB read.
  const prefix = '{"padding":"' + 'x'.repeat(65_536 - 1 - '{"padding":"'.length - '","id":"'.length) + '","id":"';
  const row = start("é-tick");
  const { id: _id, ...fields } = row;
  const rest = JSON.stringify(fields).slice(1);
  evidence([prefix + 'é-tick",' + rest, '{broken']);
  const recording = await client.autopilot.log({});
  assert.equal(recording.tickId, "é-tick");
  assert.ok(recording.gaps.some(g => g.code === "evidence_malformed_line" && g.line === 2));
});
