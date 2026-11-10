// Runway with real-world assets (#221, phase 3): the cash the floor counts is only what can be turned into dollars in
// time. Pure. A stablecoin counts in full. A cash-like real-world asset (a tokenized T-bill) counts only when the RWA
// sleeve is switched on, the platform lists it, its notice and settlement fit inside the horizon, and the holding meets
// its minimum redemption; it counts at its value less the redemption fee. Everything else (volatile assets, gold) never
// counts: it's a price exposure, not cash. The result feeds `checkExposure`'s `cashUsd` and the cash-floor detector.

import { ASSET_REGISTRY, proposable, type AssetEntry } from "./assets.ts";
import type { ValuedHolding } from "./exposure.ts";
import { isNum } from "./validate.ts";

export type RunwayTerms = {
  /** The RWA sleeve's switch: off, no real-world asset counts as cash, whatever it is. */
  rwaEnabled: boolean;
  /** Days within which cash must be in hand to count towards the floor. */
  horizonDays: number;
};

export type RunwayCash = {
  /** USD the floor may count, or null when a holding is unusable or unknown (the floor then can't be judged). */
  cashUsd: number | null;
  counted: { asset: string; usd: number }[];
  excluded: { asset: string; usd: number; reason: string }[];
};

/** The cash the floor counts, holding by holding, with why each one that doesn't count is left out. */
export function runwayCash(holdings: readonly ValuedHolding[], terms: RunwayTerms, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): RunwayCash {
  const counted: RunwayCash["counted"] = [], excluded: RunwayCash["excluded"] = [];
  let usable = isNum(terms.horizonDays) && terms.horizonDays >= 0;
  for (const h of holdings) {
    const entry = registry[h.asset];
    if (!entry || !isNum(h.usd) || h.usd < 0) { usable = false; excluded.push({ asset: h.asset, usd: h.usd, reason: "unknown asset or unusable value" }); continue; }
    if (entry.class === "stable") { counted.push({ asset: h.asset, usd: h.usd }); continue; }
    const rwa = entry.rwa;
    if (entry.class !== "rwa" || !rwa?.cashLike) { excluded.push({ asset: h.asset, usd: h.usd, reason: "a price exposure, not cash" }); continue; }
    const days = rwa.redemption.noticeDays + rwa.redemption.settlementDays;
    const reason = !terms.rwaEnabled ? "the RWA sleeve is off"
      : !proposable(entry) ? "not among the platform's proposal assets"
      : days > terms.horizonDays ? `redeems in ${days} days, over the ${terms.horizonDays}-day horizon`
      : h.usd < rwa.redemption.minUsd ? `under the ${rwa.redemption.minUsd} USD minimum redemption`
      : null;
    if (reason) excluded.push({ asset: h.asset, usd: h.usd, reason });
    else counted.push({ asset: h.asset, usd: h.usd * (1 - rwa.redemption.feeBps / 10_000) });
  }
  return { cashUsd: usable ? counted.reduce((s, c) => s + c.usd, 0) : null, counted, excluded };
}
