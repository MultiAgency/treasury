// Calibration report (A8.2): what a replay did, as data plus a readable summary, for H9. Pure and reproducible: the
// report contains no clock and no randomness, and carries a digest of the input so two runs can be compared. It lists
// every threshold the run used.

import type { ReplayConfig, ReplayResult, StepOutcome } from "./replay.ts";
import type { Sample } from "./smoothing.ts";

export type CalibrationReport = {
  /** FNV-1a digest of the series, the seed history and the configuration: equal digests mean equal inputs. */
  inputDigest: string;
  period: { from: number; to: number; samples: number };
  seedSamples: number;
  /** Every threshold and limit the run used (the whole configuration). */
  thresholds: ReplayConfig;
  outcomes: Record<StepOutcome, number>;
  /** Steps per band zone (all steps with a zone; frozen steps count as hold). */
  timePerZone: Record<string, number>;
  frozen: { total: number; warmingUp: number; other: Record<string, number> };
  rejectionsByRule: Record<string, number>;
  trades: { count: number; buys: number; sells: number; tradedUsd: number; avgSlippageBps: number | null };
  /** Largest fall from a peak of the whole-treasury value, in percent (0 when it never fell). */
  maxDrawdownPct: number;
  startValueUsd: number;
  endValueUsd: number;
  summary: string;
};

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export function maxDrawdownPct(equity: readonly { valueUsd: number }[]): number {
  let peak = 0, worst = 0;
  for (const p of equity) {
    if (!Number.isFinite(p.valueUsd)) continue;
    if (p.valueUsd > peak) peak = p.valueUsd;
    else if (peak > 0) worst = Math.max(worst, ((peak - p.valueUsd) / peak) * 100);
  }
  return worst;
}

export function calibrationReport(result: ReplayResult, series: readonly Sample[], config: ReplayConfig, seedHistory: readonly Sample[] = []): CalibrationReport {
  const outcomes: Record<StepOutcome, number> = { traded: 0, hold: 0, frozen: 0, rejected: 0, "needs-approval": 0, "fill-refused": 0 };
  const timePerZone: Record<string, number> = {};
  const frozen = { total: 0, warmingUp: 0, other: {} as Record<string, number> };
  const rejectionsByRule: Record<string, number> = {};
  for (const s of result.steps) {
    outcomes[s.outcome]++;
    bump(timePerZone, s.zone ?? "hold");
    if (s.outcome === "frozen") {
      frozen.total++;
      if (s.frozenReason === "warming-up") frozen.warmingUp++; else bump(frozen.other, s.frozenReason ?? "unknown");
    }
    if (s.outcome === "rejected") bump(rejectionsByRule, s.rule ?? "unknown");
  }
  const buys = result.trades.filter(t => t.action === "buy-volatile").length;
  const tradedUsd = result.trades.reduce((sum, t) => sum + t.sizeUsd, 0);
  const trades = {
    count: result.trades.length, buys, sells: result.trades.length - buys, tradedUsd,
    avgSlippageBps: result.trades.length === 0 ? null : result.trades.reduce((sum, t) => sum + t.slippageBps, 0) / result.trades.length,
  };
  const first = series[0], last = series[series.length - 1];
  const startValueUsd = result.equity[0]?.valueUsd ?? 0, endValueUsd = result.equity[result.equity.length - 1]?.valueUsd ?? 0;
  const drawdown = maxDrawdownPct(result.equity);
  const report: Omit<CalibrationReport, "summary"> = {
    inputDigest: fnv1a(JSON.stringify([series, seedHistory, config])),
    period: { from: first?.at ?? 0, to: last?.at ?? 0, samples: series.length },
    seedSamples: seedHistory.length, thresholds: config, outcomes, timePerZone, frozen, rejectionsByRule, trades,
    maxDrawdownPct: drawdown, startValueUsd, endValueUsd,
  };
  const lines = [
    `Replay of ${series.length} samples (${report.period.from} to ${report.period.to}), ${seedHistory.length} seed samples, input ${report.inputDigest}.`,
    `Steps: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Frozen: ${frozen.total} (warming up ${frozen.warmingUp}${Object.entries(frozen.other).map(([k, v]) => `, ${k} ${v}`).join("")}).`,
    `Zones: ${Object.entries(timePerZone).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Rejections by rule: ${Object.keys(rejectionsByRule).length === 0 ? "none" : Object.entries(rejectionsByRule).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Trades: ${trades.count} (${buys} buys, ${trades.sells} sells), ${trades.tradedUsd.toFixed(2)} USD traded, average slippage ${trades.avgSlippageBps === null ? "n/a" : trades.avgSlippageBps.toFixed(2) + " bps"}.`,
    `Treasury value ${startValueUsd.toFixed(2)} to ${endValueUsd.toFixed(2)} USD, max drawdown ${drawdown.toFixed(2)}%.`,
    `Thresholds used: see the report's \`thresholds\`; compare two runs by their digests and thresholds.`,
  ];
  return { ...report, summary: lines.join("\n") };
}
