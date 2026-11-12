import { ArrowRight, Bell, CheckCircle, Compass } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PanelTitle } from "@/components/ui/stat";
import { ago } from "./shared/format";
import { Badge, Card, Loading, QueryError, short, type Tone } from "./shared/ui";
import { unresolvedAnchor } from "./activity-view";
import { PageLink } from "./nav";
import { needsDecision, type Need } from "./needs-decision";
import { agentAddress, proposalAddress } from "./pages";
import type { Identity } from "./server-api";
import type { agentReads } from "./queries";
import { when } from "./ui";

type Reads = ReturnType<typeof agentReads>;

const LINK = "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium whitespace-nowrap hover:bg-accent md:min-h-8";

/** Where an item leads, and what its link says. */
function NeedLink({ need, agent }: { need: Need; agent: string }) {
  const { target } = need;
  const arrow = <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  if (target.page === "proposal") return <PageLink to={proposalAddress(agent, target.id)} className={LINK}>Review proposal {short(target.id, 12)}{arrow}</PageLink>;
  if (target.page === "connection") return <PageLink to={agentAddress(agent)} hash="connection" className={LINK}>Open the connection{arrow}</PageLink>;
  // A pending owner action is signed or voted on where it was asked for: the emergency stop in the frame (a freeze or
  // unfreeze), the Strategy page (a grant), else the owner's actions on the Activity page.
  if (target.page === "owner-action") {
    const where = target.type === "agent_freeze" || target.type === "agent_unfreeze" ? { to: agentAddress(agent), hash: "emergency-stop" }
      : target.type === "grant_issue" ? { to: agentAddress(agent, "strategy"), hash: undefined } : { to: agentAddress(agent, "activity"), hash: "owner-actions" };
    return <PageLink to={where.to} hash={where.hash} className={LINK}>Open where it is signed or voted on{arrow}</PageLink>;
  }
  // The Activity page, at the operation's entry (#136).
  return <PageLink to={agentAddress(agent, "activity")} hash={unresolvedAnchor(target.key)} className={LINK}>Check the activity{arrow}</PageLink>;
}

/** What kind of thing waits, as a status: amber for a decision or an unproven outcome, blue for a vote or an approved proposal. */
const KIND: Record<Need["kind"], { label: string; tone: Tone; bar: string }> = {
  "open-proposal": { label: "Decision", tone: "warning", bar: "bg-warning" },
  "approved-proposal": { label: "Approved", tone: "info", bar: "bg-info" },
  unresolved: { label: "Unresolved", tone: "warning", bar: "bg-warning" },
  "dao-consent": { label: "DAO vote", tone: "info", bar: "bg-info" },
  "dao-vote": { label: "DAO vote", tone: "info", bar: "bg-info" },
  "owner-action": { label: "DAO vote", tone: "info", bar: "bg-info" },
};

/** A time relative to now, with the exact time on hover. */
const At = ({ iso }: { iso: string }) => <time dateTime={iso} title={when(iso)}>{ago(iso)}</time>;

/**
 * What needs the owner, at the top of the agent's home (#130): proposals awaiting a decision or approved and not
 * executed, operations without a proven outcome, and for a DAO-owned agent the requests waiting for its vote. Built from
 * reads the page already makes. Empty, it says nothing needs a decision. Not connected, only the DAO's requests can be
 * read, so only they show (and nothing, when there are none: the connection says what is wrong).
 */
