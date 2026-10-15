import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TSX } from "./fixtures/harness.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/env.ts", import.meta.url));

/** Runs the fixture in a fresh process in `dir`, with `env` added; returns what it printed. */
function run(dir: string, env: Record<string, string>, agentId: string) {
  const result = spawnSync(TSX, [FIXTURE, agentId], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("another instance starts without the default agent and saves only to its own file", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  writeFileSync(join(dir, ".env"), "AGENT_ID=default\nSHARED=kept\n");
  writeFileSync(join(dir, ".env.payout"), "TREASURY_ACCOUNT=dao.near\n");
  const shared = { AGENT_ID: "default", SHARED: "kept" };
  const seen = run(dir, { ...shared, ENV_FILE: ".env.payout" }, "payout");
  assert.equal(seen, JSON.stringify([null, "dao.near", "kept"]));
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "AGENT_ID=default\nSHARED=kept\n");
  assert.equal(readFileSync(join(dir, ".env.payout"), "utf8"), "TREASURY_ACCOUNT=dao.near\nAGENT_ID=payout\n");
});

test("the default instance keeps everything in .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  writeFileSync(join(dir, ".env"), "SHARED=kept\n");
  run(dir, { ENV_FILE: "" }, "default");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "SHARED=kept\nAGENT_ID=default\n");
});

test("a new settings file holding the grant token is readable only by its owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  run(dir, { ENV_FILE: ".env.new" }, "fresh");
  assert.equal(readFileSync(join(dir, ".env.new"), "utf8"), "AGENT_ID=fresh\n");
  assert.equal(statSync(join(dir, ".env.new")).mode & 0o777, 0o600);
});

test("saving through a symlinked settings file updates its target and keeps the link", () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  writeFileSync(join(dir, "settings"), "SHARED=kept\n");
  symlinkSync("settings", join(dir, ".env.linked"));
  run(dir, { ENV_FILE: ".env.linked" }, "linked");
  assert.ok(lstatSync(join(dir, ".env.linked")).isSymbolicLink());
  assert.equal(readFileSync(join(dir, "settings"), "utf8"), "SHARED=kept\nAGENT_ID=linked\n");
});

for (const [name, setting, expected] of [
  ["absent", "", null], ["explicitly off", "AUTOPILOT=\n", ""], ["explicitly on", "AUTOPILOT=on\n", "on"],
] as const) test(`a separate instance's ${name} schedule does not borrow the parent's setting`, () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-schedule-"));
  writeFileSync(join(dir, ".env.second"), `AGENT_ID=second\n${setting}`);
  const module = fileURLToPath(new URL("../src/env.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `await import(${JSON.stringify(module)}); console.log(JSON.stringify(process.env.AUTOPILOT ?? null));`], {
    cwd: process.cwd(), env: { ...process.env, ENV_FILE: join(dir, ".env.second"), AUTOPILOT: "on" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()), expected);
});
