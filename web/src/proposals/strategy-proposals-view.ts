// With its extension: test/strategy-proposals-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { symbolOf } from "../shared/format.ts";
import type { StrategyProposal, StrategyRead } from "./proposals-api.ts";

type Strategy = StrategyRead["strategy"];

/** Who proposed it, for a person: Ballast's mandate compiler, or software holding one of the agent's tokens. */
export const sourceName = (source: string) => source === "mandate" ? "Ballast's mandate" : `An agent's token (${source.slice("token:".length)})`;

const floorText = (strategy: Pick<Strategy, "cashFloor">) =>
  strategy.cashFloor ? `$${strategy.cashFloor.usd} in ${strategy.cashFloor.assets.map(asset => symbolOf(asset, [])).join(", ")}` : "None";

/** Each term of a strategy, as the saved one's and a proposal's are compared: its targets, then its limits, then autopilot's. */
export function strategyRows(saved: Strategy, proposed: StrategyProposal["strategy"]) {
  const assets = [...new Set([...Object.keys(saved.targetBps), ...Object.keys(proposed.targetBps)])];
  return [
    ...assets.map(asset => ({ term: `${symbolOf(asset, [])} target`, saved: `${(saved.targetBps[asset] ?? 0) / 100}%`, proposed: `${(proposed.targetBps[asset] ?? 0) / 100}%` })),
    { term: "Minimum swap", saved: `$${saved.minLegUsd}`, proposed: `$${proposed.minLegUsd}` },
    { term: "Maximum swap cost", saved: `${saved.maxCostBps / 100}%`, proposed: `${proposed.maxCostBps / 100}%` },
    { term: "Autopilot runs every", saved: `${saved.autopilot.everyMin} min`, proposed: `${proposed.autopilot.everyMin} min` },
    { term: "Automatic rebalance ceiling", saved: `$${saved.autopilot.maxUsd}`, proposed: `$${proposed.autopilot.maxUsd}` },
    { term: "Cash floor", saved: floorText(saved), proposed: floorText(proposed) },
  ].map(row => ({ ...row, changed: row.saved !== row.proposed }));
}

