import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepRun } from "../../apps/server/src/contract.ts";
import { sweepOutcome } from "../src/sweep-run.ts";

/** A run as the page gets it: plain JSON, parsed by the server's contract. */
const run = (...events: unknown[]) => sweepRun.parse({ events });

const started = { type: "RUN_STARTED", threadId: "sweep-portfolio", runId: "r1", protocolVersion: "1.0" };
const finished = { type: "RUN_FINISHED", threadId: "sweep-portfolio", runId: "r1" };
const exposed = [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, public: "123456789012345678901234567" }];
const snapshot = (shields: { status: string }[]) => ({ type: "ACTIVITY_SNAPSHOT", messageId: "r1-activity", activityType: "treasury.sweep",
  content: { exposed, shields: shields.map((shield, i) => ({ asset: "nep141:wrap.near", correlationId: `s${i}`, failureCode: null, ...shield })) } });

test("a finished preview shows its public balances, exactly, and proves nothing in flight", () => {
  const read = sweepOutcome(run(started, snapshot([]), finished), false);
  assert.deepEqual(read.activity.exposed, exposed);
  assert.deepEqual([read.outcome, read.offerAgain], [{ ok: true }, true]);
});

test("a shield that succeeded is ok; one that failed after another succeeded is partial, and isn't offered again", () => {
  assert.deepEqual(sweepOutcome(run(started, snapshot([]), snapshot([{ status: "SUCCESS" }]), finished), true).outcome, { ok: true });
  const partial = sweepOutcome(run(started, snapshot([{ status: "SUCCESS" }, { status: "FAILED" }]), finished), true);
  assert.deepEqual([partial.outcome.ok === false && partial.outcome.kind, partial.offerAgain], ["partial", false]);
});

test("a truncated run (no terminal event) is unknown and isn't offered again; a truncated preview is only a lost read", () => {
  const lost = sweepOutcome(run(started, snapshot([{ status: "PENDING" }])), true);
  assert.deepEqual([lost.outcome.ok === false && lost.outcome.kind, lost.offerAgain], ["unknown", false]);
  const preview = sweepOutcome(run(started, snapshot([])), false);
  assert.deepEqual([preview.outcome.ok === false && preview.outcome.kind, preview.offerAgain], ["unavailable", true]);
});

test("a RUN_ERROR before any shield is its kind, and may be tried again", () => {
  const refused = sweepOutcome(run(started, snapshot([]), { type: "RUN_ERROR", message: "The platform refused the sweep.", code: "refused" }), true);
  assert.deepEqual([refused.outcome.ok === false && refused.outcome.kind, refused.offerAgain], ["refused", true]);
});
