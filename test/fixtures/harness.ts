import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, mock } from "node:test";
import { fileURLToPath } from "node:url";

/** Offline setup shared by the suites. Real SQLite, files and child processes; never the network. */

/** For suites that run a fixture in a child process, as a separate server or CLI would be. */
export const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

/**
 * Runs the suite's tests in a fresh temporary directory, a new instance's state: one per test by
 * default, or one for the whole suite. Call it before the suite's own hooks, which then run inside it.
 */
export function freshDirectory(prefix: string, { per = "test" }: { per?: "test" | "suite" } = {}) {
  const home = process.cwd();
  const directories: string[] = [];
  (per === "test" ? beforeEach : before)(() => {
    const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
    directories.push(directory);
    process.chdir(directory);
  });
  after(() => {
    process.chdir(home);
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });
}

/** Any network call fails, so a test that would reach the provider or a chain says so. */
export const offline = () => mock.method(globalThis, "fetch", async () => { throw new Error("offline only"); });
