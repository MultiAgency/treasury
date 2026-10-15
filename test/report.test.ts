import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tick } from "../src/evidence.js";
import type { Row } from "../src/ledger.js";
import { type Intervention, outcomeOf, unattendedReport } from "../src/report.js";

/** The unattended-run report from synthetic evidence: each criterion fails on its own incident, and says no more than it shows. */

const START = Date.parse("2026-10-13T00:00:00Z");
const at = (min: number) => new Date(START + min * 60_000).toISOString();
const seen = (driftBps: number, spent: string, unresolved = 0) =>
  ({ at: "", book: [], weightsBps: {}, targetBps: {}, driftBps, budget: { daily: { spent_usd: spent } }, unresolved });
type End = NonNullable<Tick["end"]>;
const end = (change: Partial<End> = {}): End => ({ endedAt: "", before: seen(100, "0"), after: seen(100, "0"), plan: null, steps: [], shields: [],
  rejected: [], refusal: null, outcome: "book on target", ...change });
const tick = (min: number, change: Partial<Tick> = {}, ended: Partial<End> | null = {}): Tick => ({
  id: `t${min}`, at: at(min), trigger: "schedule", schedule: { on: true, everyMin: 60, maxUsd: 5, lastRun: null },
  build: { deployment: "dep-1", source: "sha256:src", lockfile: "sha256:lock", packageJson: "sha256:pkg" }, agentId: "a",
  policy: { revision: 11, digest: "pol", status: "APPLIED" }, strategy: "sha256:strategy",
  grant: { id: "grant-1", label: "treasury:x", expiresAt: at(60 * 24 * 30) }, end: ended === null ? null : end(ended), ...change,
});
const swap = (id: string, plan = `plan-${id}`): Partial<End> => ({
  plan: { id: plan, usd: 4, legs: [{ from: "a", to: "b", amount: "1", amountOut: "1", minAmountOut: "1", costBps: 10 }] },
  steps: [{ index: 0, status: "SUCCESS", correlationId: id, failureCode: null }], before: seen(400, "0"), after: seen(50, "4"), outcome: "step 1: SUCCESS",
});
const row = (min: number, correlationId: string, amountIn = "1"): Row => ({
  at: at(min), settledAt: at(min), type: "swap", status: "SUCCESS", failureCode: null, confidential: true, assetIn: "a", amountIn,
  assetOut: "b", amountOut: "1", recipient: null, correlationId, intentHash: null, approvalId: null, kind: null, planId: null,
  policyRevision: null, policyDigest: null, usdIn: null,
});
const report = (ticks: Tick[], { ledger = [] as Row[], interventions = [] as Intervention[], unreadable = [] as number[], corrupt = [] as number[], until = at(180) } = {}) =>
  unattendedReport({ since: at(0), until, evidence: { ticks, corrupt }, interventions: { calls: interventions, corrupt: unreadable }, ledger, now: at(181) });
const criterion = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(`- ${name}`)) ?? assert.fail(`no criterion "${name}"`);

test("a clean day: every criterion holds, a no-op counts as scheduled work, and the swap is matched to its tick", () => {
  const text = report([tick(1), tick(61, {}, swap("op_1")), tick(121)], { ledger: [row(61, "op_1")] });
  assert.doesNotMatch(text.split("## Configuration")[0]!, /\*\*no\*\*|cannot be established/);
  assert.match(text, /3 ticks: 1 executed, 2 no-op, 0 refused/);
});

test("records are sorted and both window bounds apply", () => {
  const text = report([tick(121), tick(-30), tick(61), tick(1), tick(200)]);
  assert.match(text, /3 ticks:/);
  assert.match(criterion(text, "Scheduled ticks"), /yes/);
});

