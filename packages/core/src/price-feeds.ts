// The price sources' tickers (H5, ADR 3): where each venue's public, keyless USD ticker is read, and how its answer
// becomes one quote. Pure: the server does the reading (`apps/server/src/prices.ts`), this only builds the URL and parses
// what came back. An answer that isn't exactly the one market's ticker, with a finite price above zero, is no quote:
// the oracle then has fewer than three and freezes, which is how a source that's down, renamed or reformatted fails.
//
// Each venue was read live on 2026-11-11. Coinbase and Bitstamp date their ticker; Kraken, Gemini and Bitfinex don't
// (Gemini's `volume.timestamp` is its volume window's, not a trade's), so those are dated by the read and the oracle's
// staleness and skew limits cover them.

export const PRICE_VENUES = ["coinbase", "kraken", "bitstamp", "gemini", "bitfinex"] as const;
export type PriceVenue = (typeof PRICE_VENUES)[number];
/** One venue's market for an asset, in the venue's own spelling (`NEAR-USD`, `NEARUSD`, `nearusd`, `tXAUT:USD`). */
export type PriceFeed = { venue: PriceVenue; market: string };
export type Ticker = { price: number; observedAt: number };

const url: Record<PriceVenue, (market: string) => string> = {
  coinbase: m => `https://api.exchange.coinbase.com/products/${m}/ticker`,
  kraken: m => `https://api.kraken.com/0/public/Ticker?pair=${m}`,
  bitstamp: m => `https://www.bitstamp.net/api/v2/ticker/${m}/`,
  gemini: m => `https://api.gemini.com/v1/pubticker/${m}`,
  bitfinex: m => `https://api-pub.bitfinex.com/v2/ticker/${m}`,
};

/** Where a feed's ticker is read: always HTTPS on the venue's own host, the market escaped so it can't leave its path. */
export const feedUrl = (feed: PriceFeed): string => url[feed.venue](encodeURIComponent(feed.market));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A decimal price as the venues write it (digits, an optional fraction, nothing else), or NaN. */
const decimal = (v: unknown): number => typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
/** An ISO time, or NaN; fractions past milliseconds (Coinbase gives nanoseconds) are cut, not rounded. */
const isoTime = (v: unknown): number =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) ? Date.parse(v.replace(/(\.\d{3})\d+Z$/, "$1Z")) : Number.NaN;
/** Whole Unix seconds, as Bitstamp writes them, in ms; or NaN. */
const seconds = (v: unknown): number => typeof v === "string" && /^\d+$/.test(v) ? Number(v) * 1000 : Number.NaN;

/** One venue's answer as a quote, or null when it isn't this market's ticker with a usable price. */
export function parseTicker(feed: PriceFeed, body: unknown, readAt: number): Ticker | null {
  const ticker = ((): Ticker => {
    switch (feed.venue) {
      case "coinbase": return isRecord(body) ? { price: decimal(body.price), observedAt: isoTime(body.time) } : { price: Number.NaN, observedAt: readAt };
      case "kraken": {
        // One pair asked, so exactly one answered: Kraken names it its own way (ETHUSD comes back as XETHZUSD). Any error is no quote.
        const rows = isRecord(body) && Array.isArray(body.error) && body.error.length === 0 && isRecord(body.result) ? Object.values(body.result) : [];
        const c = rows.length === 1 && isRecord(rows[0]) && Array.isArray(rows[0].c) ? rows[0].c[0] : undefined;
        return { price: decimal(c), observedAt: readAt };
      }
      // An unknown pair is answered with 200 and every pair's ticker in an array: only a single object is this market's.
      case "bitstamp": return isRecord(body) ? { price: decimal(body.last), observedAt: seconds(body.timestamp) } : { price: Number.NaN, observedAt: readAt };
      case "gemini": return { price: isRecord(body) ? decimal(body.last) : Number.NaN, observedAt: readAt };
      // A bare array: [bid, bid size, ask, ask size, daily change, relative change, last price, volume, high, low, …].
      case "bitfinex": return { price: Array.isArray(body) && body.length >= 10 && typeof body[6] === "number" ? body[6] : Number.NaN, observedAt: readAt };
    }
  })();
  return Number.isFinite(ticker.price) && ticker.price > 0 && Number.isFinite(ticker.observedAt) ? ticker : null;
}
