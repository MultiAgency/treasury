import type { QueryUtils } from "../../shared/queries";

export function activityQueriesFor(orpc: QueryUtils) {
  return {
    books: orpc.reconcileBooks.queryOptions(),
    unresolved: orpc.unresolved.queryOptions({ refetchInterval: 30_000 }),
    activity: orpc.activity.queryOptions(),
  };
}
