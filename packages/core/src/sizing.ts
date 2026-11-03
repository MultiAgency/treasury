// Sizing (A4.2): turns a zone's direction into a USD size, within the DCA budget, the per-order cap and the allocation
// bounds. Pure. The policy engine (A5) still has the final say. Every number is a named default awaiting H6/H9, and the
// sleeve meaning (volatile / reserve / operating cash) is unconfirmed (H5/H6/H8).

import type { BandZone, Proposal } from "./bands.ts";

export const SIZING_DEFAULTS = {
  /** The DCA budget, as a percent of the reserve, split into `dcaUnits` equal units. */
  dcaBudgetPctOfReserve: 20,
  dcaUnits: 10,
  /** Units a DCA zone asks for. */
  dcaUnitsPerZone: { "dca-1": 1, "dca-2": 2, "dca-3": 3 },
  /** Percent of the volatile holding a trim zone sells. */
  trimPctOfVolatile: { "trim-1": 5, "trim-2": 10, "trim-3": 20 },
  /** One order never exceeds this percent of the whole treasury (the policy limit, applied early). */
  maxOrderPctOfTreasury: 2,
} as const;

export type SizingParams = {
  dcaBudgetPctOfReserve: number;
  dcaUnits: number;
  dcaUnitsPerZone: Partial<Record<BandZone, number>>;
  trimPctOfVolatile: Partial<Record<BandZone, number>>;
  maxOrderPctOfTreasury: number;
};

/** Current holdings in USD. DCA buys draw on the reserve only, never on operating cash. */
export type Portfolio = { volatileUsd: number; reserveUsd: number; cashUsd: number };

/** The volatile share of the treasury must stay inside these percents (from the mandate's profile). */
export type WeightBounds = { volatileMinPct: number; volatileMaxPct: number };

export type SizingState = { dcaUnitsUsed: number };

const hold = (p: Proposal, reason: string): Proposal => ({ ...p, action: "hold", sizeUsd: 0, dcaUnits: 0, reason });
const usable = (n: number) => Number.isFinite(n) && n >= 0;

/**
 * Sizes a proposal, or holds with the reason. A hold stays a hold. Anything unusable (a negative or non-finite
 * holding, no treasury value, bad bounds, a DCA budget that is used up) holds.
 */
export function sizeProposal(p: Proposal, portfolio: Portfolio, bounds: WeightBounds, state: SizingState,
  params: SizingParams = SIZING_DEFAULTS): Proposal {
  if (p.action === "hold") return p;
  const { volatileUsd: v, reserveUsd: r, cashUsd: c } = portfolio;
  const total = v + r + c;
  if (![v, r, c].every(usable) || !(total > 0)) return hold(p, "portfolio values unusable");
  if (!(bounds.volatileMinPct >= 0 && bounds.volatileMaxPct <= 100 && bounds.volatileMinPct <= bounds.volatileMaxPct)) return hold(p, "weight bounds unusable");
  const cap = (total * params.maxOrderPctOfTreasury) / 100;

  if (p.action === "buy-volatile") {
    if (!(params.dcaUnits > 0) || !usable(state.dcaUnitsUsed)) return hold(p, "DCA budget unusable");
    const remaining = params.dcaUnits - state.dcaUnitsUsed;
    if (remaining <= 0) return hold(p, "DCA budget used up");
    const unitUsd = (r * params.dcaBudgetPctOfReserve) / 100 / params.dcaUnits;
    const wanted = Math.min(params.dcaUnitsPerZone[p.zone] ?? 0, remaining);
    if (!(wanted > 0) || !(unitUsd > 0)) return hold(p, "no DCA size for this zone");
    // Buying moves reserve into volatile; the treasury total is unchanged.
    const room = (bounds.volatileMaxPct * total) / 100 - v;
    const size = Math.min(wanted * unitUsd, cap, r, room);
    if (!(size > 0)) return hold(p, room <= 0 ? "volatile weight at its limit" : "nothing left to buy with");
    return { ...p, sizeUsd: size, dcaUnits: size / unitUsd, reason: `${p.reason}; buy ${size.toFixed(2)} USD` };
  }

  const pct = params.trimPctOfVolatile[p.zone] ?? 0;
  const room = v - (bounds.volatileMinPct * total) / 100;
  const size = Math.min((v * pct) / 100, cap, room);
  if (!(size > 0)) return hold(p, room <= 0 ? "volatile weight at its lower bound" : "no trim size for this zone");
  return { ...p, sizeUsd: size, dcaUnits: 0, reason: `${p.reason}; sell ${size.toFixed(2)} USD` };
}
