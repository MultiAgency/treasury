import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCredential } from "../src/credential.ts";
import { createPlatform, type WatchPlatform } from "../src/platform.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const tap = `tap_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;

/** `watch`'s platform over a fetch that records each request's method, path and body. */
function setup() {
  const file = join(tempDir("watch-platform-"), "app-credential");
  writeFileSync(file, tap, { mode: 0o600 });
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.push(`${request.method} ${new URL(request.url).pathname} ${request.method === "POST" ? await request.text() : ""}`.trim());
    return Response.json({});
  };
  return { seen, watch: createPlatform({ origin: "https://platform.test", credential: createCredential(file), timeoutMs: 1_000, fetch }).watch };
}

test("watch reaches its reads and its proposals' create, read and list, under the agent's Organization", async () => {
  const { seen, watch } = setup();
  await watch.overview("alice--near", "portfolio");
  await watch.unresolved("alice--near", "portfolio");
  await watch.autopilot("alice--near", "portfolio");
  await watch.strategy("alice--near", "portfolio");
  await watch.list("alice--near", "portfolio");
  await watch.get("alice--near", "portfolio", "0".repeat(32));
  await watch.create("alice--near", "portfolio", { requestId: "portfolio_1", legs: "strategy", expiresAt: "2026-11-05T12:00:00Z" });
  const rpc = "POST /apps/v1/o/alice--near/a/portfolio/rpc";
  assert.deepEqual(seen, [
    `${rpc}/overview`, `${rpc}/unresolved`, `${rpc}/autopilot/get`, `${rpc}/strategy/get`, `${rpc}/proposals/list`,
    `${rpc}/proposals/get {"json":{"id":"${"0".repeat(32)}"}}`,
    `${rpc}/proposals/create {"json":{"requestId":"portfolio_1","legs":"strategy","expiresAt":"2026-11-05T12:00:00Z"}}`,
  ]);
});

test("watch reads the agent's identity and the Organization's consents, to tell why it was refused", async () => {
  const { seen, watch } = setup();
  await watch.identity("portfolio");
  await watch.consents("alice--near");
  assert.deepEqual(seen.map(line => line.split(" ").slice(0, 2).join(" ")), ["GET /apps/v1/agents/portfolio", "GET /apps/v1/consents"]);
});

// The type test: `watch` is given these and nothing else. Approving, executing, withdrawing, consenting, saving a
// strategy, autopilot changes and plans are out of its reach; adding any here fails the typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const reach: Same<keyof WatchPlatform, "overview" | "unresolved" | "books" | "autopilot" | "strategy" | "list" | "get" | "create" | "identity" | "consents"> = true;
void reach;
