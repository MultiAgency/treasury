// H9's calibration run (ADR 3): a year of hourly NEAR-USD through the engine, with the decided defaults, against buy-and-hold.
//
//   node scripts/calibrate.ts fetch near-usd-1h.csv   # Coinbase Exchange public candles, 2025-09-25 to 2026-11-05 (no key)
//   node scripts/calibrate.ts run near-usd-1h.csv     # the report ADR 3 quotes, with the CSV's SHA-256
//
// The CSV isn't committed: it's re-fetched, and its digest says whether it's the same data. Closed hourly candles don't change.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { calibrationReport, detectMarketMoves, highestLevel, parseHistory, PROFILE_DEFAULTS, REPLAY_DEFAULTS, type ReplayConfig, type Sample } from "../packages/core/src/index.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const FROM = Date.UTC(2025, 8, 25), TO = Date.UTC(2026, 10, 5);

async function fetchCandles(path: string) {
  const prices = new Map<number, string>();
  for (let start = FROM; start < TO; start += 300 * HOUR) {
    const end = Math.min(start + 300 * HOUR, TO);
    const url = `https://api.exchange.coinbase.com/products/NEAR-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const response = await fetch(url, { headers: { "user-agent": "treasury-calibrate" } });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    // [time (s), low, high, open, close, volume]: the close is the hour's price.
    for (const [time, , , , close] of await response.json() as number[][]) prices.set(time! * 1000, String(close));
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  const rows = [...prices].sort(([a], [b]) => a - b).map(([at, price]) => `${at},${price}`);
  writeFileSync(path, `timestamp,price\n${rows.join("\n")}\n`);
  console.log(`${rows.length} hourly prices written to ${path}`);
}

function run(path: string) {
  const text = readFileSync(path, "utf8");
  const load = parseHistory(text);
  if (!load.ok) throw new Error(load.problems.join("; "));
  // The first 35 days warm the 30-day EMA up; the replay runs on the rest, a year and more.
  const cut = load.samples[0]!.at + 35 * DAY;
  const seedHistory = load.samples.filter(s => s.at < cut), series = load.samples.filter(s => s.at >= cut);
  const balanced = PROFILE_DEFAULTS.balanced;
  // The balanced profile at 100,000 USD (40 / 35 / 25), spending 2,000 a month: a 12,000 floor under 25,000 of cash.
  const start = { volatileUsd: 40_000, reserveUsd: 35_000, cashUsd: 25_000 };
  const config: ReplayConfig = {
    ...REPLAY_DEFAULTS, bounds: balanced.bounds,
    policy: { ...REPLAY_DEFAULTS.policy, limits: balanced.limits, exposure: { ...REPLAY_DEFAULTS.policy.exposure, maxVenueExposurePct: balanced.bounds.volatileMaxPct, monthlySpendUsd: 2_000 } },
  };
  console.log(`CSV sha256 ${createHash("sha256").update(text).digest("hex")}`);
  for (const [label, part] of halves(series)) {
    const seed = label === "year" || label === "first half" ? seedHistory : load.samples.filter(s => s.at < part[0]!.at).slice(-35 * 24);
    const report = calibrationReport({ series: part, seedHistory: seed, start, config });
    if (!report.ok) throw new Error(report.problems.join("; "));
    const hold = buyAndHold(part, start);
    console.log(`\n## ${label}\n${report.summary}\nBuy-and-hold: ${hold.end.toFixed(2)} USD, max drawdown ${hold.drawdownPct.toFixed(2)}%.`);
  }
  // How often each detector holds trading, judged on hourly samples as the replay sees them.
  const levels = [0, 0, 0, 0, 0], fired: Record<string, number> = {};
  series.forEach((sample, i) => {
    const found = detectMarketMoves([...seedHistory.slice(-48), ...series.slice(Math.max(0, i - 48), i + 1)], sample.at);
    levels[highestLevel(found)]!++;
    for (const d of found) fired[d.detector] = (fired[d.detector] ?? 0) + 1;
  });
  console.log(`\nDetector hours: ${JSON.stringify(fired)}; highest level: ${levels.map((n, l) => `L${l} ${(n / series.length * 100).toFixed(1)}%`).join(", ")}.`);
}

function halves(series: Sample[]): [string, Sample[]][] {
  const mid = series[0]!.at + 183 * DAY;
  return [["year", series], ["first half", series.filter(s => s.at < mid)], ["second half", series.filter(s => s.at >= mid)]];
}

function buyAndHold(series: Sample[], start: { volatileUsd: number; reserveUsd: number; cashUsd: number }) {
  const units = start.volatileUsd / series[0]!.price, rest = start.reserveUsd + start.cashUsd;
  let peak = 0, drawdownPct = 0;
  for (const { price } of series) {
    const value = units * price + rest;
    peak = Math.max(peak, value);
    drawdownPct = Math.max(drawdownPct, (peak - value) / peak * 100);
  }
  return { end: units * series.at(-1)!.price + rest, drawdownPct };
}

const [mode, path = "near-usd-1h.csv"] = process.argv.slice(2);
if (mode === "fetch") await fetchCandles(path);
else if (mode === "run") run(path);
else console.error("usage: node scripts/calibrate.ts fetch|run <csv>");
