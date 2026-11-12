import { ChatCircleText, Flask, ListChecks, Robot, ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { PanelTitle } from "@/components/ui/stat";
import { ago } from "./shared/format";
import { Badge, Button, Card, ErrorBox, Loading, QueryError, Spinner, input } from "./shared/ui";
import { actionWords, statusLine, WHAT_IF_EVENTS, whatIfRequest, type WhatIfEventId } from "./agents-view";
import { Chat, modelFooter, STABILIZATION_EXAMPLES, TREASURY_EXAMPLES, useAssistantStatus, useConversation, useHandOff } from "./assistant";
import { acceptWhatIf, changed, reserveWhatIf, selectWhatIf, subscribe, version, whatIfWorkspace, whatIfWorkspaces } from "./conversations";
import { PageLink } from "./nav";
import { agentAddress } from "./pages";
import type { Identity, RiskHistory } from "./proposals-api";
import type { agentReads } from "./queries";
import { AgentRisk } from "./risk";
import { levelView } from "./risk-view";
import { when } from "./ui";
import { failureText } from "./words";
import { WhatIfResult } from "./what-if-result";

type Reads = ReturnType<typeof agentReads>;

/**
 * Agents (`…/ai`): the two agents the owner can talk to. The stabilization agent (#220) watches the book's forward risk:
 * its latest assessment, what it has been doing, a what-if over its recorded book, and a conversation held to forward
 * risk. The NEAR agent, the treasury assistant (#219), reads the whole app and drafts any change into the flow that already
 * reviews it. Neither signs or sends: a draft opens a form, the owner reviews it and signs in the wallet (or the DAO votes)
 * exactly as without them, and the platform enforces the signed policy when anything executes.
 */
export function Agents({ reads }: { reads: Reads; identity: Identity }) {
  return <div className="flex flex-col gap-8">
    <StabilizationAgent reads={reads} />
    <NearAgent reads={reads} />
  </div>;
}

/** The conversation under an agent's card, or why there isn't one: the server answers questions only where a model is configured. */
function Conversation({ reads, persona, examples, label, placeholder }: {
  reads: Reads; persona: "treasury" | "stabilization"; examples: readonly string[]; label: string; placeholder: string;
}) {
  const { ready, model, loading } = useAssistantStatus(reads);
  const handOff = useHandOff(reads.name);
  if (loading) return <Loading label="Checking whether this server answers questions…" />;
  if (!ready) return <p role="status" className="text-sm text-muted-foreground">This server doesn't answer questions: no model is configured for the assistant, so there is no conversation here. The records on this page are read directly.</p>;
  return <Chat reads={reads} persona={persona} examples={examples} inline scenarioInWorkspace label={label} logLabel={`${label}: conversation`} placeholder={placeholder} footer={modelFooter(model)} onOpen={handOff} />;
}

function StabilizationAgent({ reads }: { reads: Reads }) {
  const history = useQuery(reads.riskHistory);
  const status = history.data ? statusLine(history.data) : undefined;
  const latest = history.data?.entries[0];
  const level = latest ? levelView(latest.level) : undefined;
  return <section id="stabilization-agent" aria-labelledby="stabilization-agent-title" className="flex flex-col gap-4">
    <Card className="gap-3">
      <PanelTitle id="stabilization-agent-title" title="Stabilization agent" icon={<ShieldCheck weight="duotone" />} tone="brand"
        description="Projects the book forward and moves toward safety early, only within your signed limits.">
        {status && <Badge tone={status.running ? "success" : "neutral"}>{status.running ? "Running" : "Not running"}</Badge>}
        {level && <Badge tone={level.tone}>{level.label}</Badge>}
      </PanelTitle>
      {history.isPending ? <Loading label="Reading what the agent has been doing…" />
        : history.isError ? <QueryError error={history.error} retry={() => history.refetch()} />
        : <>
          <p className="text-sm text-muted-foreground">{status!.text}{latest && <> Last assessed <time dateTime={latest.at} title={when(latest.at)}>{ago(latest.at)}</time>.</>}</p>
          <p className="text-xs text-muted-foreground">
            It recommends and you decide: a de-risk is a proposal you approve on the <PageLink to={agentAddress(reads.name, "proposals")} className="underline underline-offset-2">Proposals</PageLink> page,
            and a freeze is only ever recommended, because it takes your signature.
          </p>
        </>}
    </Card>
    <AgentRisk reads={reads} />
    {history.data && <Doing entries={history.data.entries} configured={history.data.configured} />}
    <WhatIf reads={reads} />
    <Card className="gap-3">
      <PanelTitle title="Talk to the stabilization agent" icon={<ChatCircleText weight="duotone" />} tone="info"
        description="Ask why the level is what it is, what it has been doing, or what a crash would do. It can open the autopilot controls, the rebalance form or a freeze review for you; it sends nothing." />
      <Conversation reads={reads} persona="stabilization" examples={STABILIZATION_EXAMPLES} label="Ask the stabilization agent" placeholder="Ask about the risk level, a stress scenario, what it has been doing…" />
    </Card>
  </section>;
}

/** What the agent has been doing: its recent assessments, newest first, from the server's audit log. */
function Doing({ entries, configured }: { entries: RiskHistory["entries"]; configured: boolean }) {
  return <section id="agent-activity" aria-labelledby="agent-activity-title">
    <Card className="gap-3">
      <PanelTitle id="agent-activity-title" title="What it has been doing" icon={<ListChecks weight="duotone" />} tone="info"
        description="Each assessment the agent recorded, newest first." />
      {entries.length === 0
        ? <p role="status" className="text-sm text-muted-foreground">{configured ? "No assessment has been recorded yet: the first is made on the next watch tick." : "No assessment has been recorded: this server isn't running the agent for this treasury."}</p>
        : <ul aria-label="Recent assessments" className="flex flex-col gap-1.5 text-sm">
          {entries.slice(0, 8).map(entry => {
            const level = levelView(entry.level);
            const actions = actionWords(entry.actions);
            return <li key={entry.seq} className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 px-3 py-2">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={level.tone}>{level.label}</Badge>
                <time dateTime={entry.at} title={when(entry.at)} className="text-xs text-muted-foreground">{ago(entry.at)}</time>
                {entry.drawdownPct !== null && <span className="text-xs text-muted-foreground">projected drawdown {entry.drawdownPct.toFixed(1)}%</span>}
                {entry.proposed && <Badge tone="brand">Proposed a de-risk</Badge>}
              </span>
              <span className="text-muted-foreground">{entry.reason}</span>
              {actions.length > 0 && <span className="text-xs">Recommended: {actions.join(", ")}.</span>}
            </li>;
          })}
        </ul>}
    </Card>
  </section>;
}

/**
 * A tail event of the owner's choosing over the book the agent last recorded, run with the agent's own stress arithmetic.
 * It reads and computes: nothing is proposed, and the platform isn't called.
 */
function WhatIf({ reads }: { reads: Reads }) {
  useSyncExternalStore(subscribe, version);
  const workspace = whatIfWorkspace(reads.name);
  const { event, value, answer } = workspace;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { ready } = useAssistantStatus(reads);
  const conversation = useConversation(reads, "stabilization");
  const chosen = WHAT_IF_EVENTS.find(entry => entry.id === event)!;
  const checked = whatIfRequest(event, value);

  const run = async () => {
    const request = whatIfRequest(event, value);
    if (!request.ok) { setError(request.why); return; }
    const selected = reserveWhatIf(reads.name, true);
    changed();
    setError(undefined);
    setBusy(true);
    const sent = selected.fullRequest ?? request.request;
    const result = await reads.agent.riskWhatIf(sent);
    setBusy(false);
    if (whatIfWorkspaces.get(reads.name)?.revision !== selected.revision) return;
    if (result.ok) acceptWhatIf(reads.name, { event: sent, answer: result.value }, selected.revision);
    else setError(failureText(result, "read"));
  };

  const explain = () => {
    if (!checked.ok || !ready || conversation.busy) return;
    reserveWhatIf(reads.name, true);
    changed();
    void conversation.ask("Explain this scenario: what changes, and does the cash floor hold?");
    document.getElementById("assistant-question-stabilization-inline")?.focus();
  };

  return <section id="what-if" aria-labelledby="what-if-title">
    <Card className="gap-3">
      <PanelTitle id="what-if-title" title="Try a what-if" icon={<Flask weight="duotone" />} tone="warning"
        description="Run a tail event over the book the agent last recorded. It's the agent's own arithmetic, not a forecast, and nothing is proposed." />
      <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void run(); }}>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Event
          <select className={`${input} h-10 max-w-full`} value={event} disabled={busy} onChange={e => {
            const next = e.target.value as WhatIfEventId;
            selectWhatIf(reads.name, next, WHAT_IF_EVENTS.find(entry => entry.id === next)!.start); setError(undefined);
          }}>
            {WHAT_IF_EVENTS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Value ({chosen.unit})
          <input className={`${input} h-10 w-28`} inputMode="decimal" value={value} disabled={busy} onChange={e => {
            selectWhatIf(reads.name, event, e.target.value); setError(undefined);
          }} />
        </label>
        <Button type="submit" variant="outline" disabled={busy}>{busy ? <Spinner /> : <Flask aria-hidden="true" />} Run what-if</Button>
      </form>
      {workspace.fullRequest && <p className="text-xs text-muted-foreground">This scenario combines events or targets an asset or venue. Editing a control starts a single-event scenario.</p>}
      {ready && <Button type="button" variant="outline" className="self-start" disabled={busy || conversation.busy || !checked.ok} onClick={explain}>
        <ChatCircleText aria-hidden="true" /> Explain this scenario
      </Button>}
      <ErrorBox error={error} />
      {answer && (answer.result ? <WhatIfResult result={answer.result} />
        : <p role="status" className="text-sm text-muted-foreground">{answer.problems.join(" ")}</p>)}
    </Card>
  </section>;
}

