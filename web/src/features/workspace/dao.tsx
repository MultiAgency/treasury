import { queriesFor } from "../../shared/queries";
import { useFleet, type AgentState } from "./workspace-observations";
import { ProposalRecords } from "./proposals";
import { WorkspaceHistory } from "./history";
import { gatewayQueries } from "../../app/queries";
import { ArrowRight } from "@phosphor-icons/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type Attention, attentionOf, attentionHref } from "./attention";
import type { Kind } from "../evidence/beats";
import { useEffect } from "react";
import { areaName } from "../../app/workspace";
import { ago, clientFor, kindOf } from "../../shared/lib";
import { AGENT_NAME, namer } from "../../shared/names";
import { type Gateway, type GatewayAgent, ownersOf } from "../../app/session";
import { Badge, Button, Card, Details, LoadingRecords, QueryError, Section, type Tone } from "../../shared/ui";
import { Empty, EmptyContent } from "@/components/ui/empty";
import { recheckAccess, useAccessState, visibleProposals } from "../../shared/access";

/**
 * The hosted dashboard's home: the agents this viewer may see and, for each DAO among their owners,
 * what its council is being asked to sign. Agent data comes through the gateway, by the same calls
 * each agent's own dashboard makes.
 */

type Item = Attention & { agent: string };

const itemsOf = (name: string, d: AgentState, nameOf: (account: string) => string): Item[] =>
  attentionOf({ ...d, nameOf }).map((item) => ({ ...item, agent: name }));

/** Each agent's wallet by its role, so a payment to the payout agent reads as such, not as 64 hex digits. */
const namesOf = (states: (AgentState | undefined)[]) =>
  namer(new Map(states.flatMap((d) => (d?.setup?.wallet && d.overview ? [[d.setup.wallet, AGENT_NAME[kindOf(d.overview) as Kind]] as const] : []))));

function NeedsAttention({ results, daos }: { results: ReturnType<typeof useFleet>; daos: string[] }) {
  const access = useAccessState();
  const proposals = useQueries({ queries: daos.map(dao => gatewayQueries.proposals(dao)) });
  const incomplete = results.filter(r => r.denied || r.incomplete.length > 0);
  const nameOf = namesOf(results.map((r) => r.data));
  const items = results.flatMap(result => itemsOf(result.name, result.data, nameOf));
  const rank: Record<Tone, number> = { destructive: 0, warning: 1, info: 2, success: 3, neutral: 4 };
  items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  const noOpenProposals = proposals.every(query => query.isSuccess && !query.error && !visibleProposals(query.data, access).some(p => p.status === "InProgress"));
  return (
    <Section title="Needs attention" description="Decisions and exceptions across the agents you can access.">
      <Card>
        <ul className="flex flex-col divide-y">
            {!items.length && !incomplete.length && noOpenProposals && <li><Empty className="items-start border-0 px-0 py-3"><EmptyContent className="items-start text-left">
              <p>No decisions or exceptions in the records checked.</p>
              <a href="/#activity" className="inline-flex min-h-11 items-center underline">View activity</a>
            </EmptyContent></Empty></li>}
            {incomplete.map((result) => (
              <li key={`incomplete-${result.name}`} className="flex flex-col gap-2 py-3 text-sm first:pt-0 last:pb-0">
                {(result.denied || result.error || !result.isPending) && <p className="text-warning-muted-foreground">{result.denied ? `${result.name}: access is unavailable. Private records are hidden.` : `${result.name}: checks are incomplete (${result.incomplete.join(", ")}). Known items remain below; cached items may be out of date.`}</p>}
                {result.isPending && !result.denied && <LoadingRecords label={`Checking ${result.name}…`} rows={1} />}
                {result.denied ? <Button variant="outline" className="self-start" onClick={recheckAccess}>Check access again</Button> : result.error && <QueryError error={result.error} retry={() => void result.refetch()} />}
              </li>
            ))}
            {items.map((item, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Badge tone={item.tone}>{item.agent}</Badge>
                  <span className="min-w-0">{item.text}</span>
                </span>
                <a href={attentionHref(item, `/a/${item.agent}`)} className="flex items-center gap-1 text-sm font-medium hover:underline">
                  {item.action} <ArrowRight size={14} />
                </a>
              </li>
            ))}

          </ul>
          {daos.map((dao, index) => proposals[index]!.isPending
            ? <LoadingRecords key={dao} label={`Checking proposals for ${dao}…`} rows={1} />
            : <ProposalRecords key={dao} dao={dao} data={proposals[index]!.data} error={proposals[index]!.error} />)}
      </Card>
    </Section>
  );
}

/** An agent's state in one line: whether it may act, and what waits on a person. */
function AgentStatus({ result }: { result: ReturnType<typeof useFleet>[number] }) {
  const d = result.data;
  return (
    <div className="flex flex-wrap gap-2">
      {d.overview && !result.reads.overview.error && <Badge tone={d.overview.notInForce ? "destructive" : "success"}>
        {d.overview.policy.policy?.frozen ? "Frozen" : d.overview.notInForce ? "Not in force" : "Policy in force"}
      </Badge>}
      {d.overview && d.autopilot && !result.reads.autopilot.error && kindOf(d.overview) === "treasury" && (
        <Badge tone={d.autopilot.on ? "info" : "neutral"}>{d.autopilot.on ? `Autopilot to $${d.autopilot.maxUsd}` : "Autopilot off"}</Badge>
      )}
    </div>
  );
}

