// #221's backtest: the two-asset book (wNEAR/USDC) against the diversified book (wNEAR and ETH sleeves), over the same
// deterministic, seeded synthetic history. No network, no clock, no randomness beyond the seeds, so the report can be
// rebuilt byte for byte:
//
//   pnpm backtest:diversified [output.md]
//
// The default output is docs/diversified-backtest.md. The history is a placeholder, not market data: syntheticSeries is
// a seeded random walk (HISTORY.md), so the numbers show that the two runs are the same harness with different sleeves
// and caps, not what either book would have returned. BTC is not a run: the platform's proposal assets don't include it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bookCalibrationReport, calibrationReport, PROFILE_DEFAULTS, REPLAY_DEFAULTS, syntheticSeries, VENUE_IDS, warmupHistory,
  type BookFill, type BookReplayConfig, type ReplayConfig, type Sample,
} from "../packages/core/src/index.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** A fixed start, so the series never depends on when it runs. */
const T0 = Date.UTC(2025, 8, 25);
const COUNT = 365 * 24;
const START = { volatileUsd: 40_000, reserveUsd: 35_000, cashUsd: 25_000 };

const near = syntheticSeries({ startAt: T0, startPrice: 100, count: COUNT, stepMs: HOUR, stepVolPct: 2.5, driftPct: 0, seed: 3 });
const eth = syntheticSeries({ startAt: T0, startPrice: 2_500, count: COUNT, stepMs: HOUR, stepVolPct: 2, driftPct: 0, seed: 11 });
const seed = {
  wNEAR: warmupHistory(near[0]!, 35 * DAY, HOUR, 2.5, 5),
  ETH: warmupHistory(eth[0]!, 35 * DAY, HOUR, 2, 13),
};

const balanced = PROFILE_DEFAULTS.balanced;
/** The two-asset book as H9 ran it: 40% volatile in wNEAR, 35% reserve and 25% cash, the account capped at 50%. */
const single: ReplayConfig = {
  ...REPLAY_DEFAULTS, bounds: balanced.bounds,
  policy: { ...REPLAY_DEFAULTS.policy, limits: balanced.limits, exposure: { ...REPLAY_DEFAULTS.policy.exposure, maxVenueExposurePct: balanced.bounds.volatileMaxPct, monthlySpendUsd: 2_000 } },
};
/** The diversified book: 20% in each sleeve and the same reserve and cash, the account at 50% and the Ethereum bridge at 25%. */
const diversified: BookReplayConfig = {
  ...single,
  sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
  volatileMaxPct: balanced.bounds.volatileMaxPct,
  venueCapsPct: { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: 25 },
  classCapsPct: { volatile: balanced.bounds.volatileMaxPct, stable: 100 },
};

/** The largest exposure each venue carries after any fill, and whether any fill took one over its cap. */
function venuePeaks(trades: readonly BookFill[], series: Record<string, readonly Sample[]>, caps: Record<string, number>) {
  const qty: Record<string, number> = { wNEAR: START.volatileUsd / 2 / near[0]!.price, ETH: START.volatileUsd / 2 / eth[0]!.price };
  let reserve = START.reserveUsd;
  const priceAt = (asset: string, at: number) => series[asset]?.find(x => x.at === at)?.price ?? 0;
  const peak: Record<string, number> = { [VENUE_IDS.intents]: 0, [VENUE_IDS.omftEthereum]: 0 };
  const breaches: string[] = [];
  for (const fill of trades) {
    if (fill.action === "buy-volatile") { qty[fill.asset] = (qty[fill.asset] ?? 0) + fill.quantity; reserve -= fill.sizeUsd; }
    else { qty[fill.asset] = (qty[fill.asset] ?? 0) - fill.quantity; reserve += fill.quantity * fill.fillPrice; }
    const value = (asset: string) => (qty[asset] ?? 0) * priceAt(asset, fill.at);
    const risk = value("wNEAR") + value("ETH"), treasury = risk + reserve + START.cashUsd;
    for (const [venue, held] of [[VENUE_IDS.intents, risk], [VENUE_IDS.omftEthereum, value("ETH")]] as const) {
      const pct = treasury > 0 ? (held / treasury) * 100 : 0;
      peak[venue] = Math.max(peak[venue] ?? 0, pct);
      if (pct > (caps[venue] ?? 0) + 1e-9) breaches.push(`${venue} at ${pct.toFixed(2)}% over ${caps[venue]}% at ${fill.at}`);
    }
  }
  return { peak, breaches };
}

