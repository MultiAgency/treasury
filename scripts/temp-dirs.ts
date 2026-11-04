// Temporary directories for a test file, shared by both packages' suites and removed when the file's tests end: each
// test file runs in its own process, so a hook registered here belongs to that file's run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

/** A new, empty directory under the system's temporary directory, named `<prefix><random>`, removed after the tests. */
export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
