import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { appendLine, writeAtomic } from "../src/files.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const scratch = async () => tempDir("treasury-files-");

test("an atomic write replaces the file whole, owner-only, and leaves no temporary file", async () => {
  const dir = await scratch(), file = join(dir, "requests.json");
  await writeAtomic(file, "first");
  await writeAtomic(file, "second");
  assert.equal(await readFile(file, "utf8"), "second");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["requests.json"]);
});

test("a file others could read is replaced by an owner-only one", async () => {
  const dir = await scratch(), file = join(dir, "requests.json");
  await writeFile(file, "old");
  await chmod(file, 0o644);
  await writeAtomic(file, "new");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("its directory is made when missing", async () => {
  const file = join(await scratch(), "state", "requests.json");
  await writeAtomic(file, "whole");
  assert.equal(await readFile(file, "utf8"), "whole");
});

test("a crash's leftover temporary file doesn't block a later write", async () => {
  const dir = await scratch(), file = join(dir, "requests.json");
  await writeFile(join(dir, ".leftover.tmp"), "torn");
  await writeAtomic(file, "whole");
  assert.equal(await readFile(file, "utf8"), "whole");
});

test("a write that can't replace the file throws, keeps what was there, and leaves no temporary file", async () => {
  const dir = await scratch(), file = join(dir, "requests.json");
  await mkdir(file); // A directory where the file goes: the rename fails.
  await assert.rejects(writeAtomic(file, "whole"));
  assert.deepEqual(await readdir(dir), ["requests.json"]);
  assert.ok((await stat(file)).isDirectory());
});

test("a line with a newline in it is refused, so a record is always exactly one line", async () => {
  await assert.rejects(appendLine(join(await scratch(), "f"), "a\nb"), /no newline/);
});

test("after a crash left a torn last line, the next record still starts a line of its own", async () => {
  const file = join(await scratch(), "audit.jsonl");
  await writeFile(file, '{"whole":1}\n{"torn":', { mode: 0o600 });
  await appendLine(file, '{"next":2}');
  const lines = (await readFile(file, "utf8")).split("\n");
  assert.deepEqual(lines, ['{"whole":1}', '{"torn":', '{"next":2}', ""]);
  assert.deepEqual(JSON.parse(lines[2]!), { next: 2 }, "the new record is readable; only the torn one isn't");
});
