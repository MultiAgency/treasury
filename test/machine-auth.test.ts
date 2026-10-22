import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentAlreadyUsed, MachineCredentials, machineMayCall } from "../src/gateway/machine-auth.js";

const access = { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true };
test("machine credentials survive restart, bind authority, expire and revoke without storing the bearer secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-auth-"));
  try {
    const store = new MachineCredentials(join(dir, "credentials"));
    const issued = store.issue({ account: "owner.near", owner: "owner.near", agent: "treasury", agentId: "a".repeat(64), host: "treasury.test", label: "review assistant", scopes: ["read", "prepare"], ttlSeconds: 60 }, 1_000);
    const file = join(dir, "credentials", `${issued.credential.id}.json`);
    const saved = readFileSync(file, "utf8");
    assert.ok(!saved.includes(issued.token));
    assert.ok(!saved.includes(issued.token.split(".").at(-1)!));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "credentials")).mode & 0o777, 0o700);
    const restarted = new MachineCredentials(join(dir, "credentials"));
    assert.equal(restarted.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001)?.id, issued.credential.id);
    assert.equal(restarted.authenticate(`Bearer ${issued.token}x`, "treasury.test", 1_001), null);
    const altered = issued.token.slice(0, -1) + (issued.token.endsWith("A") ? "B" : "A");
    assert.equal(restarted.authenticate(`Bearer ${altered}`, "treasury.test", 1_001), null);
    assert.equal(restarted.authenticate(`Bearer ${issued.token}`, "TREASURY.TEST", 1_001)?.id, issued.credential.id);
    assert.equal(restarted.revoke(issued.credential.id, "another", "owner.near"), false);
    assert.ok(restarted.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001));
    assert.equal(restarted.authenticate(`Bearer ${issued.token}`, "other.test", 1_001), null);
    assert.equal(restarted.authenticate(`Bearer ${issued.token}`, "treasury.test", 61_000), null);
    restarted.revoke(issued.credential.id, "treasury", "owner.near");
    assert.equal(store.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001), null);
    assert.ok(!("secretHash" in restarted.list("treasury", "owner.near")[0]!));
    // Prior experimental records have no agent binding and must never gain the new permissions.
    const legacy = JSON.parse(saved);
    legacy.version = 1; legacy.scopes = ["execute"]; delete legacy.agentId;
    writeFileSync(file, JSON.stringify(legacy));
    assert.equal(store.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001), null);
    assert.equal(restarted.list("treasury", "owner.near")[0]?.version, 1);
    assert.equal(restarted.revoke(issued.credential.id, "treasury", "owner.near"), true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).revoked, true);
    writeFileSync(file, "{broken");
    assert.throws(() => store.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("machine scopes intersect current permissions and never expose owner signing or unrelated procedures", () => {
  assert.equal(machineMayCall(["read"], access, "overview"), true);
  assert.equal(machineMayCall(["read"], access, "rebalance"), false);
  assert.equal(machineMayCall(["prepare"], access, "rebalance"), true);
  assert.equal(machineMayCall(["prepare"], access, "externalPlan"), true);
  assert.equal(machineMayCall(["read"], access, "externalPlan"), false);
  assert.equal(machineMayCall(["prepare"], { ...access, canSign: false }, "rebalance"), false);
  assert.equal(machineMayCall(["execute-plan"], access, "executePlan"), true);
  assert.equal(machineMayCall(["execute-plan"], access, "sweep"), false);
  assert.equal(machineMayCall(["sweep"], access, "executePlan"), false);
  assert.equal(machineMayCall(["sweep"], access, "sweep"), true);
  assert.equal(machineMayCall(["execute-plan"], { ...access, canExecute: false }, "executePlan"), false);
  assert.equal(machineMayCall(["read", "prepare"], access, "executePlan"), false);
  for (const path of ["owner/prepare", "owner/submit", "strategy/save", "autopilot/enable", "pay", "workOrders/create", "recover", "setup", "unknown"])
    assert.equal(machineMayCall(["read", "prepare", "execute-plan", "sweep"], access, path), false, path);
});

test("a DAO approval backs one credential: reuse is refused, across restarts, and revocation works as for a wallet owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "machine-auth-"));
  try {
    const root = join(dir, "credentials");
    const consent = { dao: "dao.near", proposalId: 7, digest: "c".repeat(64) };
    const base = { account: "member.near", owner: "dao.near", agent: "treasury", agentId: "a".repeat(64), host: "treasury.test", label: "assistant", scopes: ["read" as const], ttlSeconds: 60 };
    const store = new MachineCredentials(root);
    const issued = store.issue({ ...base, consent }, 1_000);
    assert.deepEqual(issued.credential.consent, consent);
    assert.equal(statSync(join(root, "consents")).mode & 0o777, 0o700);
    assert.equal(store.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001)?.consent?.proposalId, 7);
    // The same approval, even from a restarted process, never backs a second credential; another proposal does.
    assert.throws(() => new MachineCredentials(root).issue({ ...base, consent }, 2_000), ConsentAlreadyUsed);
    assert.equal(new MachineCredentials(root).list("treasury", "dao.near").length, 1, "the refused issue left no credential behind");
    new MachineCredentials(root).issue({ ...base, consent: { ...consent, proposalId: 8 } }, 2_000);
    // The same proposal id in another DAO is a different approval.
    new MachineCredentials(root).issue({ ...base, owner: "other.near", consent: { ...consent, dao: "other.near" } }, 2_000);
    // Revoked like any credential, by anyone who manages the treasury; the approval is not freed.
    assert.equal(store.revoke(issued.credential.id, "treasury", "dao.near"), true);
    assert.equal(store.authenticate(`Bearer ${issued.token}`, "treasury.test", 1_001), null);
    assert.throws(() => store.issue({ ...base, consent }, 3_000), ConsentAlreadyUsed);
    // A wallet-owner credential carries no consent and is unaffected.
    assert.equal(store.issue({ ...base, owner: "owner.near", account: "owner.near" }, 3_000).credential.consent, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
