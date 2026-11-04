import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalText } from "@multiagency/sdk";
import { checkVerdict, outcomeOf } from "../src/proposals.ts";
import { proposal } from "./fakes.ts";

const now = Date.parse("2026-11-03T12:00:00Z");

test("a verdict is relayed only as the exact text for the proposal as the platform shows it now, while it's open", () => {
  const open = proposal({ expiresAt: new Date(now + 3_600_000).toISOString() });
  for (const verdict of ["approve", "reject"] as const) {
    assert.deepEqual(checkVerdict(proposalText(open, verdict), open, verdict, now), { ok: true }, verdict);
    assert.deepEqual(checkVerdict(proposalText(open, verdict === "approve" ? "reject" : "approve"), open, verdict, now), { ok: false, code: "not_this_text" }, "the other verdict's text");
  }
  const changed = proposal({ expiresAt: open.expiresAt, legs: [{ ...open.legs[0]!, minAmountOut: "1" }] });
  assert.deepEqual(checkVerdict(proposalText(changed, "approve"), open, "approve", now), { ok: false, code: "not_this_text" }, "a text for other terms");
  assert.deepEqual(checkVerdict(proposalText(open, "approve"), { ...open, state: "approved" }, "approve", now), { ok: false, code: "not_open" });
  assert.deepEqual(checkVerdict(proposalText(open, "approve"), { ...open, expiresAt: new Date(now).toISOString() }, "approve", now), { ok: false, code: "expired" });
  assert.deepEqual(checkVerdict(proposalText(open, "approve"), { ...open, state: "expired" }, "approve", now), { ok: false, code: "expired" }, "as the platform shows it once its time passed");
});

test("an execute answer is final only in a state that ends the proposal; anything that may still run is pending", () => {
  for (const state of ["executed", "stopped", "invalidated", "expired", "rejected", "withdrawn"] as const) assert.equal(outcomeOf(state), "final", state);
  for (const state of ["approved", "executing", "unknown", "proposed"] as const) assert.equal(outcomeOf(state), "pending", state);
});

test("an execute result carries its proposal, except a pending one whose read went unanswered", async () => {
  const { executeResult } = await import("../src/contract.ts");
  const view = proposal({ state: "executed" });
  for (const result of ["final", "pending", "not_executable"] as const) assert.equal(executeResult.safeParse({ result, proposal: view }).success, true, result);
  assert.equal(executeResult.safeParse({ result: "pending", proposal: null }).success, true);
  for (const result of ["final", "not_executable"] as const) assert.equal(executeResult.safeParse({ result, proposal: null }).success, false, `${result} with no proposal`);
});
