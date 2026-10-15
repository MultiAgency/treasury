import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ASSETS } from "../src/policy.js";
import { freshDirectory, TSX } from "./fixtures/harness.js";
import type { ProviderReply, ReplayReport } from "./fixtures/invoice-terminal-replay.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/invoice-terminal-replay.ts", import.meta.url));
const request = { asset: ASSETS.USDC, amount: "1000000", recipient: "alice.near", confidential: true };
freshDirectory("invoice-terminal-replay");

function child(mode: "held" | "observe" | "replay", reply: ProviderReply): ReplayReport {
  const result = spawnSync(TSX, [FIXTURE, mode, JSON.stringify(reply)], {
    cwd: process.cwd(), env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, `${mode}: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as ReplayReport;
}

const providerCalls = () => readFileSync(join(process.cwd(), "provider.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

// These deliberately untrusted detail shapes are inputs, not established provider guarantees.
// Current recovery records status only. The invariant here is that none of these outcomes or
// flags authorizes a replacement of this invoice identity; their semantic validation is separate.
const cases: { name: string; terminal: ProviderReply; conflict: ProviderReply }[] = [
  { name: "FAILED without details", terminal: { status: "FAILED" }, conflict: { status: "SUCCESS" } },
  { name: "FAILED with never_executed metadata", terminal: { status: "FAILED", details: { never_executed: true } },
    conflict: { status: "PENDING_APPROVAL", details: { approval_id: "later-approval" } } },
  { name: "FAILED with never_submitted metadata", terminal: { status: "FAILED", details: { never_submitted: true } },
    conflict: { status: "PROCESSING" } },
  { name: "FAILED with partial-effect metadata", terminal: { status: "FAILED", details: { tx_hash: "fixture-partial", delivered: "400000" } },
    conflict: { status: "SUCCESS", details: { tx_hash: "fixture-later" } } },
  { name: "FAILED with contradictory no-effect and effect metadata", terminal: { status: "FAILED", details: {
    never_executed: true, never_submitted: true, tx_hash: "fixture-partial", delivered: "400000",
  } }, conflict: { status: "REFUNDED", details: { refunded_amount: "600000" } } },
  { name: "REFUNDED", terminal: { status: "REFUNDED", details: { refund_tx_hash: "fixture-refund", refunded_amount: "1000000" } },
    conflict: { status: "FAILED", details: { never_executed: true } } },
];

for (const { name, terminal, conflict } of cases) {
  test(`${name}: the original invoice is not replayed after restart or a later conflicting status`, () => {
    const held = child("held", { status: "PENDING_APPROVAL", details: { approval_id: "original-approval" } });
    assert.equal(held.result?.status, "waiting");
    assert.equal(held.invoice.operation.status, "PENDING_APPROVAL");
    assert.equal(held.invoice.reservation, request.amount);
    assert.deepEqual(held.invoice.operation.request, request);
    const key = held.invoice.operation.idempotencyKey;
    const correlationId = held.invoice.operation.correlationId;
    const initialCalls = providerCalls();
    assert.deepEqual(initialCalls, [{ agentId: process.env.AGENT_ID, request, idempotencyKey: key, correlationId }]);

    // The held operation and the terminal observation are written by different processes.
    const observed = child("observe", terminal);
    assert.equal(observed.recoveries?.length, 1);
    assert.equal(observed.recoveries?.[0]?.status, terminal.status);
    assert.equal(observed.invoice.operation.status, terminal.status);
    assert.equal(observed.invoice.operation.submissionState, "RESOLVED");
    assert.deepEqual(providerCalls(), initialCalls);

    // This process has no memory of either earlier call. Both filing paths and the lowest
    // submission claim/dispatch boundaries must retain the original payment.
    const replay = child("replay", conflict);
    assert.equal(new Set([held.pid, observed.pid, replay.pid]).size, 3);
    assert.deepEqual(replay.filings?.original, { id: held.invoice.id, status: "failed" });
    assert.deepEqual(replay.filings?.revised, { id: held.invoice.id, status: "needs_review", revisionConflict: true });
    assert.deepEqual(replay.filings?.repeated, { id: held.invoice.id, status: "failed" });
    assert.equal(replay.conflict?.observed.status, conflict.status);
    assert.deepEqual(replay.conflict?.filing, { id: held.invoice.id, status: "failed" });

    for (const snapshot of [observed, replay]) {
      const saved = snapshot.invoice;
      assert.equal(saved.id, held.invoice.id);
      assert.equal(saved.operation.idempotencyKey, key);
      assert.equal(saved.operation.correlationId, correlationId);
      assert.deepEqual(saved.operation.request, request);
      assert.equal(saved.amount, request.amount);
      assert.equal(saved.note, "October");
      assert.equal(saved.operation.submissionState, "RESOLVED");
      assert.equal(saved.operation.refused, undefined);
      assert.equal(snapshot.operations.length, 1);
      assert.equal(snapshot.operations[0]?.idempotencyKey, key);
      assert.deepEqual(snapshot.counts, { invoices: 1, payments: 1, reservations: 1,
        revisions: snapshot === observed ? 1 : 2, attempt: 1 });
    }
    assert.equal(replay.invoice.review, true);
    assert.deepEqual(replay.invoice.revisions.map(({ amount, note, review }) => ({ amount, note, review })), [
      { amount: request.amount, note: "October", review: 0 },
      { amount: "2000000", note: "Corrected October", review: 1 },
    ]);
    assert.deepEqual(providerCalls(), initialCalls, "no replacement send, even under a different key");
  });
}
