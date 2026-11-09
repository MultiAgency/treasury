// Seeds Ballast's price history (#47, #221) so its 30-day EMA doesn't wait a month of ticks to warm up:
//
//   node src/seed-history.ts <TREASURY_REQUESTS_FILE>.history
//
// Reads the last 35 days of hourly USD closes from Coinbase Exchange's public candles (H5's history source, ADR 3; no
// key) for every sleeve asset the platform lists, checks them as the backtest does, and adds them to the file: one an
// hour, keeping any hour it already holds. The multi-sleeve book needs a history per sleeve, so wNEAR and ETH are both
// seeded; an asset the platform doesn't list is never seeded, and nothing is fetched for it. Run it with the server
// stopped, as the user the server runs as: the file is owner-only.

import { assetBySymbol, parseHistory, PROPOSAL_ASSETS, proposable } from "../../../packages/core/src/index.ts";
import { createPriceHistory } from "./ballast.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const path = process.argv[2];
if (!path) { console.error("usage: node src/seed-history.ts <history file>"); process.exit(2); }

/** Coinbase Exchange's product for each sleeve asset the registry carries, the same source H5 names. */
const PRODUCTS: Readonly<Record<string, string>> = { wNEAR: "NEAR-USD", ETH: "ETH-USD" };
const now = Date.now(), from = now - 35 * DAY;
const history = await createPriceHistory(path);

for (const [symbol, product] of Object.entries(PRODUCTS)) {
  const entry = assetBySymbol(symbol);
  if (!entry || !proposable(entry) || entry.id === null) continue;
  const rows: string[] = [];
  for (let start = from; start < now; start += 300 * HOUR) {
    const end = Math.min(start + 300 * HOUR, now);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const response = await fetch(url, { headers: { "user-agent": "treasury-seed-history" }, redirect: "error" });
    if (!response.ok) throw new Error(`Coinbase answered ${response.status} for ${product}`);
    // [time (s), low, high, open, close, volume]: the close is the hour's price.
    for (const candle of await response.json() as unknown[]) {
      if (Array.isArray(candle) && Number.isSafeInteger(candle[0]) && typeof candle[4] === "number") rows.push(`${candle[0] * 1000},${candle[4]}`);
    }
  }
  // The backtest's own checks, over a month: any unusable row, or an hour missing, refuses the whole asset's seed.
  const load = parseHistory(rows.join("\n"), { minSpanMs: 30 * DAY, maxGapMs: 2 * HOUR });
  if (!load.ok) throw new Error(`${symbol}: not seeded: ${load.problems.join("; ")}`);
  await history.seed(entry.id, load.samples, now);
  const seeded = history.of(entry.id);
  console.log(`${path}: ${seeded.length} hourly ${symbol} prices, ${new Date(seeded[0]!.at).toISOString()} to ${new Date(seeded.at(-1)!.at).toISOString()}`);
}
// wNEAR stays the two-asset book's asset; named so an empty history file is obvious in the log.
if (!history.of(PROPOSAL_ASSETS.wNEAR).length) throw new Error(`${path}: no wNEAR prices were seeded`);
