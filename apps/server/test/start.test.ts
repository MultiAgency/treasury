import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFiles } from "../src/start.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const tap = `tap_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;

test("each secret set in the environment is written whole to its file, owner-only, and leaves the environment", async () => {
  const dir = tempDir("treasury-start-");
  const env: NodeJS.ProcessEnv = {
    TREASURY_CREDENTIAL: `${tap}\n`, TREASURY_CREDENTIAL_FILE: join(dir, "secrets", "app-credential"),
    TREASURY_ANCHOR_KEY: `ed25519:${"3".repeat(88)}`, TREASURY_ANCHOR_KEY_FILE: join(dir, "secrets", "anchor.key"),
    PATH: "/bin",
  };
  assert.deepEqual(await writeSecretFiles(env), [join(dir, "secrets", "app-credential"), join(dir, "secrets", "anchor.key")]);
  assert.equal(readFileSync(join(dir, "secrets", "app-credential"), "utf8"), `${tap}\n`);
  assert.equal(statSync(join(dir, "secrets", "app-credential")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "secrets", "anchor.key")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "secrets")).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "TREASURY_ANCHOR_KEY_FILE", "TREASURY_CREDENTIAL_FILE"]);
});

test("unset or empty secrets write nothing, so a file put there another way stays; a secret with no file named is refused", async () => {
  assert.deepEqual(await writeSecretFiles({ TREASURY_CREDENTIAL: "", TREASURY_CREDENTIAL_FILE: "/nowhere/app-credential" }), []);
  const env: NodeJS.ProcessEnv = { TREASURY_CREDENTIAL: tap };
  await assert.rejects(writeSecretFiles(env), /TREASURY_CREDENTIAL is set, but TREASURY_CREDENTIAL_FILE doesn't name the file/);
  assert.equal(env.TREASURY_CREDENTIAL, tap, "nothing was written, so nothing was dropped");
});
