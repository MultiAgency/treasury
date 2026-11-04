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
  /** After an action, each line it crossed stays disarmed until the deviation retreats this many percent inside that line. */
  hysteresisPct: 2,
} as const;

export type WhipsawLimits = { cooldownMs: number; reversalLockMs: number; hysteresisPct: number };

/** `normal` is the only regime the engine trades in; any other holds. */
export type Regime = "normal" | "fast-move" | "thin-liquidity" | "source-stress" | "system-fault";

export type WhipsawState = {
  lastActionAt?: number;
  lastAction?: Exclude<IntentAction, "hold">;
  /**
   * The deepest zone still disarmed. It and every shallower zone on its side can't trade: a price that sold at +25% and
   * dips to +24.9% hasn't re-crossed +15%, so trim-1 there would repeat the same move. Each line re-arms on its own once
   * the deviation retreats past its hysteresis, deepest first.
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

/** Lets an intent through, or turns it into a hold with the reason. A hold passes unchanged. */
export function gate(p: Intent, state: WhipsawState, regime: Regime, now: number, limits: WhipsawLimits = WHIPSAW_DEFAULTS): Intent {
  if (p.action === "hold") return p;
  const bad = whipsawProblems(limits);
  if (bad.length > 0) return hold(p, `invalid anti-whipsaw configuration: ${bad.join("; ")}`);
  if (regime !== "normal") return hold(p, `regime ${regime}: not trading`);
  const badState = stateProblems(state);
  if (badState.length > 0) return hold(p, `unusable anti-whipsaw state: ${badState.join("; ")}`);
  if (state.disarmed !== undefined && covers(state.disarmed, p.zone)) return hold(p, `${p.zone} is inside a line already traded (${state.disarmed}): waiting to re-arm`);
  if (state.lastActionAt !== undefined && state.lastAction !== undefined) {
    const since = now - state.lastActionAt;
    if (!(since >= 0)) return hold(p, "last action is dated in the future");
    if (since < limits.cooldownMs) return hold(p, "cooling down after the last action");
    if (state.lastAction !== p.action && since < limits.reversalLockMs) return hold(p, "reversal locked out");
  }
  return p;
}

/** Trading zones by side, shallowest first. */
const SIDES = { trim: ["trim-1", "trim-2", "trim-3"], dca: ["dca-1", "dca-2", "dca-3"] } as const;
const sideOf = (zone: BandZone): { side: keyof typeof SIDES; depth: number } | undefined => {
  for (const side of ["trim", "dca"] as const) {
    const depth = (SIDES[side] as readonly BandZone[]).indexOf(zone);
    if (depth >= 0) return { side, depth };
  }
  return undefined;
};
const ACTION_OF = { trim: "sell-volatile", dca: "buy-volatile" } as const;

/** Whether a disarmed zone blocks `zone`: same side, and no deeper. */
function covers(disarmed: BandZone, zone: BandZone): boolean {
  const d = sideOf(disarmed), z = sideOf(zone);
  return d !== undefined && z !== undefined && d.side === z.side && z.depth <= d.depth;
}

/**
 * What is wrong with the state, if anything. The state is only ever written whole by `nextState`, so a part missing
 * (an action without its time, a time without its action, a disarmed zone with no action behind it) means it was
 * corrupted or hand-built: the cooldown and reversal lock can't be checked, so the gate holds instead of guessing.
 */
export function stateProblems(s: WhipsawState): string[] {
  const r = report();
  r.need(s.lastActionAt === undefined || (typeof s.lastActionAt === "number" && Number.isFinite(s.lastActionAt)), "lastActionAt must be a time");
  r.need(s.lastAction === undefined || s.lastAction === "buy-volatile" || s.lastAction === "sell-volatile", "lastAction must be a buy or a sell");
  r.need((s.lastAction === undefined) === (s.lastActionAt === undefined), "lastAction and lastActionAt must be set together");
  if (s.disarmed !== undefined) {
    const d = sideOf(s.disarmed);
    r.need(d !== undefined, "disarmed must be a trim or DCA zone");
    r.need(d === undefined || s.lastAction === ACTION_OF[d.side], "disarmed must be on the side of the last action");
  }
  return r.problems;
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
 * The state after a reading. An action records its time, direction and zone, and disarms that zone and every shallower
 * one on its side (all the lines the move has crossed). While holding, disarmed lines re-arm deepest first: a line
 * re-arms once the deviation has retreated `hysteresisPct` inside it, so the next shallower line becomes the disarmed
 * one, and the state clears past the first line. With no deviation nothing re-arms.
 */
export function nextState(state: WhipsawState, intent: Intent, deviationPct: number | null, now: number,
  limits: WhipsawLimits = WHIPSAW_DEFAULTS, bands: Bands = BAND_DEFAULTS): WhipsawState {
  if (whipsawProblems(limits).length > 0 || bandProblems(bands).length > 0) return state;
  if (intent.action !== "hold") return { lastActionAt: now, lastAction: intent.action, disarmed: intent.zone };
  const zone = state.disarmed;
  if (zone === undefined || deviationPct === null || !Number.isFinite(deviationPct)) return state;
  const d = sideOf(zone);
  if (d === undefined) return state;
  let depth = d.depth;
  for (; depth >= 0; depth--) {
    const at = line(SIDES[d.side][depth]!, bands)!;
    const retreated = at > 0 ? deviationPct <= at - limits.hysteresisPct : deviationPct >= at + limits.hysteresisPct;
    if (!retreated) break;
  }
  if (depth === d.depth) return state;
  const { disarmed: _cleared, ...rest } = state;
  return depth < 0 ? rest : { ...rest, disarmed: SIDES[d.side][depth] };
}
