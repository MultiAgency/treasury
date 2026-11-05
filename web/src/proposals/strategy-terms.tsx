import { symbolOf } from "../shared/format";
import type { StrategyRead } from "./proposals-api";

/** A saved strategy's terms: its nonzero targets, its swap limits, and autopilot's interval and ceiling. */
export function StrategyTerms({ strategy, label }: { strategy: StrategyRead["strategy"]; label: string }) {
  return <>
    <ul aria-label={label} className="flex flex-col gap-1">
      {Object.entries(strategy.targetBps).filter(([, bps]) => bps > 0).map(([asset, bps]) =>
        <li key={asset}>{symbolOf(asset, [])}: {bps / 100}%</li>)}
    </ul>
    <p>Swaps of at least ${strategy.minLegUsd}, costing at most {strategy.maxCostBps / 100}%. On autopilot: every {strategy.autopilot.everyMin} minutes,
      up to ${strategy.autopilot.maxUsd} a run.</p>
  </>;
}
