// NEAR Intents, read live (#221): the token list and dry-run quotes of the 1Click API, the one place this server talks to
// it. Both calls are public and keyless, and neither moves anything: a dry quote is priced and never reserves a deposit
// address, so there is nothing to sign, no JWT, and no account of the treasury's in the request (a fixed placeholder
// account stands in for the sender and recipient, so the API learns nothing of which treasury is asking). The answers are
// untrusted data: they are parsed by the core's checks, never repeated into an instruction, and what they say about an
// asset is compared with the registry, never taken to widen it.
//
// A call is bounded four ways: a timeout, a response size, a rate limit an hour for the whole deployment (so a page
// reloaded in a loop can't spend the API's goodwill), and a short cache that also shares one fetch between readers at
// once. Each live call is recorded in the audit log by the hash of what was asked and what came back (`intents-read`), the
// attempt before the request goes out; a record that can't be appended stops the call. Failing closed: every failure is a
// kind, never a guess, and the planner treats a missing quote as a block.
//
// Three providers: `live` (the API), `stub` (a deterministic list and quotes from the registry, nothing leaves the
// server: tests and the stack use it) and none, which the routes report as `off`.

import { z } from "zod";
import {
  ASSET_REGISTRY, parseIntentsTokens, quoteProblems, type AssetEntry, type DryQuote, type IntentsToken,
} from "../../../packages/core/src/index.ts";
import { sha256, type Audit } from "./audit.ts";
import { createRateLimit, type RateLimit } from "./ratelimit.ts";

export const INTENTS_API = "https://1click.chaindefuser.com";
/** The account a dry quote names as sender, refund and recipient: not an account of this treasury's, and never one it holds. */
export const DRY_ACCOUNT = "treasury-dry-run.near";
const MAX_BODY_CHARS = 2_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type IntentsFailure = { kind: "off" | "unavailable" | "rate_limited" | "invalid" | "unquotable"; detail: string };
export type IntentsRead<T> = ({ ok: true; value: T; fetchedAt: number; stale: boolean }) | ({ ok: false } & IntentsFailure);
export type TokenList = { tokens: IntentsToken[]; rejected: number };
/** What a dry quote asks: registry symbols, and the USD size to spend. */
export type QuoteRequest = { from: string; to: string; sizeUsd: number };

export type Intents = {
  /** `live` or `stub`: what the owner's page says the numbers are. */
  source: "live" | "stub";
  tokens(who: string): Promise<IntentsRead<TokenList>>;
  quote(who: string, request: QuoteRequest, tokens: readonly IntentsToken[]): Promise<IntentsRead<DryQuote>>;
};

type Deps = {
  fetch?: typeof fetch;
  baseUrl?: string;
  audit?: Audit;
  now?: () => number;
  timeoutMs?: number;
  /** Calls to the API an hour, for the whole deployment: the token list and every quote. */
  callsPerHour?: number;
  tokenTtlMs?: number;
  quoteTtlMs?: number;
  /** The slippage a dry quote asks for, in basis points: its floor is `minAmountOutUsd`. */
  slippageBps?: number;
  dryAccount?: string;
};

/** The 1Click quote answer, as much of it as the planner reads: every amount a string of digits or a decimal, all checked after. */
const quoteAnswer = z.looseObject({
  quote: z.looseObject({
    amountIn: z.string(), amountInUsd: z.string(), amountOut: z.string(), amountOutUsd: z.string(), minAmountOut: z.string(),
  }),
});

const read = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) throw new Error("the answer is too large");
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new Error("the answer is too large");
  return text;
};

