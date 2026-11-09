import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Flushes a directory, so a rename or a new file in it survives a crash. */
export async function syncDir(dir: string) {
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Replaces `path` with `data` atomically and owner-only: a uniquely named temporary file beside it, flushed, then
 * renamed over it, and the directory flushed. A crash leaves the old file or the new one, never a torn one, and a
 * leftover temporary file never blocks a later write, since every write uses a fresh name.
 */
export async function writeAtomic(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDir(dirname(path));
}

/**
 * Opens `path` for appending, creating it and its directory owner-only if missing, so a path that can't be written
 * fails now. An existing file others can read is refused, as the credential file is: `open` sets the mode only on create.
 */
export async function ensureAppendable(path: string, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", mode);
  try {
    if ((await handle.stat()).mode & 0o077) throw new Error(`${path} is readable by others: it must be 0600`);
  } finally { await handle.close(); }
}

/**
 * Appends one line to `path`, flushed before it returns; `ensureAppendable` made the file. A crash mid-append can leave
 * at most a torn last line, without a newline, which a reader drops: the next append ends it first, so every other line
 * is whole.
 */
export async function appendLine(path: string, line: string) {
  if (line.includes("\n")) throw new Error("A line holds no newline");
  const handle = await open(path, "a+", 0o600);
  try {
    // A torn last line from a crash has no newline: end it first, so this record starts a line of its own.
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size > 0) await handle.read(last, 0, 1, size - 1);
    await handle.write(`${size > 0 && last[0] !== 0x0a ? "\n" : ""}${line}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}
