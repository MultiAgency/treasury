import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { fastnearPost } from "../src/chain.js";

afterEach(() => mock.restoreAll());
const url = "https://tx.main.fastnear.com/v0/transactions";

test("FastNear failures distinguish access, rate limits and unavailable reads without echoing upstream bodies", async () => {
  for (const [status, message] of [[403, /authentication or access/i], [429, /rate limit/i], [503, /unavailable/i]] as const) {
    mock.method(globalThis, "fetch", async () => new Response('{"error":"private upstream detail"}', { status }));
    await assert.rejects(fastnearPost(url, {}), error => error instanceof Error && message.test(error.message) && !error.message.includes("private upstream detail"));
    mock.restoreAll();
  }
});

test("malformed FastNear reads are unavailable evidence, never successful empty results", async () => {
  for (const body of ["not json", "null", "[]"]) {
    mock.method(globalThis, "fetch", async () => new Response(body));
    await assert.rejects(fastnearPost(url, {}), /invalid response/i);
    mock.restoreAll();
  }
  mock.method(globalThis, "fetch", async () => new Response('{"error":"bad request","message":"private detail"}'));
  await assert.rejects(fastnearPost(url, {}), /reported an error/i);
});

test("FastNear transport errors stay unavailable and successful responses retain pagination", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("sensitive transport detail"); });
  await assert.rejects(fastnearPost(url, {}), /read unavailable/i);
  mock.restoreAll();
  const result = { transactions: [], resume_token: "opaque" };
  mock.method(globalThis, "fetch", async () => Response.json(result));
  assert.deepEqual(await fastnearPost(url, {}), result);
});
