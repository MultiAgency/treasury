import type { Strategy } from "../../../../src/strategy-digest.js";

export type StrategyDraft = { targets: Record<string, string>; minLegUsd: string; maxCost: string; everyMin: string; maxUsd: string };

export const strategyDraft = (strategy: Strategy): StrategyDraft => ({
  targets: Object.fromEntries(Object.entries(strategy.targetBps).map(([asset, bps]) => [asset, String(bps / 100)])),
  minLegUsd: String(strategy.minLegUsd), maxCost: String(strategy.maxCostBps / 100),
  everyMin: String(strategy.autopilot.everyMin), maxUsd: String(strategy.autopilot.maxUsd),
});

/** Exact hundredths, so 33.33 + 33.33 + 33.34 is 100 without floating-point rounding. */
const hundredths = (value: string): number | null => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
};
const integer = (value: string): number | null => /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function parseStrategyDraft(draft: StrategyDraft) {
  const errors: Record<string, string> = {};
  const targetBps: Record<string, number> = {};
  for (const [asset, value] of Object.entries(draft.targets)) {
    const bps = hundredths(value);
    if (bps === null || bps > 10_000) errors[asset] = "Enter 0–100%, with at most two decimal places.";
    else targetBps[asset] = bps;
  }
  if (Object.keys(errors).length === 0 && Object.values(targetBps).reduce((a, b) => a + b, 0) !== 10_000)
    errors.targets = "Target allocations must add up to 100%.";
  const minLegUsd = integer(draft.minLegUsd);
  const maxCostBps = hundredths(draft.maxCost);
  const everyMin = integer(draft.everyMin);
  const maxUsd = integer(draft.maxUsd);
  if (minLegUsd === null || minLegUsd < 1) errors.minLegUsd = "Enter a whole dollar amount of at least $1.";
  if (maxCostBps === null || maxCostBps < 1 || maxCostBps > 1000) errors.maxCost = "Enter 0.01–10%, with at most two decimal places.";
  if (everyMin === null || everyMin < 5 || everyMin > 1440) errors.everyMin = "Enter 5–1440 whole minutes.";
  if (maxUsd === null || maxUsd > 1_000_000) errors.maxUsd = "Enter $0–$1,000,000 in whole dollars. $0 leaves swaps for manual execution.";
  const strategy: Strategy | null = Object.keys(errors).length ? null : {
    targetBps, minLegUsd: minLegUsd!, maxCostBps: maxCostBps!, autopilot: { everyMin: everyMin!, maxUsd: maxUsd! },
  };
  return { strategy, errors };
}
