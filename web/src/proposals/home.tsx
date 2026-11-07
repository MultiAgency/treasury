import { useQuery } from "@tanstack/react-query";
import { ago } from "../shared/format";
import { Card, Loading, QueryError, short } from "../shared/ui";
import { PageLink } from "./nav";
import { needsDecision, type Need } from "./needs-decision";
import { agentAddress, proposalAddress } from "./pages";
import type { Identity } from "./proposals-api";
import type { agentReads } from "./queries";
import { when } from "./ui";

type Reads = ReturnType<typeof agentReads>;

/** Where an item leads, and what its link says. */
function NeedLink({ need, agent }: { need: Need; agent: string }) {
  const { target } = need;
  if (target.page === "proposal") return <PageLink to={proposalAddress(agent, target.id)} className="underline">Review proposal {short(target.id, 12)}</PageLink>;
  if (target.page === "connection") return <PageLink to={agentAddress(agent)} hash="connection" className="underline">Open the connection</PageLink>;
  // Until the Activity page (#136), the portfolio's Activity card.
  return <PageLink to={agentAddress(agent)} hash="activity" className="underline">Check the activity</PageLink>;
}

/**
 * What needs the owner, at the top of the agent's home (#130): proposals awaiting a decision or approved and not
 * executed, operations without a proven outcome, and for a DAO-owned agent the requests waiting for its vote. Built from
 * reads the page already makes. Empty, it says nothing needs a decision. Not connected, only the DAO's requests can be
 * read, so only they show (and nothing, when there are none: the connection says what is wrong).
 */
export function NeedsDecision({ reads, identity, connected }: { reads: Reads; identity: Identity; connected: boolean }) {
  const proposals = useQuery({ ...reads.glance.proposals, enabled: connected });
  const unresolved = useQuery({ ...reads.unresolved, enabled: connected });
  const dao = useQuery({ ...reads.daoRequests, enabled: identity.signer === "dao" });
  const failing = [[proposals, "proposals"], [unresolved, "unresolved operations"], [dao, "the DAO's requests"]] as const;
  const pending = (connected && (proposals.isPending || unresolved.isPending)) || (identity.signer === "dao" && dao.isPending);
  const items = needsDecision({ proposals: proposals.data ?? [], unresolved: unresolved.data ?? [], daoRequests: dao.data ?? [], now: Date.now() });
  if (!connected && items.length === 0) return null;

  return <section id="needs-decision" aria-labelledby="needs-decision-title" className="flex flex-col gap-4">
    <h2 id="needs-decision-title" className="text-xl font-semibold">Needs your decision</h2>
    <Card>
      {failing.map(([read, what]) => read.isError && <QueryError key={what} error={read.error} retry={() => read.refetch()} />)}
      {pending ? <Loading label="Reading what needs your decision…" />
        : items.length === 0 ? (failing.some(([read]) => read.isError) ? null : <p className="text-sm" role="status">Nothing needs a decision.</p>)
        : <ul aria-label="Needs your decision" className="flex flex-col gap-4 text-sm">
          {items.map(need => <li key={need.key} className="flex flex-col gap-1">
            <span>{need.text}</span>
            <span className="text-muted-foreground">
              {need.deadline !== null ? <>Expires {when(new Date(need.deadline).toISOString())} ({ago(new Date(need.deadline).toISOString())})</> : need.at && <>Since {ago(need.at)}</>}
            </span>
            <NeedLink need={need} agent={identity.agent} />
          </li>)}
        </ul>}
    </Card>
  </section>;
}

/** Where the agent stands, one line each (#130): the policy, whether the grant binds the saved strategy, and autopilot. */
export function Standing({ reads, identity }: { reads: Reads; identity: Identity }) {
  const overview = useQuery(reads.overview);
  const strategy = useQuery(reads.glance.strategy);
  const autopilot = useQuery(reads.glance.autopilot);
  const line = (label: string, read: { isPending: boolean; isError: boolean }, text: string | undefined, to?: string) => <li className="flex flex-wrap gap-x-2">
    <span className="font-medium">{label}</span>
    {read.isPending ? <span className="text-muted-foreground">Reading…</span> : read.isError || text === undefined ? <span role="alert">Couldn't be read.</span> : <span>{text}</span>}
    {to && <PageLink to={to} className="underline">Open</PageLink>}
  </li>;
  return <section id="standing" aria-labelledby="standing-title" className="flex flex-col gap-4">
    <h2 id="standing-title" className="text-xl font-semibold">Where the agent stands</h2>
    <Card>
      <ul aria-label="Where the agent stands" className="flex flex-col gap-2 text-sm">
        {/* The Policy page is #142's: the line links to it once it exists. */}
        {line("Policy", overview, overview.data && (overview.data.notInForce ? `Not in force: ${overview.data.notInForce}` : `In force, revision ${overview.data.policy.revision ?? "—"}`))}
        {line("Strategy", strategy, strategy.data && (strategy.data.grantMatches === null ? "This host only approves: the strategy is authorized on the agent's executor" : strategy.data.grantMatches ? "Authorized: the agent's grant binds the saved strategy" : "Not authorized: no grant binds the saved strategy"), agentAddress(identity.agent, "strategy"))}
        {line("Autopilot", autopilot, autopilot.data && (autopilot.data.on ? "On" : "Off"), agentAddress(identity.agent, "strategy"))}
      </ul>
    </Card>
  </section>;
}
