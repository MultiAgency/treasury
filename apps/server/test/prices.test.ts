import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSET_REGISTRY } from "../../../packages/core/src/index.ts";
import { createPriceFeeds } from "../src/prices.ts";

const NOW = Date.parse("2026-11-11T17:35:30.000Z");
const WNEAR = ASSET_REGISTRY.wNEAR!;
const ANSWERS: Record<string, unknown> = {
  "https://api.exchange.coinbase.com/products/NEAR-USD/ticker": { price: "3.767", time: "2026-11-11T17:35:24.037Z" },
  "https://api.kraken.com/0/public/Ticker?pair=NEARUSD": { error: [], result: { NEARUSD: { c: ["3.76360", "30.85"] } } },
  "https://www.bitstamp.net/api/v2/ticker/nearusd/": { last: "3.76210", timestamp: "1794418524" },
};

function world(answer: (url: string, init: RequestInit) => Promise<Response> | Response = url =>
  Response.json(ANSWERS[url] ?? { message: "NotFound" }, { status: url in ANSWERS ? 200 : 404 })) {
  const clock = { now: NOW };
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { clock, calls, feeds: createPriceFeeds({ fetch, now: () => clock.now, timeoutMs: 1_000, cacheMs: 30_000 }) };
}

test("an asset's three sources are read, each a GET that follows no redirect, and each quote names its source and the asset", async () => {
  const w = world();
  const quotes = await w.feeds.quotes(WNEAR);
  assert.deepEqual(quotes, [
    { source: "Coinbase Exchange NEAR-USD", asset: WNEAR.id, price: 3.767, observedAt: Date.parse("2026-11-11T17:35:24.037Z") },
    { source: "Kraken NEARUSD", asset: WNEAR.id, price: 3.7636, observedAt: NOW },
    { source: "Bitstamp nearusd", asset: WNEAR.id, price: 3.7621, observedAt: 1794418524_000 },
  ]);
  assert.deepEqual(w.calls.map(c => [c.init.method ?? "GET", c.init.redirect]), [["GET", "error"], ["GET", "error"], ["GET", "error"]]);
  assert.ok(w.calls.every(c => c.init.signal instanceof AbortSignal), "every read has a timeout");
});

test("a source that is down, answers an error, times out, redirects or sends something else is left out; the others still count", async () => {
  const kraken = "https://api.kraken.com/0/public/Ticker?pair=NEARUSD";
  const failures: ((url: string, init: RequestInit) => Promise<Response> | Response)[] = [
    () => { throw new TypeError("fetch failed"); },
    () => new Response("busy", { status: 503 }),
    () => Response.json({ error: ["EGeneral:Too many requests"] }),
    () => new Response("not json"),
    (_url, init) => { if (init.redirect === "error") throw new TypeError("unexpected redirect"); return Response.json(ANSWERS[kraken]); },
    () => new Response(JSON.stringify(ANSWERS[kraken]), { headers: { "content-length": String(10_000_000) } }),
    (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))),
  ];
  for (const fail of failures) {
    const w = world((url, init) => url === kraken ? fail(url, init) : Response.json(ANSWERS[url]));
    const quotes = await w.feeds.quotes(WNEAR);
    assert.deepEqual(quotes.map(q => q.source), ["Coinbase Exchange NEAR-USD", "Bitstamp nearusd"], String(fail));
  }
  // Every source down: no quotes, so the oracle freezes; nothing throws.
  assert.deepEqual(await world(() => { throw new TypeError("offline"); }).feeds.quotes(WNEAR), []);
});

test("a source is read at most once in its cache window, shared by readers at once, and read again after it", async () => {
  const w = world();
  await Promise.all([w.feeds.quotes(WNEAR), w.feeds.quotes(WNEAR)]);
  assert.equal(w.calls.length, 3, "two readers at once share one read of each source");
  w.clock.now += 29_000;
  await w.feeds.quotes(WNEAR);
  assert.equal(w.calls.length, 3, "inside the window the last answer stands");
  w.clock.now += 2_000;
  await w.feeds.quotes(WNEAR);
  assert.equal(w.calls.length, 6, "past it each source is read again");
});

test("a failed read isn't kept: the next reader tries again", async () => {
  let down = true;
  const w = world(url => down ? new Response("busy", { status: 503 }) : Response.json(ANSWERS[url]));
  assert.deepEqual(await w.feeds.quotes(WNEAR), []);
  down = false;
  assert.equal((await w.feeds.quotes(WNEAR)).length, 3);
});

test("an asset with a source that names no feed reads only what it can, and nothing is invented for the rest", async () => {
  const w = world();
  assert.deepEqual(await w.feeds.quotes(ASSET_REGISTRY.TBILL!), []);
  assert.equal(w.calls.length, 0);
});

test("an oversized streamed body is cancelled before the rest is read, even with a false length", async () => {
  let cancelled = 0, pulls = 0;
  const w = world(() => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(60_000)); },
    cancel() { cancelled++; },
  }), { headers: { "content-length": "1" } }));
  assert.deepEqual(await w.feeds.quotes(WNEAR), []);
  assert.equal(cancelled, 3);
  assert.ok(pulls <= 9, `must not consume an unbounded stream (${pulls})`);
});
