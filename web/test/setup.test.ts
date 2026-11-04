import { test } from "node:test";
import assert from "node:assert/strict";
import type { OwnerActionRecord } from "../src/platform.ts";
import { ACCESS_WAIT_GUARD, waitForWorkspace, workspaceState } from "../src/features/setup/workspace-wait.ts";
import { creationSigner, nextSetupStep, setupBlock, setupRecordNote } from "../src/features/setup/setup-state.ts";

const NAME = "own-0123456789abcdef01234567";
const access = { canSign: true, canPropose: false, canVote: false, canExecute: false, canManage: true };
const signedIn = (account: string, agents: string[] = []) => ({ viewer: { account, access: Object.fromEntries(agents.map(a => [a, access])) } });

test("the access guard's message is the one the platform's treasury-migration spec looks for in the bundle", () => {
  assert.equal(ACCESS_WAIT_GUARD, "Another account signed in before the new workspace opened.");
});

test("the new workspace opens only for the account that reserved it, once that account has access", () => {
  assert.equal(workspaceState(signedIn("owner.near"), "owner.near", NAME), "waiting");
  assert.equal(workspaceState(signedIn("owner.near", [NAME]), "owner.near", NAME), "open");
  assert.equal(workspaceState(signedIn("other.near", [NAME]), "owner.near", NAME), "switched");
  assert.equal(workspaceState({ viewer: null }, "owner.near", NAME), "signed-out");
});

/** A clock that advances only when the wait sleeps. */
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
};

test("the wait reads discovery until access arrives, and a failed read decides nothing", async () => {
  const answers = [signedIn("owner.near"), new Error("The gateway answered 502."), signedIn("owner.near", [NAME])];
  let reads = 0;
  const me = async () => { const next = answers[reads++]; if (next instanceof Error) throw next; return next!; };
  const end = await waitForWorkspace({ me, account: "owner.near", name: NAME, signal: new AbortController().signal, ...clock() });
  assert.deepEqual(end, { state: "open" });
  assert.equal(reads, 3);
});

test("the wait stops when another account or nobody is signed in, and times out with the last failure", async () => {
  const run = (me: () => Promise<{ viewer: ReturnType<typeof signedIn>["viewer"] | null }>) =>
    waitForWorkspace({ me, account: "owner.near", name: NAME, signal: new AbortController().signal, timeoutMs: 3_000, intervalMs: 1_000, ...clock() });
  assert.deepEqual(await run(async () => signedIn("other.near")), { state: "switched" });
  assert.deepEqual(await run(async () => ({ viewer: null })), { state: "signed-out" });
  let reads = 0;
  assert.deepEqual(await run(async () => { reads++; return signedIn("owner.near"); }), { state: "timeout" });
  assert.equal(reads, 4, "read at 0, 1, 2 and 3 seconds, then stopped");
  assert.deepEqual(await run(async () => { throw new Error("offline"); }), { state: "timeout", lastError: "offline" });
});

test("an aborted wait reads nothing more", async () => {
  const controller = new AbortController();
  let reads = 0;
  const me = async () => { reads++; controller.abort(); return signedIn("owner.near"); };
  await assert.rejects(waitForWorkspace({ me, account: "owner.near", name: NAME, signal: controller.signal, ...clock() }));
  assert.equal(reads, 1);
});

const record = (type: string, stage: string, extra: Partial<OwnerActionRecord> = {}) =>
  ({ type, stage, signer: "wallet", correlationId: `${type}-${stage}`, expiresAt: "2026-11-05T00:00:00Z", ownerSucceeded: false, ...extra }) as unknown as OwnerActionRecord;

test("creation is offered only once the records are read and no earlier creation is unfinished or succeeded", () => {
  assert.equal(setupBlock(undefined, true).blocked, true, "unread records block");
  assert.equal(setupBlock([], true).blocked, false);
  assert.equal(setupBlock([record("agent_create", "expired")], true).blocked, false);
  assert.equal(setupBlock([record("agent_create", "prepared")], true).blocked, true);
  assert.equal(setupBlock([record("agent_create", "submitted")], true).blocked, true);
  const succeeded = setupBlock([record("agent_create", "done", { ownerSucceeded: true })], true);
  assert.equal(succeeded.blocked, true, "a succeeded creation is observed, never replaced");
  assert.equal(succeeded.awaitingSetup, true);
  // Creation looks only at creations; the next step looks at every setup action.
  assert.equal(setupBlock([record("grant_issue", "submitted")], true).blocked, false);
  assert.equal(setupBlock([record("grant_issue", "submitted")], false).blocked, true);
  assert.equal(setupBlock([record("agent_freeze", "submitted")], false).records.length, 0);
});

test("a recorded setup action says what it means for the next step", () => {
  assert.match(setupRecordNote({ stage: "submitted", ownerSucceeded: false, status: null } as never), /do not sign again/);
  assert.match(setupRecordNote({ stage: "done", ownerSucceeded: true, status: "SUCCESS" } as never), /Check setup status/);
});

test("the next step reviews the policy until it is reported in force, then the strategy", () => {
  assert.equal(nextSetupStep({ executor: true }, undefined).to, "/policy");
  assert.match(nextSetupStep({ executor: true }, undefined).policy, /unavailable/);
  assert.equal(nextSetupStep({ executor: true }, { notInForce: "Not yet applied" }).to, "/policy");
  const ready = nextSetupStep({ executor: true }, { notInForce: null });
  assert.equal(ready.to, "/automations");
  assert.equal(ready.link, "Review and authorize the Portfolio strategy");
  assert.match(nextSetupStep({ executor: false }, { notInForce: null }).grant, /approve-only/);
});

test("an agent not created yet is created by its DAO when the host lists a DAO owner", () => {
  const linked = { dao: { id: "team.sputnik-dao.near", owner: { type: "near" as const, account_id: "x", public_key: "k" }, funded: false } };
  assert.equal(creationSigner(true, { dao: null }), "dao");
  assert.equal(creationSigner(false, linked), "wallet");
  assert.equal(creationSigner(undefined, linked), "dao");
  assert.equal(creationSigner(undefined, { dao: null }), "wallet");
});
