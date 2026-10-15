import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { api } from "../src/api.js";
import * as payouts from "../src/payouts.js";
import * as intents from "../src/owner-intents.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("owner-recovery");
const self = process.env.AGENT_ID!;
const entry = (patch = {}) => ({ correlation_id: "payment", agent_id: self, type: "transfer", status: "SUCCESS", created_at: new Date().toISOString(), details: { approval_id: "approval" }, ...patch });

test("receipt history deduplicates repeated pages, excludes foreign records and reports truncation", async () => {
  Object.assign(api, { getHistory: async () => ({ data: [entry(), entry({ agent_id: "foreign", correlation_id: "foreign" })], next_cursor: "same" }), submitIntent: () => assert.fail("read must not submit") });
  const result = await payouts.paymentHistory();
  assert.equal(result.complete, false);
  assert.deepEqual(result.items.map(i => i.correlationId), ["payment"]);
});

test("receipt history distinguishes failed reads from an empty complete history", async () => {
  Object.assign(api, { getHistory: async () => { throw new Error("history unavailable"); } });
  await assert.rejects(payouts.paymentHistory(), /history unavailable/);
  Object.assign(api, { getHistory: async () => ({ data: [], next_cursor: null }) });
  assert.deepEqual(await payouts.paymentHistory(), { items: [], complete: true });
});

test("owner read retains expired attempted submissions, separates owner success and exposes no signing material", () => {
  mkdirSync(".owner-intents", { recursive: true });
  const file = ".owner-intents/.env.json";
  writeFileSync(file, JSON.stringify({ wallet: { type: "approval_vote", stage: "submitted", expiresAt: "2020-01-01T00:00:00Z", grantToken: "SECRET_TOKEN", signedData: { signature: "SECRET_SIGNATURE" }, wallet: { intent: "SECRET_PAYLOAD" }, paymentApproval: { correlationId: "payment", verdict: "approve" } }, rejected: { type: "approval_vote", stage: "settled", ownerSucceeded: true, expiresAt: "2020-01-01T00:00:00Z", result: { status: "FAILED" }, paymentApproval: { correlationId: "other-payment", verdict: "reject" } } }));
  const before = readFileSync(file, "utf8");
  const result = intents.ownerActions();
  assert.equal(result.find(a => a.correlationId === "wallet")?.stage, "submitted");
  assert.equal(result.find(a => a.correlationId === "rejected")?.ownerSucceeded, true);
  assert.equal(result.find(a => a.correlationId === "rejected")?.status, "FAILED");
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(readFileSync(file, "utf8"), before);
});
