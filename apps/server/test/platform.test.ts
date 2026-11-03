import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredential } from "../src/credential.ts";
import { createPlatform } from "../src/platform.ts";

const tap = (fill: string) => `tap_00000000-0000-4000-8000-000000000000.${fill.repeat(43)}`;
const identity = { agent: "portfolio", owner: "owner.near", agentId: "id-1", created: true, host: "platform.test", deployment: "treasury" };

/** A fetch that records each request's headers and answers `answer`. */
function recording(answer: (signal: AbortSignal | undefined) => Promise<Response>) {
  const seen: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push(new Headers(input instanceof Request ? input.headers : init?.headers));
    return answer(init?.signal ?? (input instanceof Request ? input.signal : undefined));
  };
  return { fetch, seen };
}

const setup = (answer: Parameters<typeof recording>[0], timeoutMs = 1_000) => {
  const file = join(mkdtempSync(join(tmpdir(), "platform-")), "app-credential");
  writeFileSync(file, tap("a"), { mode: 0o600 });
  const { fetch, seen } = recording(answer);
  return { file, seen, platform: createPlatform({ origin: "https://platform.test", credential: createCredential(file), timeoutMs, fetch }) };
};

test("identity reads the platform under the current credential, and a rotated one is used at once", async () => {
  const { file, seen, platform } = setup(async () => Response.json(identity));
  assert.deepEqual(await platform.identity("portfolio"), { ok: true, value: identity });
  assert.equal(seen[0]!.get("authorization"), `Bearer ${tap("a")}`);
  writeFileSync(file, tap("b"), { mode: 0o600 });
  await platform.identity("portfolio");
  assert.equal(seen[1]!.get("authorization"), `Bearer ${tap("b")}`);
});

test("nothing a browser sends reaches the platform: no Origin, no Cookie", async () => {
  const { seen, platform } = setup(async () => Response.json(identity));
  await platform.identity("portfolio");
  assert.equal(seen[0]!.get("origin"), null);
  assert.equal(seen[0]!.get("cookie"), null);
});

test("a platform that doesn't answer in time is unavailable", async () => {
  const { platform } = setup(signal => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  }), 30);
  // Its own deadline: without a timeout the call would never settle, and a test that never settles is cancelled, not failed.
  const settled = await Promise.race([platform.identity("portfolio"), new Promise(resolve => setTimeout(resolve, 1_000, "never settled"))]);
  assert.deepEqual(settled, { ok: false, kind: "unavailable" });
});
