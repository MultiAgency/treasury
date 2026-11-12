import { test } from "node:test";
import assert from "node:assert/strict";
import { stopControls, waitingStop } from "../src/freeze-view.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const soon = new Date(NOW + 10 * 60_000).toISOString(), gone = new Date(NOW - 1000).toISOString();
const action = (type: string, stage: "settled" | "submitted" | "expired" | "prepared", signer: "wallet" | "dao" = "wallet", expiresAt = soon) => ({ correlationId: `${type}-${stage}-${signer}`, type, stage, signer, expiresAt });

test("a stop waits on a submitted action or a DAO's request awaiting its vote", () => {
  const wait = (actions: ReturnType<typeof action>[]) => waitingStop({ actions, now: NOW });
  assert.equal(wait([action("agent_freeze", "submitted")])?.why, "submitted");
  assert.equal(wait([action("agent_unfreeze", "submitted")])?.type, "agent_unfreeze");
  assert.equal(wait([action("agent_freeze", "prepared", "dao")])?.why, "vote");
});

test("nothing is waited on for an action that was only prepared for a wallet, one that finished or lapsed, or one that isn't a stop", () => {
  const wait = (actions: ReturnType<typeof action>[]) => waitingStop({ actions, now: NOW });
  assert.equal(wait([action("agent_freeze", "prepared", "wallet")]), undefined, "never signed: it can be prepared again");
  assert.equal(wait([action("agent_freeze", "settled"), action("agent_unfreeze", "expired")]), undefined);
  assert.equal(wait([action("agent_freeze", "prepared", "dao", gone)]), undefined, "a vote that lapsed");
  assert.equal(wait([action("grant_issue", "submitted"), action("grant_revoke", "prepared", "dao")]), undefined, "a grant is not a stop");
  assert.equal(waitingStop({ actions: [], now: NOW }), undefined);
});

test("a stop's explicit phase holds submitted actions beyond expiry and releases a settled action despite its stage", () => {
  assert.equal(waitingStop({ actions: [{ ...action("agent_freeze", "prepared", "dao", gone), phase: "submitted" }], now: NOW })?.why, "submitted");
  assert.equal(waitingStop({ actions: [{ ...action("agent_unfreeze", "submitted"), phase: "settled" }], now: NOW }), undefined);
});

test("the control offered: Freeze while it runs, Unfreeze while frozen, and a DAO's member proposes", () => {
  const base = { connected: true, ownerScope: true, signer: "wallet" as const, canPropose: true };
  assert.deepEqual(stopControls({ ...base, frozen: false }), { kind: "ready", action: "freeze", label: "Freeze" });
  assert.deepEqual(stopControls({ ...base, frozen: true }), { kind: "ready", action: "unfreeze", label: "Unfreeze" });
  assert.deepEqual(stopControls({ ...base, frozen: undefined }), { kind: "ready", action: "freeze", label: "Freeze" }, "the stop is offered even when the state wasn't read");
  assert.deepEqual(stopControls({ ...base, signer: "dao", ownerScope: false, frozen: false }), { kind: "ready", action: "freeze", label: "Propose to freeze" });
  assert.deepEqual(stopControls({ ...base, signer: "dao", ownerScope: false, frozen: true }), { kind: "ready", action: "unfreeze", label: "Propose to unfreeze" });
});

test("a control that can't work says why: not connected, no owner scope for a wallet owner, a DAO member who can't file", () => {
  assert.deepEqual(stopControls({ connected: false, ownerScope: true, signer: "wallet", canPropose: true, frozen: undefined }), { kind: "not-connected" });
  assert.deepEqual(stopControls({ connected: true, ownerScope: false, signer: "wallet", canPropose: true, frozen: false }), { kind: "needs-owner-scope" });
  assert.deepEqual(stopControls({ connected: true, ownerScope: false, signer: "dao", canPropose: false, frozen: false }), { kind: "needs-member" });
  // A DAO's consent never carries owner, so the lack of it is not the DAO's problem.
  assert.equal(stopControls({ connected: true, ownerScope: false, signer: "dao", canPropose: true, frozen: false }).kind, "ready");
});
