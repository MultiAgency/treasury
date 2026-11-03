import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudit, sha256 } from "../src/audit.ts";
import { createCredential } from "../src/credential.ts";
import { appendLine, writeAtomic } from "../src/files.ts";

/** Credentials in the platform's format: `tap_<uuid>.<43 base64url characters>`. */
const tap = (fill: string) => `tap_00000000-0000-4000-8000-000000000000.${fill.repeat(43).slice(0, 43)}`;

const dir = () => mkdtempSync(join(tmpdir(), "treasury-server-"));

test("an atomic write replaces the file whole, 0600, and leaves no temporary file", async () => {
  const at = dir(), file = join(at, "record.json");
  await writeAtomic(file, "first");
  await writeAtomic(file, "second");
  assert.equal(readFileSync(file, "utf8"), "second");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(at), ["record.json"]);
});

test("a crash's leftover temporary file doesn't block a later write", async () => {
  const at = dir(), file = join(at, "record.json");
  writeFileSync(join(at, ".leftover.tmp"), "half");
  await writeAtomic(file, "whole");
  assert.equal(readFileSync(file, "utf8"), "whole");
});

test("lines are appended whole, and a line can't smuggle in another", async () => {
  const file = join(dir(), "log.jsonl");
  await appendLine(file, "one");
  await appendLine(file, "two");
  assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
  await assert.rejects(appendLine(file, "three\nfour"));
});

test("the audit trail records who, what, when and the answer, and holds no secret", async () => {
  const audit = createAudit(dir(), () => Date.parse("2026-11-03T12:00:00Z"));
  const signed = "approve proposal 0123";
  await audit.record({ who: "owner.near", action: "approve", agent: "portfolio", subject: "0123", signedTextSha256: sha256(signed), answer: { ok: true } });
  await audit.record({ who: "owner.near", action: "execute", agent: "portfolio", subject: "0123", answer: { ok: false, kind: "refused", code: "not_executable" } });
  const lines = readFileSync(audit.file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines[0], { at: "2026-11-03T12:00:00.000Z", who: "owner.near", action: "approve", agent: "portfolio", subject: "0123", signedTextSha256: sha256(signed), answer: { ok: true } });
  assert.equal(lines[1].answer.code, "not_executable");
  assert.ok(!readFileSync(audit.file, "utf8").includes(signed), "the signed text is stored as its hash");
});

test("the credential is read from a 0600 file, and read again when the file changes", () => {
  const file = join(dir(), "app-credential");
  writeFileSync(file, `${tap("a")}\n`, { mode: 0o600 });
  const credential = createCredential(file);
  assert.equal(credential.get().reveal(), tap("a"));
  assert.equal(String(credential.get()), "[secret]");
  writeFileSync(file, `${tap("b")}\n`, { mode: 0o600 });
  assert.equal(credential.get().reveal(), tap("b"), "a rotated credential is used without a restart");
});

test("a credential file others can read, or one without a tap_ credential, is refused", () => {
  const file = join(dir(), "app-credential");
  writeFileSync(file, tap("c"), { mode: 0o600 });
  chmodSync(file, 0o644);
  assert.throws(() => createCredential(file).get(), /0600/);
  chmodSync(file, 0o600);
  writeFileSync(file, "tap_not.a-credential");
  assert.throws(() => createCredential(file).get(), /tap_/);
});
