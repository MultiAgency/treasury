import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, registryDrift } from "../../../packages/core/src/index.ts";
import type { AuditEntry } from "../src/audit.ts";
import { sha256 } from "../src/audit.ts";
import { createIntents, createIntentsStub, DRY_ACCOUNT, stubTokens, STUB_COST_BPS } from "../src/intents.ts";

const T0 = Date.parse("2026-11-10T21:46:30.000Z");
const USDC = ASSET_REGISTRY.USDC!.id!, XAUT = ASSET_REGISTRY.XAUT!.id!;
/** The token list as 1Click answers it: its own field names, the registry's assets priced a minute before `T0`. */
const listBody = () => JSON.stringify(stubTokens(T0).map(t => ({ assetId: t.assetId, decimals: t.decimals, blockchain: t.blockchain, symbol: t.symbol, price: t.price,
  priceUpdatedAt: new Date(t.priceUpdatedAt!).toISOString(), contractAddress: "x", coingeckoId: "y" })));
/** A dry quote's answer, as the API gave it for 1,000 USDC into XAUT (curl, 2026-11-10), less the fields the planner doesn't read. */
const quoteBody = (change: Record<string, unknown> = {}) => JSON.stringify({
  quote: { amountIn: "1000000000", amountInFormatted: "1000.0", amountInUsd: "999.547000000000", minAmountIn: "1000000000", amountOut: "247952", amountOutFormatted: "0.247952",
    amountOutUsd: "996.409989120000", minAmountOut: "245472", timeEstimate: 12, refundFee: "0", withdrawFee: "0", ...change },
  quoteRequest: { dry: true }, signature: "ed25519:x", timestamp: "2026-11-10T21:46:30.072Z", correlationId: "c",
});

type Call = { url: string; init: RequestInit };
function fake(answers: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answers({ url, init }, calls.length); }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
function recorder() {
  const entries: AuditEntry[] = [];
  return { entries, audit: { append: async (entry: AuditEntry) => { entries.push(entry); } } };
}
const tokensOf = async (intents: ReturnType<typeof createIntents>) => { const r = await intents.tokens("owner.near"); assert.ok(r.ok); return r.value.tokens; };

test("the token list is read once for readers inside its cache window, shared by readers at the same moment, and read again after it", async () => {
  let now = T0;
  const { f, calls } = fake(() => json(listBody()));
  const intents = createIntents({ fetch: f, now: () => now, tokenTtlMs: 60_000 });
  const [a, b] = await Promise.all([intents.tokens("owner.near"), intents.tokens("other.near")]);
  assert.ok(a.ok && b.ok);
  assert.equal(calls.length, 1, "two readers at once share one fetch");
  assert.equal(calls[0]!.url, "https://1click.chaindefuser.com/v0/tokens");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.redirect, "error");
  now += 59_000; await intents.tokens("owner.near");
  assert.equal(calls.length, 1);
  now += 2_000; await intents.tokens("owner.near");
  assert.equal(calls.length, 2);
  assert.deepEqual(registryDrift(a.value.tokens, T0), [], "what it read is what the registry was written against");
});

test("each live call is recorded before it goes out and again with the hash of what came back: never the answer", async () => {
  const { f } = fake(() => json(listBody()));
  const { audit, entries } = recorder();
  await createIntents({ fetch: f, audit, now: () => T0 }).tokens("owner.near");
  assert.deepEqual(entries.map(e => [e.action, e.stage, e.tool, e.who]), [["intents-read", "attempt", "tokens", "owner.near"], ["intents-read", "result", "tokens", "owner.near"]]);
  assert.equal(entries[0]!.inputSha256, sha256("/v0/tokens\n"));
  assert.equal(entries[1]!.stage === "result" && entries[1]!.outputSha256, sha256(listBody()));
  assert.ok(!JSON.stringify(entries).includes("wrap.near"), "no asset or price from the answer is in the log");
});

test("if the attempt can't be recorded the call isn't made", async () => {
  const { f, calls } = fake(() => json(listBody()));
  const result = await createIntents({ fetch: f, audit: { append: async () => { throw new Error("disk full"); } }, now: () => T0 }).tokens("owner.near");
  assert.deepEqual([result.ok, calls.length], [false, 0]);
  assert.ok(!result.ok && result.kind === "unavailable");
});

