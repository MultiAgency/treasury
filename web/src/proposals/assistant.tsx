import { ArrowRight, ChatCircleText, PaperPlaneRight, Sparkle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge, Button, ErrorBox, Spinner, input } from "../shared/ui";
import { cn } from "@/lib/utils";
import { openDraft } from "./assistant-drafts";
import { SwapPreview } from "./assistant-note";
import { agentAddress, type AgentPage } from "./pages";
import type { AssistantAnswer, AssistantDraft } from "./proposals-api";
import { agentReads, assistantStatus } from "./queries";
import { when } from "./ui";
import { failureText } from "./words";

/**
 * The treasury assistant (#219): a panel opened from the top bar of every page of an agent, shown where the server
 * answers questions. The owner asks in plain language; the answer cites the reads it came from, each with its time, and
 * a draft opens the existing review flow with its fields filled in. Nothing is sent from here: the flow it opens is where
 * the owner submits and signs. The conversation is the page's own, kept while the owner moves between the agent's pages.
 */
type Entry = { role: "user"; text: string } | { role: "assistant"; answer: AssistantAnswer } | { role: "error"; text: string };
type Turn = { role: "user" | "assistant"; text: string };
type Source = AssistantAnswer["sources"][number];

const EXAMPLES = ["How much of this month's budget is left, and what used it?", "Which proposals are still waiting on me?", "Why didn't autopilot rebalance yesterday?", "Propose a rebalance to 40% wNEAR"];
const DRAFTS: Record<AssistantDraft["kind"], { title: string; opens: string; page?: AgentPage }> = {
  rebalance: { title: "Rebalance proposal", opens: "Open the rebalance proposal", page: "proposals" },
  strategy: { title: "Strategy change", opens: "Open in the strategy editor", page: "strategy" },
  policy: { title: "Policy edit", opens: "Open in the policy editor", page: "policy" },
  grant: { title: "Grant", opens: "Open the grant", page: "strategy" },
  // The freeze is in the frame of every page: its own review opens where the owner is.
  freeze: { title: "Freeze", opens: "Open the freeze review" },
};

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

function DraftCard({ draft, onOpen }: { draft: AssistantDraft; onOpen: () => void }) {
  const { title, opens } = DRAFTS[draft.kind];
  return <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
    <div className="flex items-center gap-2"><Badge tone="brand">Draft</Badge><span className="text-sm font-medium">{title}</span></div>
    {"changes" in draft && draft.changes.length > 0 && <dl aria-label="What it changes" className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {draft.changes.map(change => <Fragment key={change.field}><dt className="text-muted-foreground">{change.field}</dt>
        <dd className="text-right font-mono tabular-nums">{change.from} → <span className="text-foreground">{change.to}</span></dd></Fragment>)}
    </dl>}
    {(draft.kind === "strategy" || draft.kind === "rebalance") && draft.legs && <SwapPreview legs={draft.legs} />}
    {draft.kind === "freeze" && <p className="text-xs text-muted-foreground">Asked: {draft.reason}</p>}
    <p className="text-xs text-muted-foreground">{draft.note}</p>
    <Button size="sm" className="self-start" onClick={onOpen}>{opens} <ArrowRight aria-hidden="true" /></Button>
  </div>;
}

