import type { QueryUtils } from "../../shared/queries";

export function portfolioQueriesFor(orpc: QueryUtils) {
  return {
    strategy: orpc.strategy.get.queryOptions({ refetchInterval: 30_000, retry: false }),
    runs: orpc.autopilot.evidence.queryOptions({ input: {} }),
    recording: (tickId: string) => orpc.autopilot.log.queryOptions({ input: { tickId } }),
    inbox: orpc.inbox.list.queryOptions({ refetchInterval: 30_000 }),
    autopilot: orpc.autopilot.get.queryOptions({ refetchInterval: 30_000, retry: false }),
  };
}