test("calls are limited an hour for the whole deployment, whoever asks, and the limit lifts as the hour passes", async () => {
  let now = T0;
  const { f, calls } = fake(({ url }) => json(url.endsWith("/v0/tokens") ? listBody() : quoteBody()));
  const intents = createIntents({ fetch: f, now: () => now, tokenTtlMs: 1, quoteTtlMs: 1, callsPerHour: 3 });
  const tokens = await tokensOf(intents);
  for (const [who, sizeUsd] of [["a", 1_000], ["b", 2_000]] as const) { assert.ok((await intents.quote(who, { from: "USDC", to: "XAUT", sizeUsd }, tokens)).ok); now += 10; }
  const refused = await intents.quote("c", { from: "USDC", to: "XAUT", sizeUsd: 3_000 }, tokens);
  assert.ok(!refused.ok && refused.kind === "rate_limited", JSON.stringify(refused));
  assert.equal(calls.length, 3, "a refused call isn't made");
  // A token list that can't be refreshed for want of budget is the cached one, marked stale, not an error.
  const stale = await intents.tokens("c");
  assert.ok(stale.ok && stale.stale);
  now += 3_600_000;
  assert.ok((await intents.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, tokens)).ok);
});

test("a list that can't be read is an error; one that can't be refreshed is served from the cache, marked stale", async () => {
  let now = T0, mode: "good" | "bad" | "down" | "html" = "good";
  const { f } = fake(() => mode === "good" ? json(listBody()) : mode === "down" ? json("oops", 503) : mode === "html" ? json("<html>") : json("{}"));
  const intents = createIntents({ fetch: f, now: () => now, tokenTtlMs: 1_000 });
  mode = "html"; const html = await intents.tokens("a"); assert.ok(!html.ok && html.kind === "invalid");
  mode = "bad"; now += 2_000; const notList = await intents.tokens("a"); assert.ok(!notList.ok && notList.kind === "invalid" && /isn't a list/.test(notList.detail));
  mode = "down"; now += 2_000; const down = await intents.tokens("a"); assert.ok(!down.ok && down.kind === "unavailable");
  mode = "good"; now += 2_000; assert.ok((await intents.tokens("a")).ok);
  mode = "down"; now += 5_000;
  const stale = await intents.tokens("a");
  assert.ok(stale.ok && stale.stale === true && stale.value.tokens.length > 0);
  now += 25 * 3_600_000;
  assert.ok(!(await intents.tokens("a")).ok, "a day-old list isn't served");
});

test("a request that times out or can't be reached is unavailable, and an answer over the size limit is refused", async () => {
  const timeout = createIntents({ fetch: (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch, now: () => T0 });
  const t = await timeout.tokens("a"); assert.ok(!t.ok && t.kind === "unavailable" && /in time/.test(t.detail));
  const big = createIntents({ fetch: (async () => json("x".repeat(2_000_001))) as unknown as typeof fetch, now: () => T0 });
  const b = await big.tokens("a"); assert.ok(!b.ok && b.kind === "unavailable");
});

test("a dry quote asks for a dry, exact-input swap with a placeholder account: nothing of the treasury's goes to NEAR Intents", async () => {
  const { f, calls } = fake(({ url }) => json(url.endsWith("/v0/tokens") ? listBody() : quoteBody()));
  const intents = createIntents({ fetch: f, now: () => T0, slippageBps: 100 });
  const tokens = await tokensOf(intents);
  const result = await intents.quote("owner.near", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, tokens);
  assert.ok(result.ok, JSON.stringify(result));
  const sent = calls.find(c => c.url.endsWith("/v0/quote"))!;
  const body = JSON.parse(sent.init.body as string);
  assert.deepEqual([body.dry, body.swapType, body.originAsset, body.destinationAsset, body.slippageTolerance, body.depositType, body.recipientType], [true, "EXACT_INPUT", USDC, XAUT, 100, "INTENTS", "INTENTS"]);
  assert.deepEqual([body.refundTo, body.recipient], [DRY_ACCOUNT, DRY_ACCOUNT]);
  assert.equal(body.amount, "1000453205", "1,000 USD at the list's 0.999547 USDC price is 1,000.453205 USDC, in raw units, rounded down");
  assert.ok(!JSON.stringify(body).includes("owner.near"));
  assert.deepEqual(result.value, { from: "USDC", to: "XAUT", amountInUsd: 999.547, amountOutUsd: 996.40998912, minAmountOutUsd: result.value.minAmountOutUsd,
    amountIn: "1000000000", amountOut: "247952", at: T0 });
  // The floor is the answer's own ratio applied to its valuation: 245472 / 247952 of 996.41.
  assert.ok(Math.abs(result.value.minAmountOutUsd - 996.40998912 * 245472 / 247952) < 1e-3);
});

test("quotes are cached by pair and whole-dollar size for their window, and a quote is never cached from a failure", async () => {
  let now = T0, fail = true;
  const { f, calls } = fake(({ url }) => url.endsWith("/v0/tokens") ? json(listBody()) : fail ? json("{}", 400) : json(quoteBody()));
  const intents = createIntents({ fetch: f, now: () => now, quoteTtlMs: 30_000 });
  const tokens = await tokensOf(intents);
  const quotes = () => calls.filter(c => c.url.endsWith("/v0/quote")).length;
  const first = await intents.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, tokens);
  assert.ok(!first.ok && first.kind === "unquotable");
  fail = false;
  assert.ok((await intents.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 999.2 }, tokens)).ok);
  assert.ok((await intents.quote("b", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, tokens)).ok);
  assert.equal(quotes(), 2, "999.2 and 1,000 are one whole-dollar size: one call, after the failed one");
  now += 31_000;
  assert.ok((await intents.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, tokens)).ok);
  assert.equal(quotes(), 3);
});