test("a gap is judged by the interval each tick recorded, not today's settings", () => {
  const every = (everyMin: number) => ({ schedule: { on: true, everyMin, maxUsd: 5, lastRun: null } });
  assert.match(criterion(report([tick(1, every(120)), tick(121, every(120))], { until: at(200) }), "Scheduled ticks"), /yes/);
  assert.match(criterion(report([tick(1, every(30)), tick(61, every(30))], { until: at(70) }), "Scheduled ticks"), /\*\*no\*\* \(1 gaps\)/);
  // Off means no ticks are expected.
  const off = { schedule: { on: false, everyMin: 60, maxUsd: 5, lastRun: null } };
  assert.match(criterion(report([tick(1, off)], { until: at(300) }), "Scheduled ticks"), /yes/);
});

test("operator, skipped and incomplete ticks don't stand in for scheduled work", () => {
  const text = report([tick(1), tick(61, { trigger: "operator" }), tick(90, {}, { outcome: "Skipped: a tick is already running." }), tick(150)], { until: at(180) });
  assert.match(criterion(text, "Scheduled ticks"), /\*\*no\*\*/);
  assert.match(text, /in between: operator no-op tick at [^,]+, schedule skipped tick at/);
});

test("a start without an end is incomplete: neither success nor failure, and not scheduled work", () => {
  const broken = tick(61, {}, null);
  assert.equal(outcomeOf(broken), "incomplete");
  const text = report([tick(1), broken, tick(121)]);
  assert.match(criterion(text, "Every started tick"), /\*\*no\*\* \(1 incomplete\)/);
  assert.match(criterion(text, "No failed"), /yes/);
  assert.match(criterion(text, "Scheduled ticks"), /\*\*no\*\*/);
});

test("a repeated reference is reported apart from duplicate execution", () => {
  const text = report([tick(1, {}, swap("op_1")), tick(61, {}, swap("op_1", "plan-2")), tick(121)], { ledger: [row(1, "op_1")] });
  assert.match(criterion(text, "No duplicate references"), /\*\*no\*\* \(1\)/);
  assert.match(criterion(text, "No duplicate execution"), /yes/);
});