export function NeedsDecision({ reads, identity, connected }: { reads: Reads; identity: Identity; connected: boolean }) {
  const proposals = useQuery({ ...reads.proposals, refetchInterval: false, enabled: connected });
  const unresolved = useQuery({ ...reads.unresolved, enabled: connected });
  const dao = useQuery({ ...reads.daoRequests, enabled: identity.signer === "dao" });
  // The owner's actions and where each stands: the same read the emergency stop makes, so one read serves both.
  const actions = useQuery({ ...reads.ownerActions, enabled: connected });
  const failing = [[proposals, "proposals"], [unresolved, "unresolved operations"], [dao, "the DAO's requests"], [actions, "pending owner actions"]] as const;
  const pending = (connected && (proposals.isPending || unresolved.isPending || actions.isPending)) || (identity.signer === "dao" && dao.isPending);
  const items = needsDecision({ proposals: proposals.data ?? [], unresolved: unresolved.data ?? [], daoRequests: dao.data ?? [], ownerActions: actions.data ?? [], now: Date.now() });
  if (!connected && items.length === 0) return null;
  const failed = failing.some(([read]) => read.isError);

  return <section id="needs-decision" aria-labelledby="needs-decision-title">
    <Card className="gap-3">
      <PanelTitle id="needs-decision-title" title="Needs your decision" icon={<Bell weight="duotone" />} tone={items.length ? "warning" : "success"}>
        {!pending && !failed && <Badge tone={items.length ? "warning" : "success"}>{items.length ? `${items.length} waiting` : "Clear"}</Badge>}
      </PanelTitle>
      {failing.map(([read, what]) => read.isError && <QueryError key={what} error={read.error} retry={() => read.refetch()} />)}
      {pending ? <Loading label="Reading what needs your decision…" />
        : items.length === 0 ? (failed ? null : <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><CheckCircle aria-hidden="true" className="size-4 text-success" />Nothing needs a decision.</p>)
        : <ul aria-label="Needs your decision" className="flex flex-col gap-2 text-sm">
          {items.map(need => {
            const kind = KIND[need.kind];
            return <li key={need.key} className="relative flex flex-col gap-3 overflow-hidden rounded-lg border border-border bg-background/40 py-3 pr-3 pl-4 sm:flex-row sm:items-center sm:justify-between">
              <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${kind.bar}`} />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="break-words">{need.text}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge tone={kind.tone}>{kind.label}</Badge>
                  {need.deadline !== null ? <span>Expires <At iso={new Date(need.deadline).toISOString()} /></span> : need.at && <span>Recorded <At iso={need.at} /></span>}
                </span>
              </div>
              <NeedLink need={need} agent={identity.agent} />
            </li>;
          })}
        </ul>}
    </Card>
  </section>;
}

type Status = { tone: Tone; text: string; detail?: ReactNode };

/** One cell of where the agent stands: its label, its status as a badge, a line of detail, and the page it is set on. */
function StandingCell({ label, read, status, to }: { label: string; read: { isPending: boolean; isError: boolean }; status: Status | undefined; to: string }) {
  // On a phone, one row each (label, status, Open) with the detail under it; side by side from `sm`, stacked in a tile.
  return <li className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_auto] content-start items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
    <span className="text-xs text-muted-foreground">{label}</span>
    {read.isPending ? <span className="col-start-2 row-start-1 text-sm text-muted-foreground sm:col-span-2 sm:col-start-1 sm:row-start-2">Reading…</span>
      : read.isError || status === undefined ? <span className="col-start-2 row-start-1 text-sm sm:col-span-2 sm:col-start-1 sm:row-start-2" role="alert">Couldn't be read.</span>
      : <>
        <span className="col-start-2 row-start-1 sm:col-span-2 sm:col-start-1 sm:row-start-2"><Badge tone={status.tone}>{status.text}</Badge></span>
        {status.detail && <span className="col-span-3 text-xs text-muted-foreground sm:col-span-2">{status.detail}</span>}
      </>}
    <PageLink to={to} className="col-start-3 row-start-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground sm:col-start-2">Open</PageLink>
  </li>;
}

/** Where the agent stands, one cell each (#130): the policy, whether the grant binds the saved strategy, and autopilot. */
export function Standing({ reads, identity }: { reads: Reads; identity: Identity }) {
  const overview = useQuery(reads.overview);
  const strategy = useQuery(reads.strategy);
  const autopilot = useQuery(reads.autopilot);
  const policy: Status | undefined = overview.data && (overview.data.notInForce ? { tone: "warning", text: "Not in force", detail: overview.data.notInForce }
    : { tone: "success", text: "In force", detail: `Revision ${overview.data.policy.revision ?? "—"}` });
  const bound: Status | undefined = strategy.data && (strategy.data.grantMatches === null ? { tone: "info", text: "Executor", detail: "This host only approves: the strategy is authorized on the agent's executor" }
    : strategy.data.grantMatches ? { tone: "success", text: "Authorized", detail: "The agent's grant binds the saved strategy" }
    : { tone: "warning", text: "Not authorized", detail: "No grant binds the saved strategy" });
  const schedule = autopilot.data;
  const running: Status | undefined = schedule && (schedule.on
    ? { tone: "success", text: "On", detail: schedule.nextRun ? <>Next run <At iso={schedule.nextRun} /></> : `Every ${schedule.everyMin} minutes` }
    : { tone: "neutral", text: "Off", detail: schedule.lastRun ? <>Last run <At iso={schedule.lastRun} /></> : "Not scheduled" });
  return <section id="standing" aria-labelledby="standing-title">
    <Card className="gap-3">
      <PanelTitle id="standing-title" title="Where the agent stands" icon={<Compass weight="duotone" />} tone="brand" />
      <ul aria-label="Where the agent stands" className="grid gap-2 text-sm sm:grid-cols-3">
        <StandingCell label="Policy" read={overview} status={policy} to={agentAddress(identity.agent, "policy")} />
        <StandingCell label="Strategy" read={strategy} status={bound} to={agentAddress(identity.agent, "strategy")} />
        <StandingCell label="Autopilot" read={autopilot} status={running} to={agentAddress(identity.agent, "strategy")} />
      </ul>
    </Card>
  </section>;
}
