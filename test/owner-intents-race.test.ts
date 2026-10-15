import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/owner-intents-race.ts", import.meta.url));

test("two processes preparing owner intents for one instance both keep theirs", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-intents-race-"));
  const options = { timeout: 10_000, cwd: dir, env: { ...process.env, ENV_FILE: "", AGENT_ID: "a".repeat(64) } };
  // The server loaded the intents before the command line prepared one, and prepares its own after.
  const server = spawn(TSX, [FIXTURE, "from-server", join(dir, "go")], options);
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((loaded) => server.stdout.on("data", (chunk) => String(chunk).includes("loaded") && loaded()));
  const cli = spawnSync(TSX, [FIXTURE, "from-cli"], { ...options, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  writeFileSync(join(dir, "go"), "");
  assert.equal(await new Promise((exited) => server.on("exit", exited)), 0, stderr);
  const kept = JSON.parse(readFileSync(join(dir, ".owner-intents", ".env.json"), "utf8"));
  assert.deepEqual(Object.keys(kept).sort(), ["from-cli", "from-server"]);
});

const PROCESS = fileURLToPath(new URL("./fixtures/owner-store-process.ts", import.meta.url));
const optionsFor = (dir: string) => ({ cwd: dir, env: { ...process.env, ENV_FILE: "", AGENT_ID: "a".repeat(64) }, timeout: 15_000 });
const run = (dir: string, mode: string, id = "shared") => spawnSync(TSX, [PROCESS, mode, id], { ...optionsFor(dir), encoding: "utf8" });
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, ".owner-intents", ".env.json"), "utf8"));
const signatures = (dir: string) => readFileSync(join(dir, "signatures.jsonl"), "utf8").trim().split("\n");
const clearDeadLock = (dir: string) => rmSync(join(dir, ".owner-intents", ".env.json.lock"), { recursive: true, force: true });

test("two processes submitting one owner intent send its signature once and retain settlement", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-submit-race-"));
  assert.equal(run(dir, "prepare").status, 0);
  const results = await Promise.all([1, 2].map(() => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(TSX, [PROCESS, "submit"], optionsFor(dir));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(signatures(dir).length, 1);
  assert.equal(saved(dir).shared.stage, "settled");
});

test("a process dying after signature submission retains attempted state for poll-only recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-submit-crash-"));
  assert.equal(run(dir, "prepare").status, 0);
  assert.equal(run(dir, "prepare", "other").status, 0);
  const crashed = run(dir, "submit-crash");
  assert.equal(crashed.status, 71, crashed.stderr);
  assert.equal(saved(dir).shared.stage, "submitted");
  clearDeadLock(dir); // only the dead child's fixture lock; production waits for stale takeover
  const polled = run(dir, "poll");
  assert.equal(polled.status, 0, polled.stderr);
  assert.equal(saved(dir).shared.stage, "settled");
  assert.equal(saved(dir).other.stage, "prepared");
  assert.equal(signatures(dir).length, 1);
});

test("a process dying after preparing an owner intent cannot lose it on the next writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-prepare-crash-"));
  const crashed = run(dir, "prepare-crash");
  assert.equal(crashed.status, 71, crashed.stderr);
  clearDeadLock(dir);
  const next = run(dir, "prepare", "other");
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(Object.keys(saved(dir)).sort(), ["other", "shared"]);
});

test("a stale process cannot resurrect an owner intent another process settled", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-stale-settlement-"));
  assert.equal(run(dir, "prepare").status, 0);
  const server = spawn(TSX, [FIXTURE, "other", join(dir, "go")], optionsFor(dir));
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("loaded")) resolve(); });
    server.on("error", reject);
    server.on("exit", () => reject(new Error(`Server exited before readiness: ${stderr}`)));
  });
  const completed = run(dir, "submit");
  assert.equal(completed.status, 0, completed.stderr);
  const exited = new Promise((resolve) => server.on("exit", resolve));
  writeFileSync(join(dir, "go"), "");
  assert.equal(await exited, 0, stderr);
  assert.equal(saved(dir).shared.stage, "settled");
  assert.equal(saved(dir).other.stage, "prepared");
  assert.equal(signatures(dir).length, 1);
});