/**
 * The NEAR agent: the treasury assistant (#219) with the whole app in reach. It answers from the treasury's records, each
 * figure cited, and for any change (a rebalance, a strategy, the policy, a grant, autopilot, a freeze) it opens the review
 * that already exists with the fields filled in. It holds no key: the owner signs, or the DAO votes.
 */
function NearAgent({ reads }: { reads: Reads }) {
  return <section id="near-agent" aria-labelledby="near-agent-title">
    <Card className="gap-3">
      <PanelTitle id="near-agent-title" title="NEAR agent" icon={<Robot weight="duotone" />} tone="info"
        description="Ask about anything in this treasury, or tell it what to change: it opens the review for you, with the fields filled in." />
      <p className="text-xs text-muted-foreground">
        It reads balances, budgets, limits, proposals, runs, Ballast's decisions and the risk records, each answer with its sources. It can draft a rebalance, a strategy change,
        a policy edit, a grant, an autopilot control or a freeze, and open any page. It never signs or sends: you review each draft and sign it in your wallet (or the DAO votes).
      </p>
      <Conversation reads={reads} persona="treasury" examples={TREASURY_EXAMPLES} label="Ask the NEAR agent" placeholder="Ask about the treasury, or ask for a change…" />
    </Card>
  </section>;
}
