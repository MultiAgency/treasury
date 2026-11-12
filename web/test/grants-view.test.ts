import { test } from "node:test";
import assert from "node:assert/strict";
import { revokeControls, splitGrants, waitingRevocation } from "../src/grants-view.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const grant = (id: string, over: Partial<Parameters<typeof splitGrants>[0][number]> = {}) =>
  ({ grant_id: id, label: "treasury", issued_at: "2026-11-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z", revoked_at: null, ...over });

test("a grant is live until it is revoked or expires; the rest are history, newest first", () => {
  const { live, ended } = splitGrants([
    grant("old", { issued_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-20T00:00:00Z" }),
    grant("live"), grant("revoked", { revoked_at: "2026-11-02T00:00:00Z", issued_at: "2026-10-15T00:00:00Z" }),
  ], NOW);
  assert.deepEqual(live.map(item => item.grant_id), ["live"]);
  assert.deepEqual(ended.map(item => item.grant_id), ["revoked", "old"]);
});

test("a revocation waits on its outcome when submitted, or when a DAO's request is waiting for its vote; a freeze doesn't count", () => {
  const live = new Date(NOW + 60_000).toISOString(), lapsed = new Date(NOW - 1000).toISOString();
  const action = (type: string, stage: "submitted" | "prepared" | "settled", signer: "dao" | "wallet", expiresAt = live) => ({ type, stage, signer, expiresAt, correlationId: `${type}-${stage}` });
  const wait = (actions: ReturnType<typeof action>[]) => waitingRevocation({ actions, now: NOW })?.why;
  assert.equal(wait([action("grant_revoke", "submitted", "wallet")]), "submitted");
  assert.equal(wait([action("grant_revoke", "prepared", "dao")]), "vote");
  assert.equal(wait([action("grant_revoke", "prepared", "dao", lapsed)]), undefined, "a vote that lapsed holds nothing");
  assert.equal(wait([action("grant_revoke", "prepared", "wallet")]), undefined, "an unsigned intent can be prepared again");
  assert.equal(wait([action("agent_freeze", "submitted", "wallet")]), undefined);
  assert.equal(wait([action("grant_revoke", "settled", "wallet")]), undefined);
});

test("a wallet owner needs owner actions allowed, a DAO member needs filing roles, and the DAO's member proposes", () => {
  assert.deepEqual(revokeControls({ ownerScope: false, signer: "wallet", canPropose: false }), { kind: "needs-owner-scope" });
  assert.deepEqual(revokeControls({ ownerScope: true, signer: "wallet", canPropose: false }), { kind: "ready", label: "Revoke" });
  assert.deepEqual(revokeControls({ ownerScope: false, signer: "dao", canPropose: false }), { kind: "needs-member" });
  assert.deepEqual(revokeControls({ ownerScope: false, signer: "dao", canPropose: true }), { kind: "ready", label: "Propose to revoke" });
});

test("a revocation's phase takes priority over an older stage for both holding and release", () => {
  const base = { type: "grant_revoke", correlationId: "revoke", signer: "dao" as const, expiresAt: new Date(NOW - 1).toISOString() };
  assert.equal(waitingRevocation({ actions: [{ ...base, stage: "prepared", phase: "submitted" }], now: NOW })?.why, "submitted");
  assert.equal(waitingRevocation({ actions: [{ ...base, stage: "submitted", phase: "settled" }], now: NOW }), undefined);
});
