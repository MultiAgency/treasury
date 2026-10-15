import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { TSX } from "./fixtures/harness.js";

const fixture = fileURLToPath(new URL("./fixtures/settings-writer.ts", import.meta.url));
for (const alias of [false, true]) test(`competing settings updates preserve a schedule stop and grant (symlink: ${alias})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-race-"));
  writeFileSync(join(dir, ".env"), "AUTOPILOT=on\nAGENT_GRANT_TOKEN=old-fixture\n");
  if (alias) symlinkSync(".env", join(dir, ".env.alias"));
  const env = { ...process.env, ENV_FILE: ".env" };
  const writer = spawn(TSX, [fixture, JSON.stringify({ AGENT_GRANT_TOKEN: "new-fixture" }), "pause"], { cwd: dir, env, stdio: "pipe" });
  let errors = "";
  writer.stderr.on("data", data => { errors += data; });
  const exited = new Promise<number | null>((resolve, reject) => { writer.on("exit", resolve); writer.on("error", reject); });
  const stop = () => spawnSync(TSX, [fixture, JSON.stringify({ AUTOPILOT: "" })], {
    cwd: dir, env: { ...env, ENV_FILE: alias ? ".env.alias" : ".env" }, encoding: "utf8", timeout: 10_000,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "writer-ready"))) {
      assert.equal(writer.exitCode, null, errors);
      assert.ok(Date.now() < deadline, "writer did not reach its settings read");
      await setTimeout(10);
    }
    const competing = stop();
    assert.notEqual(competing.status, 0, "a competing update must refuse instead of replacing a stale snapshot");
    assert.match(competing.stderr, /settings.*retry/i);
  } finally {
    writeFileSync(join(dir, "writer-release"), "release");
    assert.equal(await exited, 0, errors);
  }
  const retried = stop();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual({ ...parseEnv(readFileSync(join(dir, ".env"), "utf8")) }, { AUTOPILOT: "", AGENT_GRANT_TOKEN: "new-fixture" });
});
