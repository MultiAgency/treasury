import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { acquireMoneyLock } from "../src/lock.js";
import { claimSubmission, opsLog, readOps, record } from "../src/ops.js";
import { ASSETS } from "../src/policy.js";

const home = process.cwd();
beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), "journal-")));
  process.env.AGENT_ID = "a".repeat(64);
});
afterEach(() => process.chdir(home));

test("a send recorded but never claimed is resolved as never submitted when the lock is next taken", async () => {
  // A crash between the write-ahead record and the claim: provably nothing reached the provider.
  record({ at: new Date().toISOString(), idempotencyKey: "payout:crashed", kind: "payout", method: "transfer", journalVersion: 2,
    request: { asset: ASSETS.USDC, amount: "1", recipient: "payee.near", confidential: true } });
  const lock = await acquireMoneyLock();
  await lock.release();
  assert.equal(readOps().find((op) => op.idempotencyKey === "payout:crashed")?.refused, "never_submitted");
});

test("legacy records without a submission claim remain unresolved", async () => {
  record({ at: new Date().toISOString(), idempotencyKey: "legacy", kind: "payout", method: "transfer", request: {} });
  await assert.rejects(acquireMoneyLock(), /no proven outcome/);
  assert.equal(readOps()[0]?.refused, undefined);
});

test("a claimed v2 operation stays unresolved even if no provider response was recorded", async () => {
  const lock = await acquireMoneyLock();
  try {
    record({ at: new Date().toISOString(), idempotencyKey: "claimed", kind: "payout", method: "transfer", journalVersion: 2, request: {} });
    claimSubmission("claimed", {});
    assert.throws(() => claimSubmission("claimed", {}), /replay is blocked/);
  } finally { await lock.release(); }
  await assert.rejects(acquireMoneyLock(), /no proven outcome/);
  assert.equal(readOps()[0]?.refused, undefined);
});

test("a v2 identity cannot be rewritten and claim terms must match", async () => {
  const lock = await acquireMoneyLock();
  const line = { at: new Date().toISOString(), idempotencyKey: "immutable", kind: "payout", journalVersion: 2 as const, request: { amount: "1" } };
  try {
    record(line);
    assert.throws(() => record({ ...line, request: { amount: "2" } }), /already recorded/);
    assert.throws(() => claimSubmission(line.idempotencyKey, { amount: "2" }), /terms changed/);
  } finally { await lock.release(); }
  const recovered = await acquireMoneyLock();
  await recovered.release();
  assert.equal(readOps()[0]?.refused, "never_submitted");
  assert.throws(() => claimSubmission(line.idempotencyKey, line.request), /replay is blocked/);
});

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/journal-crash.ts", import.meta.url));
for (const boundary of ["after_prepare", "after_claim", "after_acceptance"]) {
  test(`process crash ${boundary} preserves the boundary between unsent and ambiguous`, () => {
    const run = (mode: string) => spawnSync(TSX, [FIXTURE, mode], {
      cwd: process.cwd(), env: { ...process.env, ENV_FILE: "" }, encoding: "utf8", timeout: 15_000,
    });
    const crashed = run(boundary);
    assert.equal(crashed.status, 71, crashed.stderr);
    // Only this dead child's test lock is removed. Actual stale takeover is tested in lock.test.ts.
    rmSync(`${opsLog()}.lock`, { recursive: true, force: true });
    const restarted = run("recover");
    const again = run("recover");
    if (boundary === "after_prepare") {
      assert.equal(restarted.status, 0, restarted.stderr);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(readOps()[0]?.refused, "never_submitted");
    } else {
      assert.notEqual(restarted.status, 0);
      assert.match(restarted.stderr, /no proven outcome/);
      assert.notEqual(again.status, 0);
      assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
      assert.equal(readOps()[0]?.refused, undefined);
    }
    const sends = existsSync("provider.jsonl") ? readFileSync("provider.jsonl", "utf8").trim().split("\n").length : 0;
    assert.equal(sends, boundary === "after_acceptance" ? 1 : 0);
    assert.equal(readOps().length, 1);
  });
}

