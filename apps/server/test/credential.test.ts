import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredential } from "../src/credential.ts";

/** Credentials in the platform's format: `tap_<uuid>.<43 base64url characters>`. */
const tap = (fill: string) => `tap_00000000-0000-4000-8000-000000000000.${fill.repeat(43).slice(0, 43)}`;
const fileWith = (contents: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "credential-")), "app-credential");
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
};

test("the credential is read from a 0600 file, and read again when the file changes", async () => {
  const file = fileWith(`${tap("a")}\n`);
  const credential = createCredential(file);
  assert.equal((await credential.get()).reveal(), tap("a"));
  assert.equal(String(await credential.get()), "[secret]");
  writeFileSync(file, `${tap("b")}\n`, { mode: 0o600 });
  assert.equal((await credential.get()).reveal(), tap("b"), "a rotated credential is used without a restart, even at the same length");
});

test("an unchanged file keeps the same credential", async () => {
  const credential = createCredential(fileWith(tap("a")));
  assert.equal(await credential.get(), await credential.get());
});

test("a credential file others can read, or one without a tap_ credential, is refused", async () => {
  const file = fileWith(tap("c"));
  chmodSync(file, 0o644);
  await assert.rejects(createCredential(file).get(), /0600/);
  chmodSync(file, 0o600);
  writeFileSync(file, "tap_not.a-credential");
  await assert.rejects(createCredential(file).get(), /tap_/);
});