/** The live provider: the 1Click API, with the bounds above. */
export function createIntents(deps: Deps = {}): Intents {
  const {
    fetch: send = fetch, baseUrl = INTENTS_API, audit, now = Date.now, timeoutMs = 10_000, callsPerHour = 120,
    tokenTtlMs = 60_000, quoteTtlMs = 30_000, slippageBps = 100, dryAccount = DRY_ACCOUNT,
  } = deps;
  const budget: RateLimit = createRateLimit({ limit: callsPerHour, windowMs: HOUR_MS, now });
  let tokenCache: { at: number; value: TokenList } | undefined, tokenFlight: Promise<IntentsRead<TokenList>> | undefined;
  const quoteCache = new Map<string, { at: number; value: DryQuote }>();
  const quoteFlight = new Map<string, Promise<IntentsRead<DryQuote>>>();

  /** One bounded call, recorded: its attempt before it goes out, its result by the hash of what came back. */
  async function call(who: string, tool: "tokens" | "quote", path: string, body: unknown): Promise<{ ok: true; text: string } | { ok: false; failure: IntentsFailure }> {
    if (!budget("intents")) return { ok: false, failure: { kind: "rate_limited", detail: `NEAR Intents calls are limited to ${callsPerHour} an hour for this deployment` } };
    const inputSha256 = sha256(`${path}\n${body === undefined ? "" : JSON.stringify(body)}`);
    try { await audit?.append({ who, action: "intents-read", stage: "attempt", tool, inputSha256 }); } catch {
      return { ok: false, failure: { kind: "unavailable", detail: "the call couldn't be recorded in the audit log, so it wasn't made" } };
    }
    let text: string, status: number;
    try {
      const response = await send(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      status = response.status;
      text = await read(response);
    } catch (error) {
      await audit?.append({ who, action: "intents-read", stage: "result", tool, inputSha256, answer: { ok: false, kind: "unavailable" } }).catch(() => {});
      return { ok: false, failure: { kind: "unavailable", detail: error instanceof Error && error.name === "TimeoutError" ? "NEAR Intents didn't answer in time" : "NEAR Intents couldn't be reached" } };
    }
    const ok = status >= 200 && status < 300;
    await audit?.append({ who, action: "intents-read", stage: "result", tool, inputSha256, outputSha256: sha256(text), answer: ok ? { ok: true } : { ok: false, kind: "unavailable", status } }).catch(() => {});
    if (!ok) return { ok: false, failure: { kind: status >= 400 && status < 500 && tool === "quote" ? "unquotable" : "unavailable", detail: `NEAR Intents answered ${status}` } };
    return { ok: true, text };
  }

  async function fetchTokens(who: string): Promise<IntentsRead<TokenList>> {
    const answer = await call(who, "tokens", "/v0/tokens", undefined);
    if (!answer.ok) {
      // A list that can't be refreshed is served from the cache for a day, marked stale: its prices carry their own times,
      // so the planner and the drift check treat an old price as one.
      if (tokenCache && now() - tokenCache.at < DAY_MS) return { ok: true, value: tokenCache.value, fetchedAt: tokenCache.at, stale: true };
      return { ok: false, ...answer.failure };
    }
    let raw: unknown;
    try { raw = JSON.parse(answer.text); } catch { return { ok: false, kind: "invalid", detail: "NEAR Intents' token list isn't JSON" }; }
    const parsed = parseIntentsTokens(raw);
    if (parsed.problems.length > 0) return { ok: false, kind: "invalid", detail: parsed.problems.join("; ") };
    tokenCache = { at: now(), value: { tokens: parsed.tokens, rejected: parsed.rejected } };
    return { ok: true, value: tokenCache.value, fetchedAt: tokenCache.at, stale: false };
  }

  async function fetchQuote(who: string, request: QuoteRequest, tokens: readonly IntentsToken[]): Promise<IntentsRead<DryQuote>> {
    const from = ASSET_REGISTRY[request.from], to = ASSET_REGISTRY[request.to];
    const unquotable = (detail: string): IntentsRead<DryQuote> => ({ ok: false, kind: "unquotable", detail });
    if (!from || !to || from.id === null || to.id === null || from.id === to.id) return unquotable("a quote needs two different registry assets NEAR Intents carries");
    if (!(Number.isFinite(request.sizeUsd) && request.sizeUsd > 0)) return unquotable("a quote needs a size above zero");
    const live = tokens.find(t => t.assetId === from.id);
    // The raw amount is sized on the list's price and the registry's decimals; an asset whose decimals have drifted isn't quoted.
    if (!live || live.price === null || live.decimals !== from.decimals) return unquotable(`${from.symbol} has no usable price or matching decimals on NEAR Intents' list`);
    const raw = BigInt(Math.floor((request.sizeUsd / live.price) * 10 ** live.decimals));
    if (raw <= 0n) return unquotable("the size is under one unit of the asset");
    const answer = await call(who, "quote", "/v0/quote", {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: slippageBps, originAsset: from.id, destinationAsset: to.id, amount: String(raw),
      depositType: "INTENTS", refundTo: dryAccount, refundType: "INTENTS", recipient: dryAccount, recipientType: "INTENTS",
      deadline: new Date(now() + 10 * 60_000).toISOString(),
    });
    if (!answer.ok) return { ok: false, ...answer.failure };
    let parsed;
    try { parsed = quoteAnswer.safeParse(JSON.parse(answer.text)); } catch { parsed = undefined; }
    if (!parsed?.success) return { ok: false, kind: "invalid", detail: "NEAR Intents' quote isn't in the shape the planner reads" };
    const q = parsed.data.quote;
    const amountOut = /^[0-9]{1,40}$/.test(q.amountOut) ? BigInt(q.amountOut) : 0n, floor = /^[0-9]{1,40}$/.test(q.minAmountOut) ? BigInt(q.minAmountOut) : 0n;
    const amountOutUsd = Number(q.amountOutUsd);
    // The floor in USD at the quote's own rate: the answer's floor over its amount, applied to its valuation.
    const minAmountOutUsd = amountOut > 0n ? amountOutUsd * Number((floor * 1_000_000n) / amountOut) / 1_000_000 : Number.NaN;
    const value: DryQuote = { from: from.symbol, to: to.symbol, amountInUsd: Number(q.amountInUsd), amountOutUsd, minAmountOutUsd, amountIn: q.amountIn, amountOut: q.amountOut, at: now() };
    if (quoteProblems(value).length > 0) return { ok: false, kind: "invalid", detail: `NEAR Intents' quote can't be used: ${quoteProblems(value).join("; ")}` };
    return { ok: true, value, fetchedAt: value.at, stale: false };
  }

  return {
    source: "live",
    tokens(who) {
      if (tokenCache && now() - tokenCache.at < tokenTtlMs) return Promise.resolve({ ok: true, value: tokenCache.value, fetchedAt: tokenCache.at, stale: false });
      tokenFlight ??= fetchTokens(who).finally(() => { tokenFlight = undefined; });
      return tokenFlight;
    },
    quote(who, request, tokens) {
      // Sizes are rounded up to a whole dollar by the planner's requests, so one quote serves the readers of one moment.
      const key = `${request.from}>${request.to}:${Math.ceil(request.sizeUsd)}`;
      const cached = quoteCache.get(key);
      if (cached && now() - cached.at < quoteTtlMs) return Promise.resolve({ ok: true, value: cached.value, fetchedAt: cached.at, stale: false });
      let flight = quoteFlight.get(key);
      if (!flight) {
        flight = fetchQuote(who, request, tokens).then(result => {
          if (result.ok) {
            quoteCache.set(key, { at: result.fetchedAt, value: result.value });
            // The cache is bounded: the oldest entries go first.
            if (quoteCache.size > 64) for (const old of [...quoteCache.keys()].slice(0, quoteCache.size - 64)) quoteCache.delete(old);
          }
          return result;
        }).finally(() => quoteFlight.delete(key));
        quoteFlight.set(key, flight);
      }
      return flight;
    },
  };
}

/** The prices the stub quotes at (NEAR Intents' list on 2026-11-10), so its list is the registry's own ids and decimals with a day's prices. */
export const STUB_PRICES: Readonly<Record<string, number>> = {
  wNEAR: 3.57, ETH: 2056.59, BTC: 73787, SOL: 83.36, XAUT: 4018.56, USDC: 0.999547, USDT: 0.999183, "USDC.e": 0.999547,
};
/** What the stub's quote costs, in basis points of what is spent. */
export const STUB_COST_BPS = 30;

/** The registry's assets as a token list, priced a minute before `at`: deterministic, with nothing read from the network. */
export function stubTokens(at: number, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): IntentsToken[] {
  return Object.values(registry).flatMap(entry => entry.id === null || entry.decimals === null || STUB_PRICES[entry.symbol] === undefined ? []
    : [{ assetId: entry.id, symbol: entry.symbol === "USDC.e" ? "USDC" : entry.symbol, blockchain: entry.chain, decimals: entry.decimals, price: STUB_PRICES[entry.symbol]!, priceUpdatedAt: at - 60_000 }]);
}

/** The stub provider: the list above, and a quote at `STUB_COST_BPS` for any two assets it prices. Never calls out. */
export function createIntentsStub({ now = Date.now }: { now?: () => number } = {}): Intents {
  return {
    source: "stub",
    async tokens() { return { ok: true, value: { tokens: stubTokens(now()), rejected: 0 }, fetchedAt: now(), stale: false }; },
    async quote(_who, request) {
      const from = ASSET_REGISTRY[request.from], to = ASSET_REGISTRY[request.to];
      const fromPrice = STUB_PRICES[request.from], toPrice = STUB_PRICES[request.to];
      if (!from || !to || fromPrice === undefined || toPrice === undefined || from.decimals === null || to.decimals === null || from.id === to.id || !(request.sizeUsd > 0))
        return { ok: false, kind: "unquotable", detail: "the stub prices only the registry's listed assets, two different ones, at a size above zero" };
      const outUsd = request.sizeUsd * (1 - STUB_COST_BPS / 10_000);
      const units = (usd: number, price: number, decimals: number) => String(BigInt(Math.floor((usd / price) * 10 ** decimals)));
      const value: DryQuote = {
        from: request.from, to: request.to, amountInUsd: request.sizeUsd, amountOutUsd: outUsd, minAmountOutUsd: outUsd * 0.99,
        amountIn: units(request.sizeUsd, fromPrice, from.decimals), amountOut: units(outUsd, toPrice, to.decimals), at: now(),
      };
      return quoteProblems(value).length === 0 ? { ok: true, value, fetchedAt: value.at, stale: false } : { ok: false, kind: "unquotable", detail: "the size is under one unit" };
    },
  };
}
