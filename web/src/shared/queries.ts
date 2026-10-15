import { activityQueriesFor } from "../features/activity/queries";
import { portfolioQueriesFor } from "../features/portfolio/queries";
import { ownerQueriesFor } from "../features/owner/queries";
import { payablesQueriesFor } from "../features/payables/queries";
import { queryOptions } from "@tanstack/react-query";
import { client, type clientFor } from "./client";

/** Scope is [] inside an isolated agent document, or ["fleet", name] on shared pages. */
export function queriesFor(api: ReturnType<typeof clientFor>, scope: readonly string[] = []) {
  const key = (local: string[], fleet = local.join("-")) => scope.length ? [...scope, fleet] : local;
  return {
    ...payablesQueriesFor(api, key),
    ...ownerQueriesFor(api, key),
    ...portfolioQueriesFor(api, key),
    ...activityQueriesFor(api, key),

    policyHistory: queryOptions({ queryKey: key(["policyHistory"]), queryFn: () => api.policyHistory() }),
    setup: queryOptions({ queryKey: key(["setup"]), queryFn: () => api.setup(), retry: false }),
    overview: queryOptions({ queryKey: key(["overview"]), queryFn: () => api.overview(), refetchInterval: 30_000 }),
    treasury: queryOptions({ queryKey: key(["treasury"]), queryFn: () => api.treasury.get() }),
  };
}
export const queries = queriesFor(client);
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;
