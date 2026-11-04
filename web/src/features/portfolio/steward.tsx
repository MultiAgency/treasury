import { Robot, ShieldCheck } from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";
import { useAgent } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall } from "../../app/viewer";
import { agent, failureMessage, type StewardEvent } from "../../platform";
import { useRun } from "../../shared/action-hooks";
import { exactAmountOf, symbolOf } from "../../shared/format";
import { OutcomeError } from "../../shared/outcome-error";
import { useSendBlock } from "../../shared/send-block";
import { Badge, Card, CardHeader, Button, input, Note, Spinner, StatusBadge, statusTone } from "../../shared/ui";
import { cn } from "@/lib/utils";
import { ConfirmButton } from "../owner/confirm-button";
import { usePlanExecution } from "./automations";

/** A tool result: JSON (a book read) folded, anything else as the steward wrote it. */
function ToolResult({ name, result }: { name: string; result: string }) {
  let pretty: string | undefined;
  if (result.startsWith("{")) try { pretty = JSON.stringify(JSON.parse(result), null, 2); } catch { pretty = undefined; }
  if (pretty !== undefined) return <details className="min-w-0 rounded-xl bg-muted/60 px-4 text-xs">
    <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">{name} result</summary>
    <pre className="mt-2 overflow-x-auto font-mono">{pretty}</pre>
  </details>;
  return <p className="min-w-0 break-all text-sm whitespace-pre-wrap"><span className="text-muted-foreground">{name}: </span>{result}</p>;
}

/**
 * The steward (experimental, reached by address only): the platform's model proposes a plan inside the policy, and the
 * owner may execute that plan exactly as proposed. Proposing saves a plan and moves nothing.
 */
export function Steward() {
  const { setup, data } = useAgent();
  const canPropose = useCanCall("steward/propose");
  const canExecute = useCanCall("executePlan");
  const api = useMemo(() => agent(AGENT!), []);
  const proposal = useRun(
    (next: { instruction?: string }, onEvent: (event: StewardEvent) => void) => api.stream("steward/propose", next, onEvent),
    ended => ended);
  const execution = usePlanExecution();
  const sendBlock = useSendBlock();
  const [instruction, setInstruction] = useState("");
  const instructionId = useId();
  const busy = proposal.running || execution.running;
  const plan = proposal.events.find(event => event.type === "plan")?.plan;
  const executed = Boolean(plan && execution.planId === plan.id);
  const executor = setup.executor !== false;
  const proposalError = proposal.error ?? (proposal.outcome && failureMessage(proposal.outcome));

  return <Card>
    <CardHeader icon={<Robot size={20} weight="bold" />} title="Steward (experimental)"
      description="The platform's steward proposes a plan inside the policy, and each response is verified before its tool calls run. Executing runs the plan exactly as proposed." />
    <div className="flex flex-col gap-2 text-sm">
      <label htmlFor={instructionId} className="font-medium">Instructions (optional)</label>
      <textarea id={instructionId} aria-describedby={`${instructionId}-description`} value={instruction} onChange={e => setInstruction(e.target.value)}
        disabled={busy} rows={2} className={cn(input, "h-auto min-h-22 w-full resize-y rounded-xl py-3")} />
      <p id={`${instructionId}-description`} className="text-muted-foreground">Leave empty for a routine review: rebalance if it is worth a fee, shield anything public.</p>
    </div>

    <div className="flex min-h-40 flex-col gap-3">
      {proposal.events.length === 0 && !proposal.running && <Note>Propose reads, quotes and plans. Nothing moves until you execute the plan.</Note>}
      {proposal.events.map((event, i) => {
        switch (event.type) {
          case "plan": return null;
          case "verified": return <div key={i} className="flex justify-end"><Badge tone="success"><ShieldCheck size={12} weight="bold" /> Verified {event.signatureKind} · <span className="font-mono">{event.completionId.slice(0, 8)}</span></Badge></div>;
          case "say": return <p key={i} className="min-w-0 break-words text-sm whitespace-pre-wrap">{event.text}</p>;
          case "call": return <div key={i} className="min-w-0 break-all font-mono text-sm">→ {event.name} <span className="text-muted-foreground">{JSON.stringify(event.input)}</span></div>;
          case "result": return <ToolResult key={i} name={event.name} result={event.result} />;
        }
      })}
      {proposal.running && <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Thinking…</span>}
      {plan && <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-4 text-sm">
        <span className="font-medium">Plan <span className="font-mono">{plan.id.slice(0, 8)}</span> · valid until {new Date(plan.expiresAt).toLocaleTimeString()}</span>
        <ol aria-label="Proposed plan" className="flex flex-col gap-2">{plan.actions.map((action, i) => {
          const done = execution.events.find(event => event.type === "action" && event.index === i);
          return <li key={i} className="flex flex-wrap items-center gap-2 break-all font-mono">
            {i + 1}. {action.type === "swap"
              ? `swap ${exactAmountOf(action.amount, action.from, data.book)} → ${symbolOf(action.to, data.book)} · floor ${exactAmountOf(action.minAmountOut, action.to, data.book)} · ${action.costBps} bps`
              : `shield ${exactAmountOf(action.amount, action.asset, data.book)}`}
            {done?.type === "action" && done.shield && <Badge tone={statusTone(done.shield.status)}>shield {done.shield.status.toLowerCase()}</Badge>}
            {done?.type === "action" && <StatusBadge status={done.status} failureCode={done.failureCode} />}
          </li>;
        })}</ol>
      </div>}
      <OutcomeError error={proposalError ?? execution.error} kind={proposalError ? proposal.outcome?.kind : execution.kind} />
      {!executor && <Note>Proposals and execution are available on this treasury’s executor.</Note>}
      {sendBlock && <Note>{sendBlock}</Note>}
      {execution.unsettled && <p className="text-sm">Execute plan isn’t offered again from this page: this plan’s outcome isn’t proven. Follow its operations in Activity.</p>}
    </div>

    <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{!proposal.running && proposal.events.length > 0 && !plan && !proposalError && "Nothing proposed: nothing to execute."}</span>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy || !canPropose || !executor} onClick={() => void proposal.run(instruction ? { instruction } : {})}>
          {proposal.running && <Spinner />} Propose
        </Button>
        <ConfirmButton
          path="executePlan"
          label={execution.running ? <><Spinner /> Executing</> : "Execute plan"}
          disabled={busy || !plan || executed || !executor || Boolean(sendBlock) || execution.unsettled}
          title="Execute this plan on mainnet?"
          description="Runs the proposed steps exactly as shown, under the agent's grant, each swap held to its previewed floor. Actions run in sequence. Checks run before execution and before later actions; if execution stops, earlier completed actions remain."
          confirm="Execute plan"
          reviewKey={plan?.id}
          summary={plan && <ol aria-label="Steps in this plan" className="flex flex-col gap-1 border-t pt-4 text-sm break-all">{plan.actions.map((action, i) => <li key={i}>
            {action.type === "swap" ? `Swap ${exactAmountOf(action.amount, action.from, data.book)} → ${symbolOf(action.to, data.book)}, minimum received ${exactAmountOf(action.minAmountOut, action.to, data.book)}`
              : `Shield ${exactAmountOf(action.amount, action.asset, data.book)}`}
          </li>)}</ol>}
          onConfirm={() => { if (plan && !busy && !executed && !sendBlock && canExecute && !execution.unsettled) void execution.execute(plan.id); }}
        />
      </div>
    </div>
  </Card>;
}
