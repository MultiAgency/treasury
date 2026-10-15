import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { AgentApiError } from "@near-intents-agent-api/sdk";
import { api } from "../src/api.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { opsLog, readOps } from "../src/ops.js";
import { recover, unresolved } from "../src/recover.js";
import { freshDirectory } from "./fixtures/harness.js";

// Offline: the API's status reads and the grant's sends are replaced per test.
const sent: string[] = [];
freshDirectory("recover");
beforeEach(() => {
  process.env.AGENT_GRANT_TOKEN = "ngt_test";
  sent.length = 0;
});

/** The API's answer to a resend; `null` means the grant must not be used at all. */
function grant(answer: (() => Promise<{ correlation_id: string }>) | null) {
  const method = async (_id: string, _request: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
    if (!answer) assert.fail("this action must not be resent");
    sent.push(idempotencyKey);
    return answer();
  };
  Object.assign(api, { forGrant: () => ({ swap: method, transfer: method, shield: method, unshield: method }) });
}
const statuses = (status: string) => Object.assign(api, { getStatus: async (correlation_id: string) => ({ correlation_id, status }) });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const request = (key: string, at: string) =>
  JSON.stringify({ at, idempotencyKey: key, kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } });
const log = (...lines: string[]) => writeFileSync(opsLog(), `${lines.join("\n")}\n`);
const blocked = () => assert.rejects(acquireMoneyLock(), UnresolvedOperations);
const unblocked = async () => (await acquireMoneyLock()).release();

test("a sent action is resolved by reading its status, never by sending again", async () => {
  log(request("swap:sent", ago(60 * 60_000)), JSON.stringify({ idempotencyKey: "swap:sent", correlation_id: "op_1", status: "UNCERTAIN" }));
  grant(null);
  statuses("SUCCESS");
  const [r] = await recover();
  assert.equal(r?.outcome, "settled");
  assert.equal(readOps()[0]?.status, "SUCCESS");
  await unblocked();
});

test("one still moving stays unresolved, its latest status recorded", async () => {
  log(request("swap:moving", ago(60_000)), JSON.stringify({ idempotencyKey: "swap:moving", correlation_id: "op_2", status: "SENT" }));
  grant(null);
  statuses("PROCESSING");
  const [r] = await recover();
  assert.equal(r?.outcome, "open");
  assert.equal(readOps()[0]?.status, "PROCESSING");
  await blocked();
});

test("an operation without an id stays unknown and is never resent", async () => {
  log(request("swap:lost", ago(60_000)));
  grant(async () => { throw new Error("must not send"); });
  for (let pass = 0; pass < 2; pass++) {
    const [r] = await recover();
    assert.equal(r?.outcome, "unknown");
    assert.match(r!.detail!, /unverified/);
    assert.deepEqual(sent, []);
    assert.equal(readOps()[0]?.refused, undefined);
    await blocked();
  }
});

test("a later potential policy refusal cannot erase original uncertainty", async () => {
  log(request("swap:refused", ago(60_000)));
  grant(async () => {
    throw new AgentApiError(409, { errors: [{ status: "409", code: "policy_denied", title: "Policy denied" }] } as never);
  });
  const [r] = await recover();
  assert.equal(r?.outcome, "unknown");
  assert.deepEqual(sent, []);
  assert.equal(readOps()[0]?.refused, undefined);
  await blocked();
});

test("a failed status read does not prevent another known id from settling", async () => {
  log(request("first", ago(1000)), JSON.stringify({ idempotencyKey: "first", correlation_id: "bad" }),
      request("second", ago(1000)), JSON.stringify({ idempotencyKey: "second", correlation_id: "good" }));
  grant(null);
  Object.assign(api, { getStatus: async (id: string) => {
    if (id === "bad") throw new Error("lost status response");
    return { correlation_id: id, status: "SUCCESS" };
  } });
  assert.deepEqual((await recover()).map((r) => r.outcome), ["unknown", "settled"]);
  assert.deepEqual(sent, []);
  await blocked();
});

for (const status of ["UNCERTAIN", "NEEDS_REVIEW"]) test(status + " stays blocked without replay", async () => {
  log(request("unknown", ago(1000)), JSON.stringify({ idempotencyKey: "unknown", correlation_id: "known" }));
  grant(null); statuses(status);
  assert.equal((await recover())[0]?.outcome, "unknown");
  assert.deepEqual(sent, []);
  await blocked();
});

test("a held payout is polled but is not unresolved: it doesn't block new sends", async () => {
  const held = JSON.stringify({ at: ago(60_000), idempotencyKey: "payout:held", kind: "payout", method: "transfer", request: { asset: "a", amount: "1", recipient: "r" } });
  log(held, JSON.stringify({ idempotencyKey: "payout:held", correlation_id: "op_held", status: "PENDING_APPROVAL" }));
  grant(null);
  statuses("PENDING_APPROVAL");
  assert.deepEqual(unresolved(), []);
  const [r] = await recover();
  assert.equal(r?.outcome, "open");
  await unblocked();
});