test("duplicate execution is confirmed only for one plan leg settled twice; same terms elsewhere is suspected", () => {
  const twice = report([tick(1, {}, { ...swap("op_1"), steps: [{ index: 0, status: "SUCCESS", correlationId: "op_1", failureCode: null },
    { index: 0, status: "SUCCESS", correlationId: "op_2", failureCode: null }] }), tick(61), tick(121)], { ledger: [row(1, "op_1"), row(2, "op_2")] });
  assert.match(criterion(twice, "No duplicate execution"), /\*\*no\*\* \(1 confirmed/);
  const lookalike = report([tick(1, {}, swap("op_1")), tick(61), tick(121)], { ledger: [row(1, "op_1"), row(5, "op_x")] });
  assert.match(criterion(lookalike, "No duplicate execution"), /\*\*suspected\*\* \(0 confirmed[^;]*; 1 suspected/);
  const other = report([tick(1, {}, swap("op_1")), tick(61), tick(121)], { ledger: [row(1, "op_1"), row(5, "op_y", "7")] });
  assert.match(criterion(other, "No duplicate execution"), /cannot be established/);
});

test("unresolved operations are an observation; interventions are their own record", () => {
  const unresolved = report([tick(1, {}, { before: seen(100, "0", 1), outcome: "Skipped: unresolved money actions." }), tick(61), tick(121)]);
  assert.match(unresolved, /Unresolved operations were observed at 1 ticks \(an observation, not a recovery record\)/);
  assert.match(criterion(unresolved, "No operator interventions in the gateway's record"), /yes/);
  const recovered = report([tick(1), tick(61), tick(121)], { interventions: [{ at: at(30), account: "ops.near", agent: "treasury", path: "recover" }] });
  assert.match(criterion(recovered, "No operator interventions in the gateway's record"), /\*\*no\*\* \(1 recorded calls/);
  assert.match(recovered, /- [^\n]*ops\.near treasury recover/);
});

test("an unreadable intervention line may have been a call, so the record can't show there were none", () => {
  const text = report([tick(1), tick(61), tick(121)], { unreadable: [3] });
  assert.match(criterion(text, "No operator interventions in the gateway's record"), /\*\*no\*\* \(0 recorded calls, 1 unreadable lines/);
  assert.match(text, /Unreadable intervention lines \(each may have been a call\):\n- line 3/);
});

test("outcomes are told apart: a failed sweep shield fails; a refusal is a working control", () => {
  const shieldFailed = tick(1, {}, { shields: [{ asset: "a", status: "FAILED", correlationId: "op_s" }], outcome: "shielded a: FAILED" });
  assert.equal(outcomeOf(shieldFailed), "failed");
  assert.equal(outcomeOf(tick(1, {}, { refusal: "spend_budget_exceeded", outcome: "Failed: spend_budget_exceeded" })), "refused");
  assert.equal(outcomeOf(tick(1, {}, { rejected: ["the plan expired"] })), "refused");
  assert.equal(outcomeOf(tick(1, {}, { outcome: "Failed: API down" })), "failed");
  assert.equal(outcomeOf(tick(1, {}, { shields: [{ asset: "a", status: "SUCCESS", correlationId: "op_s" }] })), "executed");
  const text = report([shieldFailed, tick(61, {}, { refusal: "spend_budget_exceeded", outcome: "Failed: spend_budget_exceeded" }), tick(121)]);
  assert.match(criterion(text, "No failed"), /\*\*no\*\* \(1 ticks\)/);
  assert.match(text, /Refusals \(the control was invoked[^\n]*\n- [^\n]*spend_budget_exceeded/);
});

test("unreadable evidence lines and configuration changes are reported", () => {
  const text = report([tick(1), tick(61), tick(121, { policy: { revision: 12, digest: "pol2", status: "APPLIED" } })], { corrupt: [7] });
  assert.match(criterion(text, "Evidence file intact"), /\*\*no\*\* \(1 unreadable lines\)/);
  assert.match(text, /## Configuration segments\n1\. [^\n]*policy revision 11[^\n]*\n2\. [^\n]*policy revision 12/);
});

test("reading the evidence is listed as an operator read, not an intervention", () => {
  const text = report([tick(1), tick(61), tick(121)], { interventions: [{ at: at(70), account: "ops.near", agent: "treasury", path: "autopilot/evidence" }] });
  assert.match(criterion(text, "No operator interventions in the gateway's record"), /yes \(0 recorded calls/);
  assert.match(text, /Operator reads \(recorded by the gateway, not interventions\):\n- [^\n]*autopilot\/evidence/);
});

test("a long tick doesn't make the next on-time tick a gap: the scheduler counts the interval from a tick's end", () => {
  // The first tick swaps for 5 minutes; the scheduler runs the next one 60 minutes after it ended.
  const text = report([tick(1, {}, { ...swap("op_1"), endedAt: at(6) }), tick(66), tick(126)], { ledger: [row(1, "op_1")], until: at(180) });
  assert.match(criterion(text, "Scheduled ticks"), /yes/);
});

test("a tick that sent money counts as executed even when a later leg was refused, and the refusal is still listed", () => {
  const partly = tick(61, {}, { ...swap("op_1"), rejected: ["leg 2: swap_cost_exceeded"] });
  assert.equal(outcomeOf(partly), "executed");
  const text = report([tick(1), partly, tick(121)], { ledger: [row(61, "op_1")] });
  assert.match(text, /1 executed/);
  assert.match(text, /Refusals[^\n]*\n- [^\n]*swap_cost_exceeded/);
});

test("a failed shield is a failure even when the rebalance after it was refused", () => {
  const failed = tick(61, {}, { shields: [{ status: "FAILED", correlationId: "op_s", amount: "1", asset: "a" }] as never, refusal: "strategy_changed" });
  assert.equal(outcomeOf(failed), "failed");
  assert.match(criterion(report([tick(1), failed, tick(121)]), "No failed executions"), /\*\*no\*\*/);
});

test("a non-refusal failure after a settled leg is a failure, not an execution", () => {
  const failedAfter = tick(61, {}, { ...swap("op_1"), outcome: "Failed: Outcome unknown for op_x" });
  assert.equal(outcomeOf(failedAfter), "failed");
  assert.match(criterion(report([tick(1), failedAfter, tick(121)], { ledger: [row(61, "op_1")] }), "No failed executions"), /\*\*no\*\*/);
});
