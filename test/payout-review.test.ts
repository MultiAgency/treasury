import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.js";
import { held } from "../src/payouts.js";
import { acquireMoneyLock, UnresolvedOperations } from "../src/lock.js";
import { readOps, record } from "../src/ops.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("payout-review");

test("dashboard held-payout review cannot report empty when remote history is unavailable", async () => {
  Object.assign(api, { getHistory: async () => { throw new Error("history unavailable"); } });
  await assert.rejects(held({ complete: true }), /history unavailable/);
});

for (const status of ["PROCESSING", "QUEUED"]) test(`a released payout observed as ${status} blocks another money action`, async () => {
  record({ at: new Date().toISOString(), idempotencyKey: "payout:held", kind: "payout", method: "transfer", journalVersion: 2,
    request: { asset: "fixture-asset", amount: "1", recipient: "payee.near", confidential: true } });
  record({ idempotencyKey: "payout:held", submissionState: "SUBMISSION_ATTEMPTED" });
  record({ idempotencyKey: "payout:held", correlation_id: "held-operation", status: "PENDING_APPROVAL" });
  Object.assign(api, {
    getStatus: async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID, status }),
    getHistory: async () => ({ data: [], next_cursor: null }),
  });

  assert.deepEqual(await held({ complete: true }), []);
  assert.equal(readOps()[0]?.status, status, "the latest observed state must replace the held-payout exemption");
  await assert.rejects(acquireMoneyLock(), UnresolvedOperations);
});
