import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileAudit, sha256 } from "../src/audit.ts";
import { appendLine } from "../src/files.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

test("each relayed action is one JSON line, appended, flushed and owner-only, with the text's hash and no signature", async () => {
  const file = join(tempDir("audit-"), "nested", "audit.jsonl");
  const audit = fileAudit(file, () => Date.parse("2026-11-03T12:00:00Z"));
  await audit.check();
  await audit.append({ who: "owner.near", action: "consent", agent: "portfolio", signedTextSha256: sha256("text"), stage: "result", answer: { ok: true }, subject: "c1" });
  await audit.append({ who: "owner.near", action: "revoke", agent: "portfolio", subject: "c1", stage: "result", answer: { ok: false, kind: "unavailable" } });
  const lines = readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 3, "two lines and the final newline");
  assert.deepEqual(JSON.parse(lines[0]!), { at: "2026-11-03T12:00:00.000Z", who: "owner.near", action: "consent", agent: "portfolio",
    signedTextSha256: "982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1", stage: "result", answer: { ok: true }, subject: "c1" });
  assert.equal(JSON.parse(lines[1]!).answer.kind, "unavailable");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a line with a newline in it is refused, so a record is always exactly one line", async () => {
  await assert.rejects(appendLine(join(tempDir("audit-"), "f"), "a\nb"), /no newline/);
});

test("after a crash left a torn last line, the next record still starts a line of its own", async () => {
  const file = join(tempDir("audit-"), "audit.jsonl");
  writeFileSync(file, '{"whole":1}\n{"torn":', { mode: 0o600 });
  await appendLine(file, '{"next":2}');
  const lines = readFileSync(file, "utf8").split("\n");
  assert.deepEqual(lines, ['{"whole":1}', '{"torn":', '{"next":2}', ""]);
  assert.deepEqual(JSON.parse(lines[2]!), { next: 2 }, "the new record is readable; only the torn one isn't");
});

test("an entry can't break the one-line-per-action format", async () => {
  const audit = fileAudit(join(tempDir("audit-"), "audit.jsonl"));
  await audit.append({ who: "owner.near", action: "consent", agent: "port\nfolio", stage: "attempt" });
  const file = (audit as unknown as { file: string }).file;
  assert.equal(readFileSync(file, "utf8").split("\n").length, 2, "JSON escapes the newline");
});

test("an existing audit file others can read is refused at startup, as the credential file is", async () => {
  const file = join(tempDir("audit-"), "audit.jsonl");
  writeFileSync(file, "");
  chmodSync(file, 0o644);
  await assert.rejects(fileAudit(file).check(), /0600/);
  chmodSync(file, 0o600);
  await fileAudit(file).check();
});
