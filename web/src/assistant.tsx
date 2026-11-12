import { ArrowRight, ChatCircleText, PaperPlaneRight, Sparkle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge, Button, ErrorBox, Spinner, input } from "./shared/ui";
import { cn } from "@/lib/utils";
import { openDraft } from "./assistant-drafts";
import { askConversation } from "./conversation-request";
import { busyKeys, conversationKey, conversations, NONE, subscribe, toolProgress, version } from "./conversations";
import { SwapPreview } from "./assistant-note";
import { AGENT_PAGES, agentAddress, type AgentPage } from "./pages";
import type { AssistantAnswer, AssistantDraft, AssistantPersona } from "./server-api";
import { agentReads, assistantStatus } from "./queries";
import { WhatIfResult } from "./what-if-result";
import { when } from "./ui";

/**
 * The treasury assistant (#219): a panel opened from the top bar of every page of an agent, shown where the server
 * answers questions, and the same conversation inline on the Agents page. The owner asks in plain language; the answer
 * cites the reads it came from, each with its time, and a draft opens the existing review flow with its fields filled in.
 * Nothing is sent from here: the flow it opens is where the owner submits and signs. A conversation is kept while the owner
 * moves between the agent's pages, per agent and per persona (the treasury assistant, or the stabilization agent).
 */
type Source = AssistantAnswer["sources"][number];
type Reads = ReturnType<typeof agentReads>;

export const TREASURY_EXAMPLES = ["How much of this month's budget is left, and what used it?", "Which proposals are still waiting on me?", "Why didn't autopilot rebalance yesterday?", "Propose a rebalance to 40% wNEAR"];
export const STABILIZATION_EXAMPLES = ["Why is the risk level what it is?", "What have you been doing?", "What if NEAR falls 50% tomorrow?", "Pause autopilot"];

const DRAFTS: Record<AssistantDraft["kind"], { title: string; opens: string; page?: AgentPage }> = {
  rebalance: { title: "Rebalance proposal", opens: "Open the rebalance proposal", page: "proposals" },
  strategy: { title: "Strategy change", opens: "Open in the strategy editor", page: "strategy" },
  policy: { title: "Policy edit", opens: "Open in the policy editor", page: "policy" },
  grant: { title: "Grant", opens: "Open the grant", page: "strategy" },
  // The freeze is in the frame of every page: its own review opens where the owner is.
  freeze: { title: "Freeze", opens: "Open the freeze review" },
  autopilot: { title: "Autopilot control", opens: "Open the autopilot controls", page: "strategy" },
  // A page draft names its own page.
  page: { title: "Open a page", opens: "Open the page" },
};

/**
 * Hands a draft to the flow it opens, and goes to that flow's page. A draft is held in memory until the flow takes it,
 * and nothing is sent: the owner still reviews and signs there. A page draft only goes to the page.
 */
export function useHandOff(agent: string) {
  const navigate = useNavigate();
  return (draft: AssistantDraft) => {
    if (draft.kind === "page") { void navigate({ to: agentAddress(agent, draft.page) }); return; }
    openDraft(agent, draft);
    const page = DRAFTS[draft.kind].page;
    if (page) void navigate({ to: agentAddress(agent, page) });
  };
}


/** One conversation's entries, whether an answer is being read, and asking. Earlier turns go back as text only; an answer's drafts and sources stay on the page. */
export function useConversation(reads: Reads, persona: AssistantPersona) {
  const key = conversationKey(reads.name, persona);
  useSyncExternalStore(subscribe, version);
  const entries = conversations.get(key) ?? NONE;
  const busy = busyKeys.has(key);
  const activeTool = [...(toolProgress.get(key)?.values() ?? [])].at(-1);
  const progress = activeTool ? progressLabel(activeTool) : "Preparing the answer…";
  const ask = (text: string) => askConversation(reads.name, persona, reads.agent.askStream, text);
  return { entries, busy, progress, ask };
}

const TOOL_PROGRESS: Record<string, string> = {
  get_overview: "Reading holdings and policy…", get_strategy: "Reading the strategy…", get_autopilot: "Checking autopilot…",
  get_runs: "Reading recent runs…", get_activity: "Reading activity…", get_unresolved: "Checking unresolved operations…",
  get_held: "Reading held payouts…", list_proposals: "Reading proposals…", get_proposal: "Reading the proposal…",
  get_owner_actions: "Reading owner actions…", get_policy_history: "Reading policy history…", get_account: "Reading the treasury account…",
  get_ballast_decisions: "Reading strategy decisions…", get_audit_trail: "Reading the audit trail…", get_dao_requests: "Reading DAO requests…",
  list_strategy_proposals: "Reading proposed strategies…", get_risk_report: "Reading the latest risk assessment…",
  get_risk_history: "Reading recent risk assessments…", run_what_if: "Calculating the scenario…",
  draft_rebalance: "Drafting a rebalance for review…", draft_strategy: "Drafting strategy changes…", draft_policy_edit: "Drafting policy changes…",
  draft_grant: "Preparing the grant review…", draft_freeze: "Preparing the freeze review…", draft_autopilot: "Preparing the autopilot review…",
  open_page: "Finding the page…",
};
const progressLabel = (tool: string) => TOOL_PROGRESS[tool] ?? "Reading the records…";

