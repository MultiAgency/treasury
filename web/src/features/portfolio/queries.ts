import { queryOptions } from "@tanstack/react-query";
import type { QuerySource } from "../../shared/query-source";

export function portfolioQueriesFor(api: QuerySource, key: (local: string[], fleet?: string) => readonly string[]) {
  return {
    strategy: queryOptions({ queryKey: key(["strategy"]), queryFn: () => api.strategy.get(), refetchInterval: 30_000, retry: false }),
    runs: queryOptions({ queryKey: key(["autopilot", "evidence", "timeline", "history"], "runs"), queryFn: () => api.autopilot.evidence({}) }),
    recording: (agentId: string, tickId: string) => queryOptions({ queryKey: key(["live-run", agentId, tickId]), queryFn: ({ signal }) => api.autopilot.log({ tickId }, { signal }) }),
    inbox: queryOptions({ queryKey: key(["inbox"]), queryFn: () => api.inbox.list(), refetchInterval: 30_000 }),
    autopilot: queryOptions({ queryKey: key(["autopilot"]), queryFn: () => api.autopilot.get(), refetchInterval: 30_000, retry: false }),
  };
}
