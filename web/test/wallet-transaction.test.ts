// What a wallet reports for a transaction it sent, and what it is asked to sign: near-connect 0.14.1's
// `FinalExecutionOutcome` (`build/types/index.d.ts`), whose `status` is `FinalExecutionStatus | "NotStarted" | "Started" | "Failure"`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asSigner, transactionOutcome } from "../src/app/wallet-transaction.ts";

test("only a SuccessValue or SuccessReceiptId status succeeded", () => {
  for (const status of [{ SuccessValue: "" }, { SuccessValue: "MQ==" }, { SuccessReceiptId: "r1" }])
    assert.deepEqual(transactionOutcome({ status }), { kind: "succeeded" }, JSON.stringify(status));
});

test("a Failure status, as a string or an object, failed", () => {
  assert.deepEqual(transactionOutcome({ status: "Failure" }), { kind: "failed", failure: "Failure" });
  const failure = { ActionError: { index: 1, kind: "FunctionCallError" } };
  assert.deepEqual(transactionOutcome({ status: { Failure: failure } }), { kind: "failed", failure });
});

test("anything else is unknown: not started, started, no status, or no outcome at all", () => {
  for (const outcome of [{ status: "NotStarted" }, { status: "Started" }, { status: {} }, {}, undefined, null, "sent"])
    assert.deepEqual(transactionOutcome(outcome), { kind: "unknown" }, JSON.stringify(outcome));
});

test("the connected account signs: a signerId in the prepared transaction never replaces it", () => {
  const transaction = { receiverId: "wrap.near", actions: [], signerId: "attacker.near" };
  assert.deepEqual(asSigner("owner.near", transaction), { receiverId: "wrap.near", actions: [], signerId: "owner.near" });
});
