// A stack directory the scripts can't tell from the platform's, and a runner for them: shared by the script tests.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A stack directory with only `state.json` and `controls/`, whose control answers `answer` to the first request. */
export function fakeStack(answer: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "stack-")), controls = join(directory, "controls");
  mkdirSync(controls);
  writeFileSync(join(directory, "state.json"), JSON.stringify({ treasury: { agent: "portfolio", machineBase: "https://127.0.0.1:4444/machine/v1/a/portfolio" } }));
  const requests: unknown[] = [];
  let stopped = false;
  void (async () => {
    while (!stopped) {
      for (const name of readdirSync(controls).filter(name => /^treasury-.*\d\.json$/.test(name))) {
        const result = join(controls, name.replace(/\.json$/, ".result.json"));
        if (existsSync(result)) continue;
        requests.push(JSON.parse(readFileSync(join(controls, name), "utf8")));
        writeFileSync(result, JSON.stringify(answer));
      }
      await delay(20);
    }
  })();
  return { directory, requests, stop: () => { stopped = true; } };
}

export function runScript(script: string, cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { PATH: process.env.PATH } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
