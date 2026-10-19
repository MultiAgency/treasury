import type { QueryUtils } from "../../shared/queries";

export function ownerQueriesFor(orpc: QueryUtils) {
  return {
    instance: orpc.instance.queryOptions({ retry: false }),
    ownerActions: orpc.owner.actions.queryOptions({ refetchInterval: 5_000, retry: false }),
    ownerPending: orpc.owner.pending.queryOptions({ refetchInterval: 5_000 }),
    ownerStatus: (correlationId: string) => orpc.owner.status.queryOptions({ input: { correlationId }, retry: false }),
  };
}
