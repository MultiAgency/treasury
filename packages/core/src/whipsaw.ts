// Anti-whipsaw and regime check (A4.3): stops the engine trading repeatedly on noise. Pure: the last action, the clock
// and the regime are passed in, and the next state is returned, never stored here. Numbers are named defaults awaiting
// H6/H9; the regime comes from the edge-case detectors (A6) and must be stated by the caller (fail closed).

import { BAND_DEFAULTS, bandProblems, type Bands, type BandZone, type Intent, type IntentAction } from "./bands.ts";
import { isNonNegative, report } from "./validate.ts";

export const WHIPSAW_DEFAULTS = {
  /** No new action sooner than this after the last one. */
  cooldownMs: 60 * 60_000,
  /** The opposite direction is locked out this long after an action. */
  reversalLockMs: 24 * 3_600_000,
  /** After an action in a zone, that zone stays disarmed until the deviation retreats this many percent inside its line. */
  hysteresisPct: 2,
} as const;

export type WhipsawLimits = { cooldownMs: number; reversalLockMs: number; hysteresisPct: number };

/** `normal` is the only regime the engine trades in; any other holds. */
export type Regime = "normal" | "fast-move" | "thin-liquidity" | "source-stress" | "system-fault";

export type WhipsawState = {
  lastActionAt?: number;
  lastAction?: Exclude<IntentAction, "hold">;
  /** The zone just traded; it can't trade again until the deviation retreats past the hysteresis. */
  disarmed?: BandZone;
};

/** What is wrong with the limits, if anything. */
export function whipsawProblems(l: WhipsawLimits): string[] {
  const r = report();
  r.need(isNonNegative(l.cooldownMs), "cooldownMs must be zero or more");
  r.need(isNonNegative(l.reversalLockMs), "reversalLockMs must be zero or more");
  r.need(isNonNegative(l.hysteresisPct) && l.hysteresisPct <= 100, "hysteresisPct must be between 0 and 100");
  return r.problems;
}

const hold = (p: Intent, reason: string): Intent => ({ ...p, action: "hold", sizeUsd: 0, dcaUnits: 0, reason });

/** Lets a intent through, or turns it into a hold with the reason. A hold passes unchanged. */
export function gate(p: Intent, state: WhipsawState, regime: Regime, now: number, limits: WhipsawLimits = WHIPSAW_DEFAULTS): Intent {
  if (p.action === "hold") return p;
  const bad = whipsawProblems(limits);
  if (bad.length > 0) return hold(p, `invalid anti-whipsaw configuration: ${bad.join("; ")}`);
  if (regime !== "normal") return hold(p, `regime ${regime}: not trading`);
  if (state.disarmed === p.zone) return hold(p, `${p.zone} already traded: waiting to re-arm`);
  if (state.lastActionAt !== undefined) {
    const since = now - state.lastActionAt;
    if (!(since >= 0)) return hold(p, "last action is dated in the future");
    if (since < limits.cooldownMs) return hold(p, "cooling down after the last action");
    if (state.lastAction !== undefined && state.lastAction !== p.action && since < limits.reversalLockMs) return hold(p, "reversal locked out");
  }
  return p;
}

/** The threshold line of a zone, in percent, or undefined for hold and buy halt. */
function line(zone: BandZone, bands: Bands): number | undefined {
  switch (zone) {
    case "trim-1": return bands.trim[0];
    case "trim-2": return bands.trim[1];
    case "trim-3": return bands.trim[2];
    case "dca-1": return bands.dca[0];
    case "dca-2": return bands.dca[1];
    case "dca-3": return bands.dca[2];
    default: return undefined;
  }
}

/**
 * The state after a reading. An action records its time, direction and zone (and disarms the zone). A disarmed zone
 * re-arms once the deviation has retreated `hysteresisPct` inside its line; with no deviation it stays disarmed.
 */
export function nextState(state: WhipsawState, intent: Intent, deviationPct: number | null, now: number,
  limits: WhipsawLimits = WHIPSAW_DEFAULTS, bands: Bands = BAND_DEFAULTS): WhipsawState {
  if (whipsawProblems(limits).length > 0 || bandProblems(bands).length > 0) return state;
  if (intent.action !== "hold") return { lastActionAt: now, lastAction: intent.action, disarmed: intent.zone };
  const zone = state.disarmed;
  if (zone === undefined || deviationPct === null) return state;
  const at = line(zone, bands);
  if (at === undefined) return state;
  const retreated = at > 0 ? deviationPct <= at - limits.hysteresisPct : deviationPct >= at + limits.hysteresisPct;
  if (!retreated) return state;
  const { disarmed: _cleared, ...rest } = state;
  return rest;
}