test("a quote that can't be asked or read is a kind, never a number: unknown or identical assets, no size, drifted decimals, a malformed answer", async () => {
  const { f, calls } = fake(({ url }) => url.endsWith("/v0/tokens") ? json(listBody()) : json(quoteBody()));
  const intents = createIntents({ fetch: f, now: () => T0 });
  const tokens = await tokensOf(intents);
  const ask = (from: string, to: string, sizeUsd: number, list = tokens) => intents.quote("a", { from, to, sizeUsd }, list);
  for (const bad of [await ask("NOPE", "XAUT", 100), await ask("USDC", "USDC", 100), await ask("TBILL", "USDC", 100), await ask("USDC", "XAUT", 0), await ask("USDC", "XAUT", Number.NaN)])
    assert.ok(!bad.ok && bad.kind === "unquotable");
  const drifted = tokens.map(t => t.assetId === USDC ? { ...t, decimals: 8 } : t);
  const d = await ask("USDC", "XAUT", 100, drifted); assert.ok(!d.ok && d.kind === "unquotable" && /decimals/.test(d.detail));
  assert.equal(calls.filter(c => c.url.endsWith("/v0/quote")).length, 0, "none of those reached the API");
  for (const [change, label] of [[{ amountOutUsd: "NaN" }, "nan"], [{ amountOut: "-5" }, "negative"], [{ amountInUsd: "0" }, "zero"], [{ minAmountOut: "x" }, "floor"]] as const) {
    const bad = createIntents({ fetch: fake(({ url }) => json(url.endsWith("/v0/tokens") ? listBody() : quoteBody(change))).f, now: () => T0 });
    const r = await bad.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 100 }, await tokensOf(bad));
    assert.ok(!r.ok && r.kind === "invalid", label);
  }
  const shape = createIntents({ fetch: fake(({ url }) => json(url.endsWith("/v0/tokens") ? listBody() : "{\"quote\":{}}")).f, now: () => T0 });
  const s = await shape.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 100 }, await tokensOf(shape)); assert.ok(!s.ok && s.kind === "invalid");
});

test("the stub is deterministic and offline: the registry's assets priced a minute ago, and a quote at its fixed cost", async () => {
  const stub = createIntentsStub({ now: () => T0 });
  const list = await stub.tokens("a");
  assert.ok(list.ok);
  assert.deepEqual(registryDrift(list.value.tokens, T0), []);
  const quote = await stub.quote("a", { from: "USDC", to: "XAUT", sizeUsd: 1_000 }, list.value.tokens);
  assert.ok(quote.ok);
  assert.equal(quote.value.amountOutUsd, 1_000 * (1 - STUB_COST_BPS / 10_000));
  assert.deepEqual(await stub.quote("a", { from: "USDC", to: "TBILL", sizeUsd: 1_000 }, list.value.tokens), { ok: false, kind: "unquotable", detail: "the stub prices only the registry's listed assets, two different ones, at a size above zero" });
  assert.equal(stub.source, "stub");
});