function LatestRun({ name }: { name: string }) {
  const evidence = useQuery({ ...queriesFor(clientFor(`/a/${name}`), `/a/${name}`).runs, retry: false, refetchInterval: 30_000 });
  const latest = evidence.data?.ticks.at(-1);
  const incomplete = Boolean(evidence.data?.corrupt?.length);
  return <div className="text-sm">
    {evidence.isPending && <LoadingRecords label="Loading latest run…" rows={1} />}
    {evidence.error && <QueryError error={evidence.error} retry={() => evidence.refetch()} />}
    {incomplete && <p className="text-warning-muted-foreground">Some run records could not be read. The available history is incomplete.</p>}
    {!evidence.error && latest && <><p>Latest run · {ago(latest.at)}</p><p>{latest.end?.outcome ?? "No end recorded: the run may still be active, interrupted, or its outcome unknown."}</p>
      <a className="underline" href={`/a/${name}/follow/run?run=${encodeURIComponent(latest.id)}`}>Inspect latest run</a></>}
    {evidence.isSuccess && !latest && (incomplete
      ? <Button variant="outline" onClick={() => evidence.refetch()}>Check again</Button>
      : <div className="flex flex-col items-start gap-2"><p>No run found in the retained records.</p><a className="inline-flex min-h-11 items-center underline" href={`/a/${name}/automations`}>Strategy and schedule</a></div>)}
  </div>;
}

/** Compact operating status, with direct links to the work rather than entry cards. */
function AreaStatus({ agents, results }: { agents: GatewayAgent[]; results: ReturnType<typeof useFleet> }) {
  return <Section title="Current status" description="Each agent has its own policy, grant and balance.">
    {!agents.length && <Empty className="items-start"><EmptyContent className="items-start text-left">
      <p>No agents are available to this account.</p><Button variant="outline" onClick={recheckAccess}>Check access again</Button>
    </EmptyContent></Empty>}
    {agents.map((agent, i) => {
      const result = results[i]!;
      const d = result.data;
      const treasury = d.overview ? kindOf(d.overview) === "treasury" : null;
      return <div key={agent.name} className="flex flex-col gap-3 border-b pb-5 last:border-0">
        <h3 className="text-lg font-semibold">{treasury === null ? areaName(agent) : treasury ? "Portfolio" : "Payables"}</h3>
        <p className="break-all text-sm text-muted-foreground">{agent.owner} · {agent.name}</p>
        <AgentStatus result={result} />
        {result.reads.overview.isPending && !result.denied && <LoadingRecords label={`Loading ${areaName(agent)} status…`} rows={1} />}
        {treasury && <LatestRun name={agent.name} />}
        <div className="flex flex-wrap gap-4 text-sm">
          <a className="underline" href={`/a/${agent.name}/`}>{treasury === null ? "Review agent" : treasury ? "Review allocation" : "Review payments"}</a>
          {treasury !== null && <a className="underline" href={treasury ? "/#activity" : `/a/${agent.name}/payees`}>{treasury ? "Review history" : "Review agreements"}</a>}
          <a className="underline" href={`/a/${agent.name}/policy`}>Policy and permissions</a>
        </div>
        <Details summary="Guided walkthrough"><p className="text-sm text-muted-foreground">Use this agent’s real funds with the existing confirmations and owner approvals.</p><a className="inline-flex min-h-11 items-center text-sm underline" href={`/a/${agent.name}/demo`}>Run with real funds</a></Details>
      </div>;
    })}
  </Section>;
}

function WorkspaceOverview({ agents, daos }: { agents: GatewayAgent[]; daos: string[] }) {
  const results = useFleet(agents);
  return <>
    {agents.length > 0 && <NeedsAttention results={results} daos={daos} />}
    <AreaStatus agents={agents} results={results} />
  </>;
}

export function DaoHome({ gateway, activity = false }: { gateway: Gateway; activity?: boolean }) {
  const { agents } = gateway;
  const daos = ownersOf(agents.filter(a => a.dao));
  useEffect(() => {
    document.title = `${activity ? "Activity" : "Home"} · Agentic Treasury`;
    document.getElementById("workspace-main")?.focus();
  }, [activity]);
  return <main id="workspace-main" tabIndex={-1} className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-8">
    <div><h1 className="text-2xl font-semibold">{activity ? "Activity" : "Home"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{activity ? "Retained history, grouped by agent. Each instance retains its own records; missing records are not proof of an outcome." : "Payments to review and treasury operations to follow."}</p></div>
    {activity ? <WorkspaceHistory agents={agents} /> : <WorkspaceOverview agents={agents} daos={daos} />}
  </main>;
}
