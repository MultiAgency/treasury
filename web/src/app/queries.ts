import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { clientFor, gw } from "../shared/client";
import type { Decoded } from "../../../src/gateway/proposals.js";
import { loadGateway } from "./session";
import { visibleProposals } from "../shared/access";

export function redactProposalCaches(client: QueryClient) {
  for (const query of client.getQueryCache().findAll({ queryKey: ["gw", "proposals"] })) {
    const data = query.state.data as Decoded[] | undefined;
    // Redaction is not a successful read: keep existing denials, freshness and fetch state.
    if (data) query.setState({ data: visibleProposals(data) });
  }
}

/** A refused agent action cannot reuse stale capabilities while session refresh is pending or fails. */
export function clearAgentCapabilities(client: QueryClient, base: string) {
  const name = base.match(/^\/a\/([a-z0-9-]+)$/)?.[1];
  if (!name) return;
  const query = client.getQueryCache().find({ queryKey: gatewayQueries.session.queryKey, exact: true });
  const data = query?.state.data as Awaited<ReturnType<typeof loadGateway>> | undefined;
  if (!query || !data?.viewer?.access[name]) return;
  // Keep membership, read caches and freshness; only a successful session read restores capabilities.
  query.setState({ data: { ...data, viewer: { ...data.viewer, access: { ...data.viewer.access,
    [name]: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false },
  } } } });
}

export const gatewayQueries = {
  // The shell, sibling actions and invoice links observe one session. Later mounts retain the
  // metadata refresh window; explicit denials invalidate this same snapshot immediately.
  session: queryOptions({ queryKey: ["gateway"], queryFn: loadGateway, retry: false, staleTime: 60_000, refetchOnReconnect: false }),
  proposals: (dao: string | undefined) => queryOptions({ queryKey: ["gw", "proposals", dao],
    queryFn: async () => visibleProposals(await gw<Decoded[]>(`/gw/proposals?dao=${encodeURIComponent(dao!)}`)), enabled: Boolean(dao), refetchInterval: 15_000,
    retry: (failures, error) => !["UNAUTHORIZED", "FORBIDDEN"].includes((error as { code?: string }).code ?? "") && failures < 3 }),
  sibling: (name: string) => queryOptions({ queryKey: ["sibling", name], staleTime: 60_000, queryFn: async () => {
    const api = clientFor(`/a/${name}`);
    const [setup, overview] = await Promise.all([api.setup(), api.overview()]);
    return { setup, overview };
  } }),
};
