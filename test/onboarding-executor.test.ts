import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("onboarding-executor");
const fixture = fileURLToPath(new URL("./fixtures/onboarding-executor.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

test("onboarding acquires executor ownership and starts its loops without restarting", () => {
  const id = `onboarding-${randomUUID()}`;
  const result = spawnSync(process.execPath, ["--import", tsx, fixture, id], {
    cwd: process.cwd(), env: { ...process.env, ENV_FILE: "", AGENT_ID: "", PORT: "0" },
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.split("\n").find(line => line.startsWith('{"reviewResult"'))!);
  assert.equal(observed.agentId, id);
  assert.equal(observed.protectedByLease, true, "newly configured server must already hold its executor lease");
  assert.equal(observed.before.includes(60_000), false);
  assert.equal(observed.after.includes(60_000), true, "autopilot timer starts after creation, with schedule still off");
});
