import { queryOptions } from "@tanstack/react-query";
import type { QuerySource } from "../../shared/query-source";

export function payablesQueriesFor(api: QuerySource, key: (local: string[], fleet?: string) => readonly string[]) {
  return {
    invoices: queryOptions({ queryKey: key(["invoices"]), queryFn: () => api.invoices(), refetchInterval: 15_000 }),
    paymentStatus: (correlationId: string | undefined) => queryOptions({ queryKey: key(["paymentStatus", correlationId ?? ""]), queryFn: ({ signal }) => api.paymentStatus({ correlationId: correlationId! }, { signal }), enabled: Boolean(correlationId), retry: false }),
    held: queryOptions({ queryKey: key(["held"]), queryFn: () => api.held(), refetchInterval: 15_000 }),
    agreements: queryOptions({ queryKey: key(["agreements"]), queryFn: () => api.agreements.list(), refetchInterval: 30_000 }),
    paymentHistory: queryOptions({ queryKey: key(["paymentHistory"]), queryFn: ({ signal }) => api.paymentHistory(undefined, { signal }), refetchInterval: 30_000, retry: false }),
  };
}
