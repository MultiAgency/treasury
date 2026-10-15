import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Omitted scope refreshes all reads; an empty scope is for previews with no shared read changes. */
export async function refreshQueries(client: QueryClient, keys?: readonly QueryKey[]) {
  if (keys === undefined) { await client.invalidateQueries(); return; }
  await Promise.all(keys.map(queryKey => client.invalidateQueries({ queryKey })));
}
