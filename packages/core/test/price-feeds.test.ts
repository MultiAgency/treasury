import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, proposable } from "../src/assets.ts";
import { feedUrl, parseTicker, PRICE_VENUES, type PriceFeed } from "../src/price-feeds.ts";

const READ_AT = Date.parse("2026-11-11T17:35:30.000Z");

// Each venue's answer as read live on 2026-11-11, trimmed to the fields that matter plus one it ignores.
const LIVE: Record<string, { feed: PriceFeed; body: unknown; price: number; observedAt: number }> = {
  coinbase: {
    feed: { venue: "coinbase", market: "NEAR-USD" },
    body: { ask: "3.7654", bid: "3.7634", volume: "8191886.746", trade_id: 36468596, price: "3.767", size: "1.291", time: "2026-11-11T17:35:24.037357427Z" },
    price: 3.767, observedAt: Date.parse("2026-11-11T17:35:24.037Z"),
  },
  kraken: {
    // Kraken answers under its own name for the pair: ETHUSD comes back as XETHZUSD.
    feed: { venue: "kraken", market: "ETHUSD" },
    body: { error: [], result: { XETHZUSD: { a: ["2088.06000", "2", "2.000"], b: ["2088.05000", "1", "1.000"], c: ["2088.36000", "0.06800000"], o: "2050.65000" } } },
    price: 2088.36, observedAt: READ_AT,
  },
  bitstamp: {
    feed: { venue: "bitstamp", market: "nearusd" },
    body: { timestamp: "1794418544", open: "3.58529", last: "3.76210", volume: "514006.784", bid: "3.76073", ask: "3.76304", market_type: "SPOT" },
    price: 3.7621, observedAt: 1794418544_000,
  },
  gemini: {
    feed: { venue: "gemini", market: "usdcusd" },
    body: { bid: "0.99970", ask: "0.99971", last: "0.99971", volume: { USD: "2260096.84", USDC: "2260752.46", timestamp: 1794418680000 } },
    price: 0.99971, observedAt: READ_AT,
  },
  bitfinex: {
    feed: { venue: "bitfinex", market: "tXAUT:USD" },
    body: [3995.1, 138.12629315, 3995.5, 34.07523945, -16.2, -0.00403879, 3994.9, 329.09819243, 4056.5, 3991.3, 1579876507760],
    price: 3994.9, observedAt: READ_AT,
  },
};

test("each venue's live ticker parses to its last price, dated by the venue where it says when, else by the read", () => {
  for (const [venue, { feed, body, price, observedAt }] of Object.entries(LIVE))
    assert.deepEqual(parseTicker(feed, body, READ_AT), { price, observedAt }, venue);
});

test("every venue's URL is HTTPS on the venue's own host", () => {
  assert.equal(feedUrl({ venue: "coinbase", market: "NEAR-USD" }), "https://api.exchange.coinbase.com/products/NEAR-USD/ticker");
  assert.equal(feedUrl({ venue: "kraken", market: "NEARUSD" }), "https://api.kraken.com/0/public/Ticker?pair=NEARUSD");
  assert.equal(feedUrl({ venue: "bitstamp", market: "nearusd" }), "https://www.bitstamp.net/api/v2/ticker/nearusd/");
  assert.equal(feedUrl({ venue: "gemini", market: "usdcusd" }), "https://api.gemini.com/v1/pubticker/usdcusd");
  assert.equal(feedUrl({ venue: "bitfinex", market: "tXAUT:USD" }), "https://api-pub.bitfinex.com/v2/ticker/tXAUT%3AUSD");
  assert.equal(feedUrl({ venue: "coinbase", market: "../../x" }), "https://api.exchange.coinbase.com/products/..%2F..%2Fx/ticker", "a market can't leave its path");
});

test("an answer that isn't the one market's ticker is no quote, never a guess", () => {
  const bad: [PriceFeed, unknown][] = [
    // Bitstamp answers an unknown pair with 200 and every pair's ticker, BTC's first: that is no quote for this one.
    [{ venue: "bitstamp", market: "nopeusd" }, [{ timestamp: "1794418739", last: "74409.03" }, { timestamp: "1794418739", last: "3.76" }]],
    [{ venue: "kraken", market: "NOPEUSD" }, { error: ["EQuery:Unknown asset pair"] }],
    [{ venue: "kraken", market: "NEARUSD" }, { error: ["EGeneral:Too many requests"], result: { NEARUSD: { c: ["3.76", "1"] } } }],
    [{ venue: "kraken", market: "NEARUSD" }, { error: [], result: { NEARUSD: { c: ["3.76", "1"] }, ETHUSD: { c: ["2088", "1"] } } }],
    [{ venue: "coinbase", market: "NEAR-USD" }, { message: "NotFound" }],
    [{ venue: "coinbase", market: "NEAR-USD" }, { price: "3.767" }],
    [{ venue: "coinbase", market: "NEAR-USD" }, { price: "3.767", time: "yesterday" }],
    [{ venue: "bitfinex", market: "tNOPE:USD" }, ["error", 10020, "symbol: invalid"]],
    [{ venue: "bitfinex", market: "tXAUT:USD" }, [1, 2, 3]],
    [{ venue: "gemini", market: "nopeusd" }, "'nopeusd' does not have available data yet"],
  ];
  for (const [feed, body] of bad) assert.equal(parseTicker(feed, body, READ_AT), null, JSON.stringify(body));
  for (const price of ["0", "-1", "NaN", "Infinity", "1e400", "", " 3.7", "3,7", "0x10"])
    assert.equal(parseTicker(LIVE.coinbase!.feed, { price, time: "2026-11-11T17:35:24Z" }, READ_AT), null, price);
  assert.equal(parseTicker(LIVE.bitstamp!.feed, { last: "3.76", timestamp: "soon" }, READ_AT), null);
});

test("every asset the platform can propose has three fetchable sources on three different venues", () => {
  const tradable = Object.values(ASSET_REGISTRY).filter(proposable);
  assert.ok(tradable.length > 0);
  for (const entry of Object.values(ASSET_REGISTRY).filter(e => e.id !== null)) {
    const feeds = entry.priceSources.map(s => s.feed);
    assert.ok(feeds.every(f => f !== undefined && PRICE_VENUES.includes(f.venue)), `${entry.symbol}: every source is fetchable`);
    assert.equal(new Set(feeds.map(f => f!.venue)).size, 3, `${entry.symbol}: three different venues`);
  }
});
