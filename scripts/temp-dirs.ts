// Temporary directories for tests, shared by both packages' suites. They're removed as the test process exits, after
// every `after` hook has run, so a server or stack a test file closes in its own hooks is closed before its
// directories go. That holds whether each file runs in its own process (the default) or all share one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
process.once("exit", () => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A new, empty directory under the system's temporary directory, named `<prefix><random>`, removed as the process exits. */
export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
