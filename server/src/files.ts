import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Flushes a directory, so a rename or a new file in it survives a crash. */
async function syncDir(dir: string) {
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Replaces `path` with `data` atomically: a uniquely named temporary file beside it, flushed, then renamed over it. A
 * crash leaves either the old file or the new one, never a torn one, and a leftover temporary file never blocks a later
 * write, since every write uses a fresh name.
 */
export async function writeAtomic(path: string, data: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDir(dirname(path));
}

/** Appends one line to `path`, flushed before it returns. A line is written whole or, after a crash, not at all. */
export async function appendLine(path: string, line: string, mode = 0o600) {
  if (line.includes("\n")) throw new Error("A line holds no newline");
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", mode);
  try { await handle.write(`${line}\n`); await handle.sync(); } finally { await handle.close(); }
}
