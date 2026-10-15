import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { claimPlan } from "../src/plans.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { appendSynced, mkdirSynced, writeAtomic } from "../src/synced.js";

/** The append every log here shares (journal, evidence, interventions, inbox): what a crash mid-append can cost. */

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
const parsed = (path: string) => lines(path).flatMap((l) => { try { return [JSON.parse(l) as { id: string }]; } catch { return []; } });

test("after a torn last line the next record starts its own line: only the torn one is lost", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "log.jsonl");
  writeFileSync(path, `${JSON.stringify({ id: "a" })}\n{"id":"b","at":"2026-`); // a crash mid-append
  appendSynced(path, { id: "c" });
  assert.deepEqual(parsed(path).map((l) => l.id), ["a", "c"]);
  assert.equal(lines(path).length, 3);
});

test("an append to a new or intact file adds exactly one line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "log.jsonl");
  appendSynced(path, { id: "a" });
  appendSynced(path, { id: "b" });
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "b" })}\n`);
});

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });

function failDirectorySync() {
  const sync = fs.fsyncSync;
  const observed: string[] = [];
  mock.method(fs, "fsyncSync", (fd: number) => {
    const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
    observed.push(kind);
    if (kind === "directory") throw new Error("directory sync failed");
    sync(fd);
  });
  syncBuiltinESMExports();
  return observed;
}

test("an append cannot report success when the directory entry cannot be synced", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "new.jsonl");
  const observed = failDirectorySync();
  assert.throws(() => appendSynced(path, { id: "a" }), /directory sync failed/);
  assert.deepEqual(observed, ["file", "directory"]);
});

test("an atomic replacement reports directory sync failure even if the rename became visible", () => {
  const path = join(mkdtempSync(join(tmpdir(), "synced-")), "settings");
  writeFileSync(path, "old");
  failDirectorySync();
  assert.throws(() => writeAtomic(path, "new"), /directory sync failed/);
  assert.equal(readFileSync(path, "utf8"), "new", "a thrown write is ambiguous, not proof it was undone");
});

test("a plan cannot proceed when its execution marker cannot be durably recorded", () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "plan-sync-"));
  fs.mkdirSync(join(dir, ".plans"));
  process.chdir(dir);
  try {
    const observed = failDirectorySync();
    assert.throws(() => claimPlan("test-plan"), /directory sync failed/);
    assert.deepEqual(observed, ["file", "directory"]);
    assert.equal(claimPlan("test-plan"), false, "never remove a potentially committed claim to permit retry");
  } finally { process.chdir(cwd); }
});


test("ordinary writes sync only the containing directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "synced-"));
  const expected = fs.statSync(dir).ino;
  const sync = fs.fsyncSync;
  const directories: number[] = [];
  mock.method(fs, "fsyncSync", (fd: number) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) directories.push(stat.ino);
    sync(fd);
  });
  syncBuiltinESMExports();
  appendSynced(join(dir, "log"), { id: "a" });
  writeAtomic(join(dir, "settings"), "new");
  assert.deepEqual(directories, [expected, expected]);
});

test("state-directory setup syncs its parent on creation and reuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "synced-"));
  const sync = fs.fsyncSync;
  const directories: number[] = [];
  mock.method(fs, "fsyncSync", (fd: number) => {
    directories.push(fs.fstatSync(fd).ino);
    sync(fd);
  });
  syncBuiltinESMExports();
  mkdirSynced(join(dir, "state"));
  mkdirSynced(join(dir, "state"));
  assert.deepEqual(directories, [fs.statSync(dir).ino, fs.statSync(dir).ino]);
});

test("state-directory setup requires an established parent and refuses a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "synced-"));
  assert.throws(() => mkdirSynced(join(dir, "missing", "state")), { code: "ENOENT" });
  const file = join(dir, "file");
  writeFileSync(file, "keep");
  assert.throws(() => mkdirSynced(file), { code: "EEXIST" });
  assert.equal(readFileSync(file, "utf8"), "keep");
});

test("failed state-directory sync is retried even when the directory already exists", () => {
  const root = mkdtempSync(join(tmpdir(), "state-sync-"));
  const directory = join(root, ".ops");
  const parentInode = fs.statSync(root).ino;
  const sync = fs.fsyncSync;
  let fail = true;
  let attempts = 0;
  mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).ino === parentInode) {
      attempts++;
      if (fail) throw new Error("state parent sync failed");
    }
    sync(fd);
  });
  syncBuiltinESMExports();
  assert.throws(() => mkdirSynced(directory), /state parent sync failed/);
  assert.ok(fs.statSync(directory).isDirectory());
  assert.throws(() => mkdirSynced(directory), /state parent sync failed/);
  fail = false;
  mkdirSynced(directory);
  appendSynced(join(directory, "journal.jsonl"), { id: "safe" });
  assert.equal(attempts, 3);
});
