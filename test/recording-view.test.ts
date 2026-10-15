import assert from "node:assert/strict";
import { test } from "node:test";
import { tickLog } from "../src/agui.js";
import type { Tick } from "../src/evidence.js";
import { inspectRecording, observationLabel, recordingProgress, recordingSummary } from "../web/src/features/evidence/recording-model.js";
import type { ProgressRecord } from "../src/run-progress-schema.js";

const at = "2026-01-01T00:00:00.000Z";
const tick: Tick = {
  id: "tick-1", agentId: "agent-a", at, trigger: "schedule",
  schedule: { on: true, everyMin: 60, maxUsd: 10, lastRun: null },
  build: { deployment: null, source: "fixture", lockfile: null, packageJson: null },
  policy: { revision: 1, digest: "fixture", status: "APPLIED" }, strategy: "fixture", grant: null,
  end: { endedAt: at, before: { error: "unavailable" }, after: { error: "unavailable" },
    plan: null, steps: [{ index: 0, correlationId: "op-1", status: "SENT", failureCode: null }],
    shields: [], rejected: [], refusal: null, outcome: "awaiting outcome" },
};
const recording = () => tickLog(tick, { agentId: tick.agentId, records: [], gaps: [] }, {
  exportedAt: at, display: { asOf: at, assets: [] },
});

test("recording inspection validates version, identity and size before display", () => {
  const value = recording();
  assert.deepEqual(inspectRecording(value, "agent-a", "tick-1"), value);
  assert.throws(() => inspectRecording(value, "other-agent", "tick-1"), /match/);
  assert.throws(() => inspectRecording(value, "agent-a", "other-tick"), /match/);
  assert.throws(() => inspectRecording({ ...value, schemaVersion: 4 }, "agent-a", "tick-1"));
  assert.throws(() => inspectRecording({ ...value, oversized: "x".repeat(2_000_001) }, "agent-a", "tick-1"), /large/);
});

test("recorded end never implies settlement, including later successful observations", () => {
  const value = recording();
  value.laterObservations.push({ correlationId: "op-1", source: "journal", record: {
    line: 1, recordedAt: at, idempotencyKey: "key-1", type: "status", status: "SUCCESS",
  } });
  assert.equal(recordingSummary(value), "Run end recorded. Operation outcomes are shown separately.");
  const send = value.events.find((e) => e.type === "CUSTOM" && e.value.stage === "send")!;
  assert.equal(observationLabel(send), "Swap 1 · SENT");
  assert.equal(send.metadata.timing, "unknown");
  assert.equal(send.timestamp, undefined);
});

test("a missing run end stays unknown, not failed or completed", () => {
  const value = tickLog({ ...tick, end: null }, { agentId: tick.agentId, records: [], gaps: [] }, {
    exportedAt: at, display: { asOf: at, assets: [] },
  });
  assert.equal(recordingSummary(value), "No run end recorded. The outcome is unknown.");
  assert.deepEqual(value.events.map(observationLabel), ["Run started"]);
});

test("stage rows pair recorded returns while overlapping stages and submissions remain independent", () => {
  const progress: ProgressRecord[] = [
    { type: "STEP_STARTED", stepName: "balances-before" },
    { type: "STEP_STARTED", stepName: "planning" },
    { type: "CUSTOM", name: "treasury.observation", value: { stage: "submission", method: "swap", correlationId: "accepted-op" } },
    { type: "STEP_FINISHED", stepName: "balances-before" },
  ].map((event, i) => ({ version: 1, agentId: tick.agentId, tickId: tick.id, sequence: i + 1,
    at: new Date(Date.parse(at) + (i + 1) * 1000).toISOString(), event: event as ProgressRecord["event"] }));
  const value = tickLog({ ...tick, progressVersion: 1, end: null }, { agentId: tick.agentId, records: [], gaps: [] }, {
    exportedAt: "2026-01-01T00:00:10.000Z", display: { asOf: at, assets: [] }, progress,
    progressGaps: [{ code: "progress_unavailable" }],
  });
  const original = structuredClone(value);
  const view = recordingProgress(value);
  assert.equal(view.items.length, 3, "one row per stage, plus the independent submission");
  const [balances, planning, submission] = view.items;
  assert.ok(balances && planning && submission);
  assert.equal(balances.kind, "stage");
  if (balances.kind === "stage") {
    assert.equal(balances.stepName, "balances-before");
    assert.equal(balances.started.timestamp, Date.parse(at) + 1000);
    assert.equal(balances.returned?.timestamp, Date.parse(at) + 4000);
  }
  assert.equal(planning.kind, "stage");
  if (planning.kind === "stage") assert.equal(planning.returned, undefined, "an interrupted stage has no inferred return");
  assert.equal(submission.kind, "submission");
  if (submission.kind === "submission") {
    assert.equal(submission.correlationId, "accepted-op");
    assert.equal(submission.method, "swap");
    assert.equal("stepName" in submission, false, "no inferred association with an overlapping stage");
  }
  assert.equal(view.latest?.type, "STEP_FINISHED", "latest observation follows event order, not grouped row order");
  assert.deepEqual(value, original, "presentation must retain gaps, timestamps and original events unchanged");
});

test("run end and later success never fabricate missing stage returns or legacy progress", () => {
  const legacy = recording();
  legacy.laterObservations.push({ correlationId: "op-1", source: "journal", record: {
    line: 1, recordedAt: at, idempotencyKey: "key-1", type: "status", status: "SUCCESS",
  } });
  assert.deepEqual(recordingProgress(legacy), { items: [], latest: undefined });
  const value = tickLog({ ...tick, progressVersion: 1 }, { agentId: tick.agentId, records: [], gaps: [] }, {
    exportedAt: at, display: { asOf: at, assets: [] }, progress: [{
      version: 1, agentId: tick.agentId, tickId: tick.id, sequence: 1, at,
      event: { type: "STEP_STARTED", stepName: "execution" },
    }],
  });
  const row = recordingProgress(value).items[0]!;
  assert.equal(row.kind, "stage");
  if (row.kind === "stage") assert.equal(row.returned, undefined);
  assert.equal(recordingSummary(value), "Run end recorded with incomplete stage observations. Operation outcomes are shown separately.");
  assert.equal(observationLabel(value.events.at(-1)!), "Run end · incomplete stage observations");
});

test("a recorded execution failure stays distinct from later successful operation observations", () => {
  const value = tickLog({ ...tick, end: { ...tick.end!, outcome: "Failed: status unavailable" } }, {
    agentId: tick.agentId, records: [], gaps: [],
  }, { exportedAt: at, display: { asOf: at, assets: [] } });
  value.laterObservations.push({ correlationId: "op-1", source: "journal", record: {
    line: 1, recordedAt: at, idempotencyKey: "key-1", type: "status", status: "SUCCESS",
  } });
  assert.equal(recordingSummary(value), "Run failure recorded. Operation outcomes are shown separately.");
  assert.equal(observationLabel(value.events.at(-1)!), "Run failure recorded");
  assert.deepEqual(recordingProgress(value), { items: [], latest: undefined });
});
