import { queryOptions } from "@tanstack/react-query";
import type { QuerySource } from "../../shared/query-source";

export function activityQueriesFor(api: QuerySource, key: (local: string[], fleet?: string) => readonly string[]) {
  return {
    books: queryOptions({ queryKey: key(["books"]), queryFn: () => api.reconcileBooks() }),
    unresolved: queryOptions({ queryKey: key(["unresolved"]), queryFn: () => api.unresolved(), refetchInterval: 30_000 }),
    activity: queryOptions({ queryKey: key(["activity"]), queryFn: () => api.activity() }),
  };
}
