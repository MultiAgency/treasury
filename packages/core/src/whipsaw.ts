// Anti-whipsaw and regime check (A4.3): stops the engine trading repeatedly on noise. Pure: the last action, the clock
// and the regime are passed in, and the next state is returned, never stored here. Numbers are named defaults awaiting
// H6/H9; the regime comes from the edge-case detectors (A6) and must be stated by the caller (fail closed).

import { BAND_DEFAULTS, type Bands, type BandZone, type Proposal, type ProposalAction } from "./bands.ts";

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
export type Regime = "normal" | "fast-move" | "thin-liquidity" | "source-stress";

export type WhipsawState = {
  lastActionAt?: number;
  lastAction?: Exclude<ProposalAction, "hold">;
  /** The zone just traded; it can't trade again until the deviation retreats past the hysteresis. */
  disarmed?: BandZone;
};

const hold = (p: Proposal, reason: string): Proposal => ({ ...p, action: "hold", sizeUsd: 0, dcaUnits: 0, reason });

/** Lets a proposal through, or turns it into a hold with the reason. A hold passes unchanged. */
export function gate(p: Proposal, state: WhipsawState, regime: Regime, now: number, limits: WhipsawLimits = WHIPSAW_DEFAULTS): Proposal {
  if (p.action === "hold") return p;
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
export function nextState(state: WhipsawState, proposal: Proposal, deviationPct: number | null, now: number,
  limits: WhipsawLimits = WHIPSAW_DEFAULTS, bands: Bands = BAND_DEFAULTS): WhipsawState {
  if (proposal.action !== "hold") return { lastActionAt: now, lastAction: proposal.action, disarmed: proposal.zone };
  const zone = state.disarmed;
  if (zone === undefined || deviationPct === null) return state;
  const at = line(zone, bands);
  if (at === undefined) return state;
  const retreated = at > 0 ? deviationPct <= at - limits.hysteresisPct : deviationPct >= at + limits.hysteresisPct;
  if (!retreated) return state;
  const { disarmed: _cleared, ...rest } = state;
  return rest;
}
