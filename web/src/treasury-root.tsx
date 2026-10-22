import { TREASURY_ONLY } from "./treasury-surface";
import { TreasuryHome } from "./public/treasury-home";
import { clearAgentCapabilities, gatewayQueries, redactProposalCaches } from "./app/queries";
import { scopeOfKey, scopeQueries } from "./shared/queries";
import { onSessionChange } from "./app/session-signal";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useSyncExternalStore } from "react";
import { PublicHome } from "./public";
import { ErrorBox, Button, Loading } from "./shared/ui";
import { loadGateway, ownersOf } from "./app/session";
import { BASE } from "./shared/client";
import { deniedAt, onAccessDenial, recheckAccess, useAccessState } from "./shared/access";

const AuthenticatedApp = lazy(() => import("./app/authenticated-app").then(module => ({ default: module.AuthenticatedApp })));
const PrototypeExplorer = lazy(() => import("./public/prototype-explorer").then(module => ({ default: module.PrototypeExplorer })));

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
onAccessDenial(denial => {
  if (denial.scope === "procedure") clearAgentCapabilities(queryClient, denial.base);
  else {
    redactProposalCaches(queryClient);
    const affected = (query: { queryKey: readonly unknown[] }) => {
      const scope = scopeOfKey(query.queryKey);
      if (!scope) return false;
      return denial.scope === "session" || scope.base === denial.base;
    };
    // Discard late reads as well as cached observations; unrelated agents keep their records.
    void queryClient.cancelQueries({ predicate: affected }).then(() => queryClient.removeQueries({ predicate: affected }));
  }
  void queryClient.invalidateQueries({ queryKey: gatewayQueries.session.queryKey, exact: true });
});
// Another tab signed in or out: reread identity now rather than when this snapshot goes stale.
onSessionChange(() => { void queryClient.invalidateQueries({ queryKey: gatewayQueries.session.queryKey, exact: true }); });
// Agent reads are keyed by the signed-in account. When another account signs in on this host (for
// example in another tab), every earlier account's agent records and proposal lists leave memory.
queryClient.getQueryCache().subscribe(event => {
  if (event.type !== "updated" || event.action.type !== "success" || event.query.queryHash !== JSON.stringify(gatewayQueries.session.queryKey)) return;
  const account = (event.query.state.data as Awaited<ReturnType<typeof loadGateway>> | undefined)?.viewer?.account ?? null;
  if (!scopeQueries(account)) return;
  const earlier = (query: { queryKey: readonly unknown[] }) => {
    const scope = scopeOfKey(query.queryKey);
    return scope ? scope.account !== (account ?? "") : query.queryKey[0] === "gw";
  };
  void queryClient.cancelQueries({ predicate: earlier }).then(() => queryClient.removeQueries({ predicate: earlier }));
});

/**
 * Served by a local agent server, this is that agent's dashboard. Behind the hosted gateway, a
 * visitor sees the public examples and sign-in. Signed-in pages share a workspace frame;
 * `/a/<agent>/` retains that agent's client, cache and permissions.
 */
function GatewayPage({ activity }: { activity: boolean }) {
  const access = useAccessState();
  const query = useQuery(gatewayQueries.session);
  if (query.isPending) return <main className="mx-auto max-w-xl p-8"><Loading label="Loading dashboard…" /></main>;
  if (query.isError && query.data === undefined) return <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
    <h1 className="text-xl font-semibold">Dashboard unavailable</h1>
    <ErrorBox error={`The dashboard can't load right now: ${query.error.message}`} />
    <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>{query.isFetching ? "Retrying…" : "Retry"}</Button>
  </main>;
  const gateway = query.data;
  const denied = deniedAt(access, BASE);
  const missing = gateway?.viewer && BASE && !gateway.viewer.access[BASE.slice("/a/".length)];
  if (gateway?.viewer && (denied || missing)) return <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
    <h1 className="text-xl font-semibold">Access unavailable</h1>
    <p role="alert">{denied?.message ?? "This account may no longer access this agent."} Private records are hidden.</p>
    <Button variant="outline" onClick={recheckAccess}>Check access again</Button>
    <a href="/" className="underline">Return to Home</a>
  </main>;
  const hiddenAgents = gateway?.viewer && gateway.agents.some(agent => deniedAt(access, `/a/${agent.name}`));
  const visibleGateway = gateway?.viewer ? { ...gateway,
    agents: gateway.agents.filter(agent => !deniedAt(access, `/a/${agent.name}`) && (!TREASURY_ONLY || agent.area === "treasury" || agent.name === "treasury")),
    viewer: { ...gateway.viewer, access: Object.fromEntries(Object.entries(gateway.viewer.access)
      .filter(([name]) => !deniedAt(access, `/a/${name}`))) },
  } : gateway;
  const content = gateway && !gateway.viewer ? (
    TREASURY_ONLY ? <TreasuryHome selfService={gateway.selfServiceTreasury} daos={ownersOf(gateway.agents.filter(agent => agent.area === "treasury" || agent.name === "treasury"))} /> : <PublicHome daos={ownersOf(gateway.agents)} invoices={gateway.invoices} />
  ) : (
    <AuthenticatedApp gateway={visibleGateway} activity={activity} />
  );
  return <>
    {query.error && <div role="alert" className="flex flex-wrap items-center gap-3 border-b p-4 text-sm">
      <p>Workspace permissions could not be refreshed. Denied actions wait for refreshed permissions. Records for denied agents remain hidden.</p>
      <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry permissions</Button>
    </div>}
    {hiddenAgents && !query.error && <div role="status" className="flex flex-wrap items-center gap-3 border-b p-4 text-sm">
      <p>Access to an agent changed. Its private records are hidden while permissions refresh.</p>
      <Button variant="outline" onClick={recheckAccess}>Check access again</Button>
    </div>}
    {content}
  </>;
}

const subscribeHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};
function App() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const example = hash.match(/^#\/explore\/(payables|treasury)(?:\/([^/?#]+))?\/?$/);
  if (example && !TREASURY_ONLY) return <PrototypeExplorer key={example[1]} area={example[1] as "payables" | "treasury"} page={example[2] || "overview"} />;
  return <GatewayPage activity={hash === "#activity"} />;
}

/** The whole Treasury app, rendered by the standalone page (main.tsx) or by a host through embed.tsx. */
export function TreasuryRoot() {
  return (
    <StrictMode><QueryClientProvider client={queryClient}><Suspense fallback={<main className="p-8"><Loading label="Loading page…" /></main>}><App /></Suspense></QueryClientProvider></StrictMode>
  );
}
