import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJournalHistory, readJournalHistory } from "../src/journal-history.js";

const row = { at: "2026-01-01T00:00:00Z", idempotencyKey: "k", correlation_id: "op", status: "SENT" };
test("raw reader preserves line order, duplicates and source gaps without exposing raw payloads", () => {
  const source = [JSON.stringify(row), "", "{truncated", JSON.stringify({ ...row, at: undefined }), JSON.stringify(row)].join("\n");
  const h = parseJournalHistory("agent", source);
  assert.deepEqual(h.records.map((r) => r.line), [1, 4, 5]);
  assert.equal(h.records[1]?.recordedAt, null);
  assert.ok(h.gaps.some((g) => g.code === "malformed_line" && g.line === 3));
  assert.ok(h.gaps.some((g) => g.code === "timestamp_missing" && g.line === 4));
  assert.doesNotMatch(JSON.stringify(h), /truncated/);
});
test("invalid dates and ambiguous line shapes cannot become trusted timestamps or statuses", () => {
  const h = parseJournalHistory("agent", [JSON.stringify({ ...row, at: "yesterday" }), JSON.stringify({ ...row, refused: "denied" })].join("\n"));
  assert.equal(h.records[0]?.recordedAt, null);
  assert.ok(h.gaps.some((g) => g.code === "timestamp_invalid"));
  assert.ok(h.gaps.some((g) => g.code === "malformed_line"));
});
test("file reads never create a missing journal or change a present journal", () => {
  const root = mkdtempSync(join(tmpdir(), "run-log-"));
  try {
    assert.equal(readJournalHistory(root, "agent").gaps[0]?.code, "journal_missing");
    mkdirSync(join(root, ".ops"));
    const file = join(root, ".ops", "agent.jsonl");
    const source = JSON.stringify(row) + "\n";
    writeFileSync(file, source);
    assert.equal(readJournalHistory(root, "agent").records.length, 1);
    assert.equal(readFileSync(file, "utf8"), source);
    assert.throws(() => readJournalHistory(root, "../other"), /agent/i);
    writeFileSync(file, " ".repeat(8_000_001));
    assert.equal(readJournalHistory(root, "agent").gaps[0]?.code, "journal_too_large");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("line limits and unsupported record shapes remain explicit gaps", () => {
  const h = parseJournalHistory("agent", "\n".repeat(20_000) + JSON.stringify(row));
  assert.deepEqual(h.records, []);
  assert.equal(h.gaps[0]?.code, "journal_line_limit");
  assert.equal(parseJournalHistory("agent", JSON.stringify({ idempotencyKey: "k", submissionState: "other" })).gaps[0]?.code, "malformed_line");
});
