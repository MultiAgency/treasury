// The portfolio's pure pieces: the plan and run named in a page's address, and a run's recording read as evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSearch, runSearch } from "../src/features/portfolio/plan-search.ts";
import { checkRecording, observationLabel, operationLabel, recordingProgress, recordingSummary } from "../src/features/portfolio/recording.ts";
import type { Recording } from "../src/platform.ts";

test("the address keeps only a plan's identity: a UUID, or nothing", () => {
  const plan = "0b8f6d2e-6a8e-4c43-9d0e-0f2b9a1c7e55";
  assert.deepEqual(planSearch({ plan }), { plan });
  for (const bad of ["", "not-a-plan", `${plan}x`, 42, null, undefined]) assert.deepEqual(planSearch({ plan: bad }), {}, String(bad));
  assert.deepEqual(planSearch({ plan, execute: "true" }), { plan }, "nothing else from the address is kept");
});

test("the Runs page's address names a run by its id, or nothing", () => {
  assert.deepEqual(runSearch({ run: "tick_2026-11-05" }), { run: "tick_2026-11-05" });
  for (const bad of ["", "../x", "a b", 1]) assert.deepEqual(runSearch({ run: bad }), {}, String(bad));
});

const meta = (eventId: string) => ({ eventId, source: "tick", recordRef: "r", recordedAt: null, observedAt: null, timing: "unknown" });
const events = [
  { type: "RUN_STARTED", threadId: "tick:a1:t1", runId: "t1", metadata: meta("e0") },
  { type: "STEP_STARTED", stepName: "planning", timestamp: 1, metadata: meta("e1") },
  { type: "CUSTOM", name: "treasury.observation", value: { stage: "submission", method: "swap", correlationId: "c1" }, timestamp: 2, metadata: meta("e2") },
  { type: "CUSTOM", name: "treasury.observation", value: { stage: "send", index: 0, correlationId: "c1", status: "SUCCESS", failureCode: null, historySource: "journal", history: [], untimedHistory: [] }, metadata: meta("e3") },
  { type: "STEP_FINISHED", stepName: "planning", timestamp: 3, metadata: meta("e4") },
  { type: "STEP_STARTED", stepName: "execution", timestamp: 4, metadata: meta("e5") },
] as unknown as Recording["events"];
const recording = (over: Partial<Recording>) => ({ agentId: "a1", tickId: "t1", completion: "no-recorded-end", events, ...over }) as Recording;

test("a recording for another agent or run is refused, never shown as this run's", () => {
  assert.equal(checkRecording(recording({}), "a1", "t1").tickId, "t1");
  assert.throws(() => checkRecording(recording({}), "a1", "t2"), /does not match/);
  assert.throws(() => checkRecording(recording({ agentId: "a2" }), "a1", "t1"), /does not match/);
});

test("progress lists each stage once with its return, and each submission on its own; nothing is inferred", () => {
  const { items, latest } = recordingProgress(recording({}));
  assert.deepEqual(items.map(item => item.kind === "stage" ? [item.stepName, Boolean(item.returned)] : [item.method, item.correlationId]),
    [["planning", true], ["swap", "c1"], ["execution", false]]);
  assert.equal(latest && observationLabel(latest), "Checking and executing the plan · started");
  assert.equal(observationLabel(events[2]!), "Swap submitted · outcome not yet established");
  assert.equal(observationLabel(events[3]!), "Swap 1 · SUCCESS");
});

test("a run without a recorded end reads as unknown; a later observation is named by its send", () => {
  assert.equal(recordingSummary(recording({})), "No run end recorded. The outcome is unknown.");
  const failed = { type: "RUN_ERROR", message: "x", code: "tick_failed", metadata: { ...meta("e9"), tickResult: { outcome: "Failed: x", refusal: null, rejected: [] } } };
  assert.equal(recordingSummary(recording({ completion: "recorded-end", events: [...events, failed] as never })), "Run failure recorded. Operation outcomes are shown separately.");
  assert.equal(operationLabel(recording({}), "c1"), "Swap 1");
  assert.equal(operationLabel(recording({}), "other"), "Operation");
});