function tradesByAsset(byAsset: Record<string, number>) {
  return Object.entries(byAsset).sort().map(([asset, count]) => `${asset} ${count}`).join(", ") || "none";
}

const legacy = calibrationReport({ series: near, seedHistory: seed.wNEAR, start: { ...START }, config: single });
if (!legacy.ok) throw new Error(legacy.problems.join("; "));
const book = bookCalibrationReport({ series: { wNEAR: near, ETH: eth }, seedHistory: seed, start: { volatileUsd: { wNEAR: 20_000, ETH: 20_000 }, reserveUsd: START.reserveUsd, cashUsd: START.cashUsd }, config: diversified });
if (!book.ok) throw new Error(book.problems.join("; "));

const peaks = venuePeaks(book.fills, { wNEAR: near, ETH: eth }, diversified.venueCapsPct);
if (peaks.breaches.length > 0) throw new Error(`a fill went over a venue cap: ${peaks.breaches.join("; ")}`);

const lines = [
  "# The diversified book's backtest (#221)",
  "",
  "Two runs of the same engine and the same synthetic history: the two-asset book the app shipped with (wNEAR, USDC)",
  "against the diversified book (wNEAR and ETH sleeves, each 20% of the treasury, under per-venue caps). It is generated by",
  "`pnpm backtest:diversified`, which replays the seeded history below in-process: no network, no clock, no randomness",
  "beyond the seeds, so the same command writes this same page.",
  "",
  "> **The history is deterministic synthetic placeholder data, not real market history.** `syntheticSeries` is a seeded",
  "> random walk (see [`packages/core/HISTORY.md`](../packages/core/HISTORY.md)); its numbers say the two runs are the same",
  "> harness with different sleeves and caps, not what either book would have returned. H9's real-data calibration is in",
  "> [ADR 3](adr/0003-engine-parameters.md); a run on real Coinbase candles is a separate step, and this script has no",
  "> network access by design.",
  "",
  "## Inputs",
  "",
  "| Run | Assets | Series | Seed | Start | Input digest |",
  "| --- | --- | --- | --- | --- | --- |",
  `| Two-asset | wNEAR, USDC | ${COUNT} hourly samples from ${new Date(T0).toISOString()}, ${seed.wNEAR.length} warm-up | wNEAR 3, warm-up 5 | ${START.volatileUsd.toLocaleString("en-US")} volatile / ${START.reserveUsd.toLocaleString("en-US")} reserve / ${START.cashUsd.toLocaleString("en-US")} cash | \`${legacy.inputDigest}\` |`,
  `| Diversified | wNEAR, ETH, USDC | wNEAR above; ETH ${COUNT} samples from the same instant, start 2,500, seed 11 | ETH 11, warm-up 13 | 20,000 each sleeve / ${START.reserveUsd.toLocaleString("en-US")} reserve / ${START.cashUsd.toLocaleString("en-US")} cash | \`${book.inputDigest}\` |`,
  "",
  "The balanced profile at 100,000 USD: volatile 40 / reserve 35 / cash 25, an order cap of 2% and a floor of 12,000 USD",
  "(2,000 a month for six months). The account venue is capped at 50% in both runs; the diversified run adds the",
  "Ethereum bridge at 25%. The two-asset run's one sleeve is wNEAR at 40% within 10–50%; the diversified run's two",
  "sleeves are 20% each within 5–25%, so the book's volatile ceiling is the same 50%.",
  "",
  "## Results",
  "",
  "| Run | Start value | Final value | Max drawdown | Trades | Trades per asset | Rejections by rule |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  `| Two-asset (wNEAR/USDC) | ${legacy.startValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD | ${legacy.endValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD | ${legacy.maxDrawdownPct.toFixed(2)}% | ${legacy.trades.count} (${legacy.trades.buys} buys, ${legacy.trades.sells} sells) | ${tradesByAsset({ wNEAR: legacy.trades.count })} | ${Object.entries(legacy.rejectionsByRule).sort().map(([rule, n]) => `${rule} ${n}`).join(", ") || "none"} |`,
  `| Diversified (wNEAR+ETH/USDC) | ${book.startValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD | ${book.endValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD | ${book.maxDrawdownPct.toFixed(2)}% | ${book.trades.count} (${book.trades.buys} buys, ${book.trades.sells} sells) | ${tradesByAsset(book.trades.byAsset)} | ${Object.entries(book.rejectionsByRule).sort().map(([rule, n]) => `${rule} ${n}`).join(", ") || "none"} |`,
  "",
  `Difference in max drawdown: **${(legacy.maxDrawdownPct - book.maxDrawdownPct).toFixed(2)} points** (diversified less two-asset).`,
  `Difference in final value: **${(book.endValueUsd - legacy.endValueUsd).toFixed(2)} USD**.`,
  "",
  "Both runs are the same seeded provider (5–15 bps of slippage a fill, no fees) and the same band, sizing and policy",
  "engines. The single-sleeve equivalence is held by a core test: one wNEAR sleeve in the book harness makes exactly the",
  "trades and equity `calibrationReport` makes on the same series. As the server proposes at most one trade a tick, the",
  "diversified run proposes at most one an hourly instant: the first sleeve that passes, sells first.",
  "",
  "## Venue caps",
  "",
  `The diversified run's caps are the account at ${diversified.venueCapsPct[VENUE_IDS.intents]}% of the treasury and the Ethereum bridge at ${diversified.venueCapsPct[VENUE_IDS.omftEthereum]}%.`,
  "`checkBookExposure` runs before every fill; the largest exposure after any fill was:",
  "",
  "| Venue | Peak exposure | Cap | Over the cap |",
  "| --- | --- | --- | --- |",
  `| NEAR Intents account | ${(peaks.peak[VENUE_IDS.intents] ?? 0).toFixed(2)}% | ${diversified.venueCapsPct[VENUE_IDS.intents]}% | no |`,
  `| Ethereum bridge (omft) | ${(peaks.peak[VENUE_IDS.omftEthereum] ?? 0).toFixed(2)}% | ${diversified.venueCapsPct[VENUE_IDS.omftEthereum]}% | no |`,
  "",
  "The script refuses to write the page if any fill would have taken a venue over its cap.",
  "",
  "## What this doesn't show",
  "",
  "- **Not market history.** The walk is a placeholder; a lower drawdown here is a property of this seed's two independent",
  "  walks, not evidence that ETH diversifies wNEAR in a real book.",
  "- **Phase 1 isn't complete.** ETH is the only cross-chain major among the platform's proposal assets. BTC is in the",
  "  registry but not proposable, so a book with two cross-chain majors can't be traded until the platform lists it.",
  "- **No stablecoin split or RWA.** The platform lists one stablecoin (USDC) and no tokenized T-bill, so both runs hold",
  "  USDC and the RWA sleeve is off: the backtest can't exercise phases 2 and 3.",
  "- **No fees, no funding costs, no taxes,** and the same optimistic 5–15 bps fill model as the single-asset replay.",
  "- **No approval latency.** Every proposal that passes the checks fills at its own instant, as if the owner approved at",
  "  once; a live trade waits for the owner's signature or the DAO's vote, at a later price or not at all.",
  "",
];

const output = process.argv[2] ?? join("docs", "diversified-backtest.md");
writeFileSync(output, lines.join("\n"));
console.log(`wrote ${output}: two-asset drawdown ${legacy.maxDrawdownPct.toFixed(2)}%, diversified ${book.maxDrawdownPct.toFixed(2)}%`);
