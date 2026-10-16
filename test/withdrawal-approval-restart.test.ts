import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TSX } from "./fixtures/harness.js";

const fixture = fileURLToPath(new URL("./fixtures/submit.ts", import.meta.url));

test("a restarted withdrawal approval stays poll-only even when the API awaits its signature, then reconciles settlement", t => {
  const dir = mkdtempSync(join(tmpdir(), "withdrawal-vote-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentId = "a".repeat(64);
  mkdirSync(join(dir, ".owner-intents")); mkdirSync(join(dir, ".ops"));
  writeFileSync(join(dir, ".env"), "");
  const pending = join(dir, ".owner-intents", ".env.json");
  writeFileSync(pending, JSON.stringify({ grant: {
    type: "approval_vote", stage: "submitted", expiresAt: new Date(Date.now() + 60000).toISOString(),
    releases: "held-withdrawal", signedData: {},
    paymentApproval: { approvalId: "approval", correlationId: "held-withdrawal", verdict: "approve", requestHash: "fixture-hash", key: "withdrawal-key" },
  } }));
  const journal = join(dir, ".ops", `${agentId}.jsonl`);
  writeFileSync(journal, [
    { at: new Date().toISOString(), idempotencyKey: "withdrawal-key", kind: "withdrawal-test", method: "withdraw", journalVersion: 2,
      request: { asset: "usdc", amount: "1", recipient: "recipient.near", chain: "near", confidential: true } },
    { idempotencyKey: "withdrawal-key", submissionState: "SUBMISSION_ATTEMPTED" },
    { idempotencyKey: "withdrawal-key", correlation_id: "held-withdrawal", status: "PENDING_APPROVAL" },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const run = (mode: string) => {
    const result = spawnSync(TSX, [fixture, mode], { cwd: dir, env: { ...process.env, ENV_FILE: "", AGENT_ID: agentId }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const waiting = run("late");
  assert.equal(waiting.sends, 0);
  assert.equal(waiting.result[0].status, "PENDING_SIGNATURE");
  assert.equal(JSON.parse(readFileSync(pending, "utf8")).grant.stage, "submitted");
  const settled = run("recover");
  assert.equal(settled.sends, 0);
  assert.equal(settled.result[0].status, "SUCCESS");
  assert.equal(JSON.parse(readFileSync(pending, "utf8")).grant.stage, "settled");
  assert.match(readFileSync(journal, "utf8"), /"status":"SUCCESS"/);
});
