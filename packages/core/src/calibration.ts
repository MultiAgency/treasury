// Calibration report (A8.2): what a replay did, as data plus a readable summary, for H9. Pure and reproducible: the
// report runs the replay itself from one inputs object, so what it reports and digests is what ran. It contains no clock
// and no randomness, carries a digest of the inputs so two runs can be compared, and lists every threshold the run used.

import { canonicalJson, sha256Hex } from "./digest.ts";
import { replay, type ReplayConfig, type StepOutcome } from "./replay.ts";
import type { Portfolio } from "./sizing.ts";
import type { Sample } from "./smoothing.ts";

/**
 * Everything a calibration run depends on. The regime is always the replay's default: a regime function can't be
 * digested, so a calibration doesn't take one.
 */
export type CalibrationInputs = {
  series: readonly Sample[];
  /** Pre-history that warms the EMA up; empty for a cold start. */
  seedHistory: readonly Sample[];
  start: Portfolio;
  config: ReplayConfig;
};

export type CalibrationReport = {
  /** SHA-256 of the inputs as canonical JSON (keys sorted): equal digests mean equal inputs. */
  inputDigest: string;
  /** The regime the run used: the replay's default, the only one a calibration runs. */
  regime: "replay default";
  period: { from: number; to: number; samples: number };
  seedSamples: number;
  start: Portfolio;
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

/** A report, or the replay's refusal with its problems: a refused run has no numbers to report. */
export type CalibrationResult = { ok: false; problems: string[] } | ({ ok: true } & CalibrationReport);

/** Replays the inputs with the replay's default regime and reports the run. */
export function calibrationReport(inputs: CalibrationInputs): CalibrationResult {
  const { series, seedHistory, start, config } = inputs;
  const result = replay(series, start, config, undefined, seedHistory);
  if (!result.ok) return result;
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
    inputDigest: sha256Hex(canonicalJson({ series, seedHistory, start, config })), regime: "replay default",
    period: { from: first?.at ?? 0, to: last?.at ?? 0, samples: series.length },
    seedSamples: seedHistory.length, start, thresholds: config, outcomes, timePerZone, frozen, rejectionsByRule, trades,
    maxDrawdownPct: drawdown, startValueUsd, endValueUsd,
  };
  const lines = [
    `Replay of ${series.length} samples (${report.period.from} to ${report.period.to}), ${seedHistory.length} seed samples, regime: replay default, input ${report.inputDigest}.`,
    `Steps: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Frozen: ${frozen.total} (warming up ${frozen.warmingUp}${Object.entries(frozen.other).map(([k, v]) => `, ${k} ${v}`).join("")}).`,
    `Zones: ${Object.entries(timePerZone).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Rejections by rule: ${Object.keys(rejectionsByRule).length === 0 ? "none" : Object.entries(rejectionsByRule).sort().map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Trades: ${trades.count} (${buys} buys, ${trades.sells} sells), ${trades.tradedUsd.toFixed(2)} USD traded, average slippage ${trades.avgSlippageBps === null ? "n/a" : trades.avgSlippageBps.toFixed(2) + " bps"}.`,
    `Treasury value ${startValueUsd.toFixed(2)} to ${endValueUsd.toFixed(2)} USD, max drawdown ${drawdown.toFixed(2)}%.`,
    `Thresholds used: see the report's \`thresholds\`; compare two runs by their digests and thresholds.`,
  ];
  return { ok: true, ...report, summary: lines.join("\n") };
}