function Reply({ answer, onOpen }: { answer: AssistantAnswer; onOpen: (draft: AssistantDraft) => void }) {
  return <div className="flex flex-col gap-3">
    <Cited answer={answer} />
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

/** The panel for `agent`, once the signed-in account may read it and the server answers questions. */
export function Assistant({ agent }: { agent: string }) {
  const reads = useMemo(() => agentReads(agent), [agent]);
  const identity = useQuery(reads.identity);
  const status = useQuery({ ...assistantStatus, enabled: Boolean(identity.data) });
  if (!status.data?.available || !identity.data || identity.data.agentId === null) return null;
  return <Panel key={agent} reads={reads} model={status.data.model} />;
}

function Panel({ reads, model }: { reads: ReturnType<typeof agentReads>; model: string | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  /** A draft being opened: handed to its flow once the panel has closed, so the flow's own review takes the focus. */
  const handoff = useRef<AssistantDraft>(undefined);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [entries, busy, open]);

  const ask = async (text: string) => {
    const asked = text.trim();
    if (!asked || busy) return;
    // Earlier turns go back as text only; an answer's drafts and sources stay on this page.
    const history = entries.flatMap((entry): Turn[] => entry.role === "user" ? [{ role: "user", text: entry.text.slice(0, 1_200) }]
      : entry.role === "assistant" ? [{ role: "assistant", text: entry.answer.answer.slice(0, 1_200) }] : []).slice(-8);
    setEntries(current => [...current, { role: "user", text: asked }]);
    setQuestion("");
    setBusy(true);
    const answer = await reads.agent.ask(asked, history);
    setBusy(false);
    setEntries(current => [...current, answer.ok ? { role: "assistant", answer: answer.value } : { role: "error",
      text: answer.kind === "refused" && answer.code === "rate_limited" ? "You've asked the most questions an hour allows. Try again later."
        : answer.kind === "refused" && answer.code === "platform_budget" ? "The assistant has used its share of the platform's reads for this hour. Try again later, or read the page directly."
        : answer.kind === "refused" && answer.code === "assistant_not_configured" ? "The assistant isn't set up on this server."
        : answer.kind === "lost" ? "The answer was lost. Asking again is safe: a question sends nothing."
        : failureText(answer, "read") }]);
  };
  const openIn = (draft: AssistantDraft) => { handoff.current = draft; setOpen(false); };
  const handOff = () => {
    const draft = handoff.current;
    handoff.current = undefined;
    if (!draft) return false;
    openDraft(reads.name, draft);
    const page = DRAFTS[draft.kind].page;
    if (page) void navigate({ to: agentAddress(reads.name, page) });
    return true;
  };

  const bubble = (children: ReactNode, mine: boolean) => <div className={cn("max-w-[92%] min-w-0 rounded-lg px-3 py-2", mine ? "self-end bg-secondary text-sm" : "self-start border border-border bg-card")}>{children}</div>;
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild>
      <Button variant="outline" size="sm" className="ml-auto shrink-0"><Sparkle aria-hidden="true" className="text-primary" /><span className="max-sm:sr-only">Ask the treasury</span></Button>
    </SheetTrigger>
    <SheetContent side="right" className="w-full gap-0 sm:max-w-md" aria-describedby="assistant-description"
      onCloseAutoFocus={event => { if (handOff()) event.preventDefault(); }}>
      <SheetHeader className="border-b border-border pr-12">
        <SheetTitle className="flex items-center gap-2"><ChatCircleText aria-hidden="true" className="text-primary" /> Treasury assistant</SheetTitle>
        <SheetDescription id="assistant-description" className="text-xs">Answers from this treasury's records, each figure with its source. It can draft a change for you to review; it never sends anything.</SheetDescription>
      </SheetHeader>
      <div ref={log} role="log" aria-label="Conversation" className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {entries.length === 0 && <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Try asking:</p>
          {EXAMPLES.map(example => <button key={example} type="button" onClick={() => void ask(example)}
            className="rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/5">{example}</button>)}
        </div>}
        {entries.map((entry, index) => entry.role === "user" ? <Fragment key={index}>{bubble(<p className="break-words whitespace-pre-wrap">{entry.text}</p>, true)}</Fragment>
          : entry.role === "assistant" ? <Fragment key={index}>{bubble(<Reply answer={entry.answer} onOpen={openIn} />, false)}</Fragment>
          : <ErrorBox key={index} error={entry.text} />)}
        {busy && <p role="status" className="flex items-center gap-2 self-start text-sm text-muted-foreground"><Spinner /> Reading the records…</p>}
      </div>
      <form className="flex flex-col gap-2 border-t border-border p-3" onSubmit={event => { event.preventDefault(); void ask(question); }}>
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="assistant-question">Your question</label>
          <textarea id="assistant-question" rows={2} maxLength={2_000} value={question} disabled={busy} placeholder="Ask about balances, budgets, proposals, runs…"
            className={cn(input, "min-h-11 flex-1 resize-none py-2")} onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }} />
          <Button type="submit" size="icon" aria-label="Ask" disabled={busy || !question.trim()}><PaperPlaneRight aria-hidden="true" /></Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{model ? <>Answered by <span className="font-mono">{model}</span> from records read on the server. </> : null}Questions and reads are recorded in the audit log by their hashes.</p>
      </form>
    </SheetContent>
  </Sheet>;
}
