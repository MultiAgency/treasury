import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; return false; }
};

for (const scenario of ["before-message", "after-message", "exit-deadline", "late-resource", "spawn-error", "normal", "ipc-error-next", "ipc-error-exit", "ipc-error-stop"]) {
  test(`test-process: ${scenario} leaves no worker or resource alive`, async t => {
    const directory = tempDir(`treasury-lifecycle-${scenario}-`);
    const pidFile = join(directory, "worker.pid"), resourceFile = join(directory, "resource.txt");
    // Independent watchdog: a regression must fail this test rather than hang the suite running it.
    const runner = spawn(process.execPath, ["--test", "--test-isolation=none", "--test-reporter=tap", join(import.meta.dirname, "fixtures/test-process.fixture.mjs")], {
      env: { PATH: process.env.PATH, LIFECYCLE_SCENARIO: scenario, LIFECYCLE_PID_FILE: pidFile, LIFECYCLE_RESOURCE_FILE: resourceFile },
      stdio: ["ignore", "pipe", "pipe"], timeout: 8_000, killSignal: "SIGKILL",
    });
    const workerPid = () => {
      if (!existsSync(pidFile)) return undefined;
      const pid = Number(readFileSync(pidFile, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    };
    t.after(() => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      const pid = workerPid();
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    });
    let output = "";
    runner.stdout.on("data", chunk => { output += chunk; });
    runner.stderr.on("data", chunk => { output += chunk; });
    const [code, signal] = await once(runner, "close");
    assert.equal(signal, null, `watchdog killed a hung test runner: ${output}`);
    assert.equal(code, scenario === "normal" || scenario.startsWith("ipc-error") ? 0 : 1, output);
    if (scenario === "before-message" || scenario === "after-message" || scenario === "late-resource") assert.match(output, /test timed out/);
    if (scenario === "exit-deadline") assert.match(output, /Worker exit timed out/);
    if (scenario === "spawn-error") assert.match(output, /ENOENT/);
    if (["after-message", "exit-deadline", "normal"].includes(scenario) || scenario.startsWith("ipc-error")) assert.equal(readFileSync(`${pidFile}.ready`, "utf8"), "ready", "worker evidence arrived before the exit wait");
    const pid = workerPid();
    if (pid !== undefined) assert.equal(alive(pid), false, `worker ${pid} survived ${scenario}`);
    assert.equal(readFileSync(resourceFile, "utf8"), "disposed\n", "resource disposed exactly once, including late startup");
  });
}
