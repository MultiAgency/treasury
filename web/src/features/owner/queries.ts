import { queryOptions } from "@tanstack/react-query";
import type { QuerySource } from "../../shared/query-source";

export function ownerQueriesFor(api: QuerySource, key: (local: string[], fleet?: string) => readonly string[]) {
  return {
    instance: queryOptions({ queryKey: key(["instance"]), queryFn: () => api.instance(), retry: false }),
    ownerActions: queryOptions({ queryKey: key(["owner", "actions"]), queryFn: () => api.owner.actions(), refetchInterval: 5_000, retry: false }),
    ownerPending: queryOptions({ queryKey: key(["owner", "pending"]), queryFn: () => api.owner.pending(), refetchInterval: 5_000 }),
    ownerStatus: (correlationId: string) => queryOptions({ queryKey: key(["owner", "status", correlationId]), queryFn: ({ signal }) => api.owner.status({ correlationId }, { signal }), retry: false }),
  };
}
