import { test } from "node:test";
import assert from "node:assert/strict";
import { isStop, stopControls, waitingStop } from "../src/proposals/freeze-view.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const soon = new Date(NOW + 10 * 60_000).toISOString(), gone = new Date(NOW - 1000).toISOString();
const action = (type: string, stage: "settled" | "submitted" | "expired" | "prepared", signer: "wallet" | "dao" = "wallet", expiresAt = soon) => ({ correlationId: `${type}-${stage}-${signer}`, type, stage, signer, expiresAt });

test("only a freeze and an unfreeze are stops", () => {
  assert.deepEqual(["agent_freeze", "agent_unfreeze", "grant_issue", "grant_revoke", "policy_update"].map(isStop), [true, true, false, false, false]);
});

test("a stop waits on a submitted action, a DAO's request awaiting its vote, or the platform's pending one", () => {
  const wait = (actions: ReturnType<typeof action>[], pending: { type: string; state: string; expiresAt: string; correlationId: string }[] = []) => waitingStop({ actions, pending, now: NOW });
  assert.equal(wait([action("agent_freeze", "submitted")])?.why, "submitted");
  assert.equal(wait([action("agent_unfreeze", "submitted")])?.type, "agent_unfreeze");
  assert.equal(wait([action("agent_freeze", "prepared", "dao")])?.why, "vote");
  assert.equal(wait([], [{ correlationId: "p", type: "agent_freeze", state: "waiting", expiresAt: soon }])?.why, "pending");
});

test("nothing is waited on for an action that was only prepared for a wallet, one that finished or lapsed, or one that isn't a stop", () => {
  const wait = (actions: ReturnType<typeof action>[], pending: { type: string; state: string; expiresAt: string; correlationId: string }[] = []) => waitingStop({ actions, pending, now: NOW });
  assert.equal(wait([action("agent_freeze", "prepared", "wallet")]), undefined, "never signed: it can be prepared again");
  assert.equal(wait([action("agent_freeze", "settled"), action("agent_unfreeze", "expired")]), undefined);
  assert.equal(wait([action("agent_freeze", "prepared", "dao", gone)]), undefined, "a vote that lapsed");
  assert.equal(wait([action("grant_issue", "submitted"), action("grant_revoke", "prepared", "dao")]), undefined, "a grant is not a stop");
  assert.equal(wait([], [{ correlationId: "p", type: "agent_freeze", state: "done", expiresAt: soon }, { correlationId: "q", type: "agent_freeze", state: "waiting", expiresAt: gone },
    { correlationId: "r", type: "grant_issue", state: "waiting", expiresAt: soon }]), undefined);
  assert.equal(waitingStop({ actions: [], pending: [], now: NOW }), undefined);
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