/** One source mark, `S1`: the read or record it names and when it was read, on hover or focus. */
function Mark({ source }: { source: Source }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" aria-label={`Source ${source.id}: ${source.label}, read ${when(source.at)}`}
        className="mx-0.5 inline-flex rounded-sm bg-primary/12 px-1 align-baseline font-mono text-[11px] leading-4 text-primary hover:bg-primary/20">{source.id}</button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-64">{source.label} · read {when(source.at)}</TooltipContent>
  </Tooltip>;
}

/** The answer's text, its `[S1]` citations shown as source marks: text only, so nothing in an answer becomes markup or a link. */
function Cited({ answer }: { answer: AssistantAnswer }) {
  const parts = answer.answer.split(/(\[S\d+\])/g);
  return <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{parts.map((part, index) => {
    const id = /^\[(S\d+)\]$/.exec(part)?.[1];
    const source = id && answer.sources.find(entry => entry.id === id);
    return source ? <Mark key={index} source={source} /> : <Fragment key={index}>{part}</Fragment>;
  })}</p>;
}

const AUTOPILOT_WORDS = { on: "Turn autopilot on", off: "Turn autopilot off", "run-now": "Run autopilot once now" } as const;

function DraftCard({ draft, onOpen }: { draft: AssistantDraft; onOpen: () => void }) {
  const { title, opens } = DRAFTS[draft.kind];
  const target = draft.kind === "page" ? AGENT_PAGES[draft.page].title : undefined;
  return <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
    <div className="flex items-center gap-2"><Badge tone="brand">Draft</Badge><span className="text-sm font-medium">{title}</span></div>
    {"changes" in draft && draft.changes.length > 0 && <dl aria-label="What it changes" className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {draft.changes.map(change => <Fragment key={change.field}><dt className="text-muted-foreground">{change.field}</dt>
        <dd className="text-right font-mono tabular-nums">{change.from} → <span className="text-foreground">{change.to}</span></dd></Fragment>)}
    </dl>}
    {(draft.kind === "strategy" || draft.kind === "rebalance") && draft.legs && <SwapPreview legs={draft.legs} />}
    {draft.kind === "freeze" && <p className="text-xs text-muted-foreground">Asked: {draft.reason}</p>}
    {draft.kind === "autopilot" && <p className="text-xs text-muted-foreground">Asked: {AUTOPILOT_WORDS[draft.action]}.</p>}
    {draft.kind === "page" && <p className="text-xs text-muted-foreground">{target}: {draft.why}</p>}
    <p className="text-xs text-muted-foreground">{draft.note}</p>
    <Button size="sm" className="self-start" onClick={onOpen}>{draft.kind === "page" ? `Open ${target}` : opens} <ArrowRight aria-hidden="true" /></Button>
  </div>;
}

function Reply({ answer, onOpen, showScenario }: { answer: AssistantAnswer; onOpen: (draft: AssistantDraft) => void; showScenario: boolean }) {
  return <div className="flex flex-col gap-3">
    <Cited answer={answer} />
    {showScenario && answer.whatIf?.answer.result && <WhatIfResult result={answer.whatIf.answer.result} />}
    {answer.drafts.map((draft, index) => <DraftCard key={index} draft={draft} onOpen={() => onOpen(draft)} />)}
    {answer.sources.length > 0 && <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
      <p className="font-medium">Sources</p>
      <ul aria-label="Sources" className="flex flex-col gap-0.5">{answer.sources.map(source => <li key={source.id} className="flex flex-wrap gap-x-1.5">
        <span className="font-mono text-primary">{source.id}</span><span className="text-foreground">{source.label}</span>
        <span>· read <time dateTime={source.at}>{when(source.at)}</time></span></li>)}</ul>
    </div>}
    {answer.stopped === "tool_budget" && <p className="text-xs text-muted-foreground">This answer stopped at its read limit: some parts may be unchecked.</p>}
    {answer.stopped === "truncated" && <p className="text-xs text-muted-foreground">This answer was cut short. Try asking more narrowly.</p>}
  </div>;
}

/**
 * A conversation with one of the two agents: the log, its example questions, and the form. Used in the sheet and inline on
 * the Agents page; `onOpen` takes a draft the owner chose to open. `inline` fills its container's height instead of a sheet's.
 */
