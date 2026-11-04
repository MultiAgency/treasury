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
  /**
   * The most extreme zone disarmed on its side: it and every less extreme zone there can't trade until the deviation
   * retreats past their lines, one line at a time. A more extreme zone stays armed.
   */
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

/** Each side's trading zones, least extreme first. */
const SIDES: readonly (readonly BandZone[])[] = [["trim-1", "trim-2", "trim-3"], ["dca-1", "dca-2", "dca-3"]];
/** Whether `zone` is `disarmed` or a less extreme zone on its side. */
function heldBy(zone: BandZone, disarmed: BandZone | undefined) {
  if (disarmed === undefined) return false;
  const side = SIDES.find(s => s.includes(zone));
  return side !== undefined && side.includes(disarmed) && side.indexOf(zone) <= side.indexOf(disarmed);
}
/** The action that trades on each side of `SIDES`: trims sell, DCA buys. */
const ACTION_OF: readonly Exclude<IntentAction, "hold">[] = ["sell-volatile", "buy-volatile"];

/**
 * What is wrong with the state, if anything. The state is only ever written whole by `nextState`, so a part missing or
 * unreadable (an action without its time, a time without its action, an action that isn't a buy or a sell, a disarmed
 * zone off the last action's side) means it was corrupted or hand-built: the gate holds instead of guessing.
 */
export function stateProblems(s: WhipsawState): string[] {
  const r = report();
  r.need(s.lastActionAt === undefined || (typeof s.lastActionAt === "number" && Number.isFinite(s.lastActionAt)), "lastActionAt must be a time");
  r.need(s.lastAction === undefined || s.lastAction === "buy-volatile" || s.lastAction === "sell-volatile", "lastAction must be a buy or a sell");
  // The cooldown and the reversal lock need both: with only one, neither can be checked.
  r.need((s.lastAction === undefined) === (s.lastActionAt === undefined), "lastAction and lastActionAt must be set together");
  if (s.disarmed !== undefined) {
    const side = SIDES.findIndex(zones => zones.includes(s.disarmed!));
    r.need(side >= 0, "disarmed must be a trim or DCA zone");
    r.need(side < 0 || s.lastAction === ACTION_OF[side], "disarmed must be on the side of the last action");
  }
  return r.problems;
}

/** The next less extreme zone on `zone`'s side, or undefined past the first. */
const lessExtreme = (zone: BandZone) => { const side = SIDES.find(s => s.includes(zone)); return side?.[side.indexOf(zone) - 1]; };

/** Lets an intent through, or turns it into a hold with the reason. A hold passes unchanged. */
export function gate(p: Intent, state: WhipsawState, regime: Regime, now: number, limits: WhipsawLimits = WHIPSAW_DEFAULTS): Intent {
  if (p.action === "hold") return p;
  const bad = whipsawProblems(limits);
  if (bad.length > 0) return hold(p, `invalid anti-whipsaw configuration: ${bad.join("; ")}`);
  if (regime !== "normal") return hold(p, `regime ${regime}: not trading`);
  const badState = stateProblems(state);
  if (badState.length > 0) return hold(p, `unusable anti-whipsaw state: ${badState.join("; ")}`);
  if (heldBy(p.zone, state.disarmed)) return hold(p, `${state.disarmed} already traded: ${p.zone} waits to re-arm`);
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
 * The state after a reading. An action records its time, direction and zone (and disarms the zone, and with it the less
 * extreme zones on its side). Once the deviation has retreated `hysteresisPct` inside the disarmed zone's line, the
 * next less extreme zone is the one disarmed, and so on past the first; with no deviation nothing re-arms.
 */
export function nextState(state: WhipsawState, intent: Intent, deviationPct: number | null, now: number,
  limits: WhipsawLimits = WHIPSAW_DEFAULTS, bands: Bands = BAND_DEFAULTS): WhipsawState {
  if (whipsawProblems(limits).length > 0 || bandProblems(bands).length > 0) return state;
  if (intent.action !== "hold") return { lastActionAt: now, lastAction: intent.action, disarmed: intent.zone };
  if (state.disarmed === undefined || deviationPct === null) return state;
  let zone: BandZone | undefined = state.disarmed;
  while (zone !== undefined) {
    const at = line(zone, bands);
    if (at === undefined) return state;
    const retreated = at > 0 ? deviationPct <= at - limits.hysteresisPct : deviationPct >= at + limits.hysteresisPct;
    if (!retreated) break;
    zone = lessExtreme(zone);
  }
  if (zone === state.disarmed) return state;
  const { disarmed: _cleared, ...rest } = state;
  return zone === undefined ? rest : { ...rest, disarmed: zone };
}
