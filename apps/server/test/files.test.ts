import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeAtomic } from "../src/files.ts";
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
