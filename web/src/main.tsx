import { hashKey, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { gatewayRead, isTreasury, scopeOfKey, type Gateway } from "./platform";
import { deniedAt, onAccessDenial, recheckAccess, settleDenials, useAccessState } from "./app/access";
import { AuthenticatedApp } from "./app/authenticated-app";
import { SignedOutHome } from "./app/home";
import { AGENT } from "./app/location";
import { onSessionChange } from "./app/session-signal";
import { Button, ErrorBox, Loading } from "./shared/ui";
import "./theme/tokens.css";
import "./styles.css";
import "./treasury-theme.css";
import "./dashboard-theme.css";

document.documentElement.classList.add("treasury-theme", "dark");

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

onAccessDenial(denial => {
  if (denial.scope === "procedure") {
    // A refused procedure turns this agent's controls off until the session read below answers. The gateway decides:
    // controls its answer still grants come back, and the agent refuses the procedure again if it must.
    const query = queryClient.getQueryCache().find<Gateway>({ queryKey: gatewayRead.queryKey, exact: true });
    const data = query?.state.data;
    if (query && data?.viewer && denial.agent && data.viewer.access[denial.agent])
      query.setState({ data: { ...data, viewer: { ...data.viewer, access: { ...data.viewer.access,
        [denial.agent]: { canSign: false, canPropose: false, canVote: false, canExecute: false, canManage: false } } } } });
  } else {
    // Discard late reads as well as cached observations; unrelated agents keep their records.
    const affected = (query: { queryKey: readonly unknown[] }) => {
      const scope = scopeOfKey(query.queryKey);
      return Boolean(scope) && (denial.scope === "session" || scope!.agent === denial.agent);
    };
    void queryClient.cancelQueries({ predicate: affected }).then(() => queryClient.removeQueries({ predicate: affected }));
  }
  void queryClient.invalidateQueries({ queryKey: gatewayRead.queryKey, exact: true });
});
// Another tab signed in or out: reread identity now rather than when this snapshot goes stale.
onSessionChange(() => { void queryClient.invalidateQueries({ queryKey: gatewayRead.queryKey, exact: true }); });
// Agent reads are keyed by the signed-in account. When another account signs in on this host (for example in another
// tab), every earlier account's agent records leave memory.
let viewer: string | null | undefined;
queryClient.getQueryCache().subscribe(event => {
  if (event.type !== "updated" || event.action.type !== "success" || event.query.queryHash !== hashKey(gatewayRead.queryKey)) return;
  const session = (event.query.state.data as Gateway | undefined)?.viewer ?? null;
  // The refreshed permissions answer for the account now signed in, so earlier denials no longer stand in for them.
  settleDenials(session);
  const account = session?.account ?? null;
  if (viewer === account) return;
  viewer = account;
  const earlier = (query: { queryKey: readonly unknown[] }) => { const scope = scopeOfKey(query.queryKey); return Boolean(scope) && scope!.account !== (account ?? ""); };
  void queryClient.cancelQueries({ predicate: earlier }).then(() => queryClient.removeQueries({ predicate: earlier }));
});

/** Signed out, the host's sign-in page; signed in, the Treasury agent's pages, while access holds. */
function GatewayPage() {
  const access = useAccessState();
  const query = useQuery(gatewayRead);
  if (query.isPending) return <main className="mx-auto max-w-xl p-8"><Loading label="Loading dashboard…" /></main>;
  if (query.isError && query.data === undefined) return <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
    <h1 className="text-xl font-semibold">Dashboard unavailable</h1>
    <ErrorBox error={`The dashboard can't load right now: ${query.error.message}`} />
    <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>{query.isFetching ? "Retrying…" : "Retry"}</Button>
  </main>;
  const gateway = query.data!;
  const denied = deniedAt(access, AGENT);
  const missing = gateway.viewer && AGENT && !gateway.viewer.access[AGENT];
  if (gateway.viewer && (denied || missing)) return <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
    <h1 className="text-xl font-semibold">Access unavailable</h1>
    <p role="alert">{denied?.message ?? "This account may no longer access this agent."} Private records are hidden.</p>
    <Button variant="outline" onClick={recheckAccess}>Check access again</Button>
    <a href="/" className="underline">Return to Home</a>
  </main>;
  const hiddenAgents = gateway.viewer && gateway.agents.some(agent => deniedAt(access, agent.name));
  const visible: Gateway = gateway.viewer ? { ...gateway,
    agents: gateway.agents.filter(agent => !deniedAt(access, agent.name) && isTreasury(agent)),
    viewer: { ...gateway.viewer, access: Object.fromEntries(Object.entries(gateway.viewer.access).filter(([name]) => !deniedAt(access, name))) },
  } : gateway;
  return <>
    {query.error && <div role="alert" className="flex flex-wrap items-center gap-3 border-b p-4 text-sm">
      <p>Workspace permissions could not be refreshed. Denied actions wait for refreshed permissions. Records for denied agents remain hidden.</p>
      <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry permissions</Button>
    </div>}
    {hiddenAgents && !query.error && <div role="status" className="flex flex-wrap items-center gap-3 border-b p-4 text-sm">
      <p>Access to an agent changed. Its private records are hidden while permissions refresh.</p>
      <Button variant="outline" onClick={recheckAccess}>Check access again</Button>
    </div>}
    {gateway.viewer
      ? <AuthenticatedApp gateway={visible} />
      : <SignedOutHome selfService={gateway.selfServiceTreasury} />}
  </>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><GatewayPage /></QueryClientProvider></StrictMode>,
);