export function Chat({ reads, persona, examples, label = "Your question", logLabel = "Conversation", placeholder, footer, onOpen, inline = false, scenarioInWorkspace = false }: {
  reads: Reads; persona: AssistantPersona; examples: readonly string[]; label?: string; logLabel?: string; placeholder: string; footer?: ReactNode;
  onOpen: (draft: AssistantDraft) => void; inline?: boolean; scenarioInWorkspace?: boolean;
}) {
  const { entries, busy, progress, ask } = useConversation(reads, persona);
  const [question, setQuestion] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const field = `assistant-question-${persona}${inline ? "-inline" : ""}`;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [entries, busy, progress]);
  const submit = (text: string) => { setQuestion(""); void ask(text); };
  const bubble = (children: ReactNode, mine: boolean) => <div className={cn("max-w-[92%] min-w-0 rounded-lg px-3 py-2", mine ? "self-end bg-secondary text-sm" : "self-start border border-border bg-card")}>{children}</div>;
  return <>
    <div ref={log} role="log" aria-label={logLabel} className={cn("flex flex-col gap-3 overflow-y-auto p-4", inline ? "h-96 rounded-lg border border-border bg-background/40" : "flex-1")}>
      {entries.length === 0 && <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Try asking:</p>
        {examples.map(example => <button key={example} type="button" disabled={busy} onClick={() => submit(example)}
          className="rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/5">{example}</button>)}
      </div>}
      {entries.map((entry, index) => entry.role === "user" ? <Fragment key={index}>{bubble(<p className="break-words whitespace-pre-wrap">{entry.text}</p>, true)}</Fragment>
        : entry.role === "assistant" ? <Fragment key={index}>{bubble(<Reply answer={entry.answer} onOpen={onOpen} showScenario={!scenarioInWorkspace} />, false)}</Fragment>
        : <ErrorBox key={index} error={entry.text} />)}
      {busy && <p role="status" className="flex items-center gap-2 self-start text-sm text-muted-foreground"><Spinner /> {progress}</p>}
    </div>
    <form className={cn("flex flex-col gap-2", inline ? "pt-3" : "border-t border-border p-3")} onSubmit={event => { event.preventDefault(); submit(question); }}>
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={field}>{label}</label>
        <textarea id={field} rows={2} maxLength={2_000} value={question} disabled={busy} placeholder={placeholder}
          className={cn(input, "min-h-11 flex-1 resize-none py-2")} onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(question); } }} />
        <Button type="submit" size="icon" aria-label={inline ? `Ask: ${label}` : "Ask"} disabled={busy || !question.trim()}><PaperPlaneRight aria-hidden="true" /></Button>
      </div>
      {footer}
    </form>
  </>;
}

/** What the assistant's footer says about the model and the audit log. */
export const modelFooter = (model: string | null) =>
  <p className="text-[11px] text-muted-foreground">{model ? <>Answered by <span className="font-mono">{model}</span> from records read on the server. </> : null}Questions and reads are recorded in the audit log by their hashes.</p>;

/** Whether the server answers questions, and the model that does: read once a session, and only for an agent that exists. */
export function useAssistantStatus(reads: Reads) {
  const identity = useQuery(reads.identity);
  const status = useQuery({ ...assistantStatus, enabled: Boolean(identity.data) });
  const ready = Boolean(status.data?.available && identity.data && identity.data.agentId !== null);
  return { ready, model: status.data?.model ?? null, loading: identity.isPending || status.isPending };
}

/** The panel for `agent`, once the signed-in account may read it and the server answers questions. */
export function Assistant({ agent }: { agent: string }) {
  const reads = useMemo(() => agentReads(agent), [agent]);
  const { ready, model } = useAssistantStatus(reads);
  if (!ready) return null;
  return <Panel key={agent} reads={reads} model={model} />;
}

function Panel({ reads, model }: { reads: Reads; model: string | null }) {
  const [open, setOpen] = useState(false);
  const handOff = useHandOff(reads.name);
  /** A draft being opened: handed to its flow once the panel has closed, so the flow's own review takes the focus. */
  const handoff = useRef<AssistantDraft>(undefined);
  const openIn = (draft: AssistantDraft) => { handoff.current = draft; setOpen(false); };
  const hand = () => {
    const draft = handoff.current;
    handoff.current = undefined;
    if (!draft) return false;
    handOff(draft);
    return true;
  };
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild>
      <Button variant="outline" size="sm" className="ml-auto shrink-0"><Sparkle aria-hidden="true" className="text-primary" /><span className="max-sm:sr-only">Ask the treasury</span></Button>
    </SheetTrigger>
    <SheetContent side="right" className="w-full gap-0 sm:max-w-md" aria-describedby="assistant-description"
      onCloseAutoFocus={event => { if (hand()) event.preventDefault(); }}>
      <SheetHeader className="border-b border-border pr-12">
        <SheetTitle className="flex items-center gap-2"><ChatCircleText aria-hidden="true" className="text-primary" /> Treasury assistant</SheetTitle>
        <SheetDescription id="assistant-description" className="text-xs">Answers from this treasury's records, each figure with its source. It can draft a change for you to review; it never sends anything.</SheetDescription>
      </SheetHeader>
      <Chat reads={reads} persona="treasury" examples={TREASURY_EXAMPLES} placeholder="Ask about balances, budgets, proposals, runs…" footer={modelFooter(model)} onOpen={openIn} />
    </SheetContent>
  </Sheet>;
}
