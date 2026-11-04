// Band zones (A4.1): where the TWAP sits relative to the EMA reference decides trim, hold, DCA or buy halt.
// Pure. This step only classifies and names a direction; sizes are 0 until sizing.ts (A4.2) sets them, and
// whipsaw.ts (A4.3) can still turn an intent into a hold. Thresholds are the plan's defaults, awaiting H9.

import type { OracleReading } from "./oracle.ts";
import { isNum, report } from "./validate.ts";

export const BAND_DEFAULTS = {
  /** Percent above the reference where each trim starts. */
  trim: [15, 25, 40],
  /** Percent below the reference where each DCA buy starts (negative). */
  dca: [-15, -25, -35],
  /** At or below this percent, buying halts. */
  buyHalt: -45,
} as const;

export type Bands = { trim: readonly [number, number, number]; dca: readonly [number, number, number]; buyHalt: number };

export type BandZone = "trim-3" | "trim-2" | "trim-1" | "hold" | "dca-1" | "dca-2" | "dca-3" | "buy-halt";
export type IntentAction = "hold" | "sell-volatile" | "buy-volatile";

export type Intent = {
  id: string;
  zone: BandZone;
  action: IntentAction;
  /** Size in USD; 0 for a hold. */
  sizeUsd: number;
  /** DCA units this intent spends (fractional when a cap trims the size); 0 otherwise. */
  dcaUnits: number;
  reason: string;
  at: number;
};

/**
 * The zone for a TWAP against its EMA reference, or null when either price is unusable.
 * Boundaries are inclusive towards action on the sell side and the buy side (trim-1 at ≥ +15%, dca-1 at ≤ −15%, buy halt
 * at ≤ −45%), so hold is strictly inside ±15%, and nothing is bought at the halt boundary. Compared without dividing
 * (diff × 100 against threshold × ema). Prices that are exact in binary (like 115 vs 100) land exactly on a threshold;
 * a decimal such as 1.15 vs 1 is already inexact as a float, so a real price "exactly" on a line may fall on either side.
 */
/** What is wrong with the thresholds, if anything: trims rise above zero, DCA lines fall below zero, and buy halt is the lowest. */
export function bandProblems(b: Bands): string[] {
  const r = report();
  // Read the shape before the values: a missing or short threshold list is reported, never a TypeError.
  const three = (x: unknown): x is readonly [number, number, number] => Array.isArray(x) && x.length === 3;
  if (typeof b !== "object" || b === null) { r.need(false, "band thresholds are missing"); return r.problems; }
  r.need(three(b.trim), "trim thresholds must be a list of three");
  r.need(three(b.dca), "DCA thresholds must be a list of three");
  if (!three(b.trim) || !three(b.dca)) return r.problems;
  const t = b.trim, d = b.dca;
  r.need(t.every(isNum) && t[0] > 0 && t[1] > t[0] && t[2] > t[1], "trim thresholds must be positive and rising");
  r.need(d.every(isNum) && d[0] < 0 && d[1] < d[0] && d[2] < d[1], "DCA thresholds must be negative and falling");
  r.need(isNum(b.buyHalt) && b.buyHalt < 0 && (!isNum(d[2]) || b.buyHalt <= d[2]), "buy halt must be negative and at or below the last DCA threshold");
  return r.problems;
}

export function classifyZone(twap: number, ema: number, bands: Bands = BAND_DEFAULTS): BandZone | null {
  if (bandProblems(bands).length > 0) return null;
  if (!Number.isFinite(twap) || !Number.isFinite(ema) || twap <= 0 || ema <= 0) return null;
  const diff = (twap - ema) * 100;
  if (diff <= bands.buyHalt * ema) return "buy-halt";
  if (diff >= bands.trim[2] * ema) return "trim-3";
  if (diff >= bands.trim[1] * ema) return "trim-2";
  if (diff >= bands.trim[0] * ema) return "trim-1";
  if (diff <= bands.dca[2] * ema) return "dca-3";
  if (diff <= bands.dca[1] * ema) return "dca-2";
  if (diff <= bands.dca[0] * ema) return "dca-1";
  return "hold";
}

/** Percent distance of the TWAP from the EMA reference; null when unusable. For reports and re-arming, not for zones. */
export function deviationPct(twap: number, ema: number): number | null {
  if (!Number.isFinite(twap) || !Number.isFinite(ema) || ema <= 0 || twap <= 0) return null;
  return ((twap - ema) / ema) * 100;
}

const ACTION: Record<BandZone, IntentAction> = {
  "trim-3": "sell-volatile", "trim-2": "sell-volatile", "trim-1": "sell-volatile",
  hold: "hold", "buy-halt": "hold",
  "dca-1": "buy-volatile", "dca-2": "buy-volatile", "dca-3": "buy-volatile",
};

const hold = (reading: OracleReading, zone: BandZone, reason: string): Intent =>
  ({ id: `p-${reading.at}`, zone, action: "hold", sizeUsd: 0, dcaUnits: 0, reason, at: reading.at });

/** The zone's direction as an intent with no size yet. A frozen reading or an unusable price always holds. */
export function intentForZone(reading: OracleReading, bands: Bands = BAND_DEFAULTS): Intent {
  if (reading.frozen) return hold(reading, "hold", `oracle frozen: ${reading.reason}`);
  const badBands = bandProblems(bands);
  if (badBands.length > 0) return hold(reading, "hold", `invalid band configuration: ${badBands.join("; ")}`);
  const zone = classifyZone(reading.twap15m, reading.ema30d, bands);
  if (zone === null) return hold(reading, "hold", "no usable TWAP or EMA reference");
  const action = ACTION[zone];
  if (action === "hold") return hold(reading, zone, zone === "buy-halt" ? "buying halted: price far below the reference" : "inside the hold band");
  return { id: `p-${reading.at}`, zone, action, sizeUsd: 0, dcaUnits: 0, reason: `${zone}: TWAP ${reading.twap15m} vs reference ${reading.ema30d}`, at: reading.at };
}
