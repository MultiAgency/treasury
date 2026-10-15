import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";
import { progressRecorder, readProgress } from "../src/run-progress.js";
import { acquireExecutorLease } from "../src/executor-lease.js";

freshDirectory("run-progress");
const agent = `progress-test-${process.pid}`, tick = "tick-1";
const path = () => join(".evidence", "progress", agent, `${tick}.jsonl`);
const since = "2000-01-01T00:00:00.000Z";

test("a damaged progress tail preserves only proven stages and never manufactures a finish", () => {
  const writer = progressRecorder(".", agent, tick);
  writer.record({ type: "STEP_STARTED", stepName: "planning" });
  appendFileSync(path(), '{"version":1');
  writer.record({ type: "STEP_FINISHED", stepName: "planning" });
  const read = readProgress(".", agent, tick, since);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0]!.event.type, "STEP_STARTED");
  assert.deepEqual(read.gaps, [{ code: "progress_unavailable" }]);
});

test("progress identity, order, stage pairing and time must be established before display", () => {
  const writer = progressRecorder(".", agent, tick);
  writer.record({ type: "STEP_STARTED", stepName: "planning" });
  const row = JSON.parse(readFileSync(path(), "utf8"));
  for (const replacement of [
    { ...row, agentId: "foreign" }, { ...row, tickId: "other" }, { ...row, sequence: 2 },
    { ...row, at: "1999-01-01T00:00:00.000Z" },
    { ...row, event: { type: "STEP_FINISHED", stepName: "planning" } },
  ]) {
    writeFileSync(path(), JSON.stringify(replacement) + "\n");
    assert.equal(readProgress(".", agent, tick, since).records.length, 0);
  }
  writeFileSync(path(), JSON.stringify(row) + "\n");
  assert.equal(readProgress(".", agent, tick, since, "2001-01-01T00:00:00.000Z").records.length, 0);
  writeFileSync(path(), " ".repeat(1_000_001));
  assert.equal(readProgress(".", agent, tick, since).records.length, 0);
});

test("progress initializes during execution without converting or rewriting existing state", async () => {
  const directories = [".ops", ".invoices", ".owner-intents", ".strategy", ".plans", ".evidence", ".inbox", ".agreements", ".notify"];
  for (const dir of directories) { mkdirSync(dir); writeFileSync(join(dir, "original"), `private state ${dir}`); }
  const release = await acquireExecutorLease(agent);
  try {
    progressRecorder(".", agent, tick).record({ type: "STEP_STARTED", stepName: "planning" });
    const original = readFileSync(path(), "utf8");
    progressRecorder(".", agent, "tick-2").record({ type: "STEP_STARTED", stepName: "planning" });
    assert.equal(readFileSync(path(), "utf8"), original);
    assert.equal(readProgress(".", agent, tick, since).records.length, 1);
    assert.equal(readProgress(".", agent, "tick-2", since).records.length, 1);
  }
  finally { await release(); }
  for (const dir of directories) assert.equal(readFileSync(join(dir, "original"), "utf8"), `private state ${dir}`);
});


test("a process exiting after a recorded stage leaves it unfinished after restart", () => {
  const child = spawnSync(fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
    [fileURLToPath(new URL("./fixtures/progress-child.ts", import.meta.url)), process.cwd(), agent, tick], { encoding: "utf8" });
  assert.equal(child.status, 23, child.stderr);
  const read = readProgress(".", agent, tick, since);
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0]!.event.type, "STEP_STARTED");
  assert.deepEqual(read.gaps, []);
});
