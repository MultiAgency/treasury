import { BASE, client } from "../../shared/client";
import { onScope, utilsFor, type QueryUtils } from "../../shared/queries";

export function payablesQueriesFor(orpc: QueryUtils) {
  return {
    orpc,
    invoices: orpc.invoices.queryOptions({ refetchInterval: 15_000 }),
    paymentStatus: (correlationId: string | undefined) => orpc.paymentStatus.queryOptions({ input: { correlationId: correlationId ?? "" }, enabled: Boolean(correlationId), retry: false }),
    agreements: orpc.agreements.list.queryOptions({ refetchInterval: 30_000 }),
    paymentHistory: orpc.paymentHistory.queryOptions({ refetchInterval: 30_000, retry: false }),
  };
}

/** This agent document's payment queries, rescoped with the signed-in account (a live binding). */
export let payablesQueries = payablesQueriesFor(utilsFor(client, BASE));
onScope(() => { payablesQueries = payablesQueriesFor(utilsFor(client, BASE)); });
