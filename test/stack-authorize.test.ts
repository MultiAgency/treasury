import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStack, runScript } from "./fake-stack.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "stack-authorize.ts");
const DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const authorize = (args: string[]) => runScript(SCRIPT, mkdtempSync(join(tmpdir(), "repo-")), args);

test("the owner's strategy grant: the digest it binds is printed", async () => {
  const stack = fakeStack({ ok: true, value: { digest: DIGEST } });
  try {
    const { code, stdout, stderr } = await authorize([stack.directory]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, `${DIGEST}\n`);
    assert.deepEqual(stack.requests, [{ command: "authorizeStrategy" }]);
  } finally { stack.stop(); }
});

test("the platform's refusal is printed to stderr, with exit 1", async () => {
  const stack = fakeStack({ ok: false, error: "The strategy grant failed" });
  try {
    const { code, stdout, stderr } = await authorize([stack.directory]);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /authorizeStrategy failed: The strategy grant failed/);
  } finally { stack.stop(); }
});

test("a usage error writes no control", async () => {
  const stack = fakeStack({ ok: true, value: { digest: DIGEST } });
  try {
    for (const args of [[], [stack.directory, "extra"]]) {
      const { code, stdout, stderr } = await authorize(args);
      assert.equal(code, 1, args.join(" "));
      assert.equal(stdout, "", args.join(" "));
      assert.match(stderr, /Usage: stack-authorize <stack directory>/, args.join(" "));
    }
    assert.deepEqual(stack.requests, [], "no control was written");
  } finally { stack.stop(); }
});