const preparation = { at: "2026-10-14T00:00:00Z", idempotencyKey: "review", kind: "payout", journalVersion: 2, request: {} };
const claim = { idempotencyKey: "review", submissionState: "SUBMISSION_ATTEMPTED" };
for (const [name, lines] of Object.entries({
  "orphan claim": [claim],
  "orphan outcome": [{ idempotencyKey: "review", refused: "never_submitted" }],
  "duplicate preparation": [preparation, claim, preparation],
  "duplicate claim": [preparation, claim, claim],
  "outcome before claim": [preparation, { idempotencyKey: "review", correlation_id: "op", status: "SUCCESS" }],
  "changed correlation": [preparation, claim, { idempotencyKey: "review", correlation_id: "op", status: "SENT" }, { idempotencyKey: "review", correlation_id: "other", status: "SUCCESS" }],
  "false never-submitted": [preparation, claim, { idempotencyKey: "review", refused: "never_submitted" }],
  "unknown version": [{ ...preparation, journalVersion: 3 }],
  "mixed line": [{ ...preparation, refused: "never_submitted" }],
  "invalid shape": [{}],
  "terminal rewrite": [preparation, claim, { idempotencyKey: "review", correlation_id: "op", status: "SUCCESS" }, { idempotencyKey: "review", correlation_id: "op", status: "FAILED" }],
})) test(`inconsistent journal (${name}) blocks recovery without rewriting evidence`, async () => {
  const raw = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  assert.throws(readOps, /Invalid operation journal/);
  await assert.rejects(acquireMoneyLock(), /Invalid operation journal/);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});

test("legacy status records and repeated observations remain compatible without inferring submission safety", async () => {
  const { journalVersion: _version, ...legacy } = preparation;
  const lines = [legacy, { idempotencyKey: "review", correlation_id: "legacy-op" }];
  writeFileSync(opsLog(), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  await assert.rejects(acquireMoneyLock(), /no proven outcome/);
  record({ idempotencyKey: "review", correlation_id: "legacy-op", status: "SUCCESS" });
  record({ idempotencyKey: "review", correlation_id: "legacy-op", status: "SUCCESS" });
  const lock = await acquireMoneyLock();
  await lock.release();
  assert.equal(readOps()[0]?.status, "SUCCESS");
  assert.equal(readOps()[0]?.submissionState, undefined);
});


test("additional metadata and opaque timestamps do not change submission evidence", async () => {
  const lines = [
    { ...preparation, at: "legacy timestamp", annotation: { source: "older writer" } },
    { ...claim, at: "legacy timestamp", annotation: "extra metadata" },
  ];
  writeFileSync(opsLog(), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(readOps()[0]?.submissionState, "SUBMISSION_ATTEMPTED");
  await assert.rejects(acquireMoneyLock(), /no proven outcome/);
  assert.equal(readOps()[0]?.refused, undefined);
});

const legacyAuthorization = { at: "2026-10-12T00:00:01Z", idempotencyKey: "review",
  authorization: { version: 1, evaluatedAt: "2026-10-12T00:00:01Z", policy: { note: "historical metadata only" } } };
const { journalVersion: _legacyVersion, ...legacyPreparation } = preparation;

test("standalone legacy authorization metadata cannot resolve or replay an operation", async () => {
  const raw = [legacyPreparation, legacyAuthorization].map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  const [op] = readOps();
  assert.equal(op?.submissionState, undefined);
  assert.equal(op?.journalVersion, undefined);
  assert.equal(op?.refused, undefined);
  assert.equal(op?.status, undefined);
  await assert.rejects(acquireMoneyLock(), /no proven outcome/);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});

test("legacy authorization metadata preserves separately recorded settlement", async () => {
  const raw = [legacyPreparation, legacyAuthorization,
    { idempotencyKey: "review", correlation_id: "legacy-op", status: "SUCCESS" },
  ].map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  const lock = await acquireMoneyLock();
  await lock.release();
  assert.equal(readOps()[0]?.status, "SUCCESS");
  assert.equal(readOps()[0]?.submissionState, undefined);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});

for (const [name, lines] of Object.entries({
  orphan: [legacyAuthorization],
  "versioned operation": [preparation, legacyAuthorization],
  "unknown metadata version": [legacyPreparation, { ...legacyAuthorization, authorization: { version: 2 } }],
  "malformed metadata": [legacyPreparation, { ...legacyAuthorization, authorization: null }],
  "mixed refusal": [legacyPreparation, { ...legacyAuthorization, refused: "never_submitted" }],
  "mixed outcome": [legacyPreparation, { ...legacyAuthorization, correlation_id: "legacy-op", status: "SUCCESS" }],
  "mixed claim": [legacyPreparation, { ...legacyAuthorization, submissionState: "SUBMISSION_ATTEMPTED" }],
})) test(`invalid legacy authorization metadata (${name}) keeps recovery blocked`, async () => {
  const raw = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(opsLog(), raw);
  assert.throws(readOps, /Invalid operation journal/);
  await assert.rejects(acquireMoneyLock(), /Invalid operation journal/);
  assert.equal(readFileSync(opsLog(), "utf8"), raw);
});
