import { ConfirmButton } from "../owner/confirm-button";
import { Robot, ShieldCheck } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { inputStyles } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { amountOf, client, useRun } from "../../shared/lib";
import { useAgent } from "../../app/agent-context";
import { useCanCall } from "../../app/viewer";
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, NotExecuted, Spinner, StatusBadge, statusTone } from "../../shared/ui";

/** A tool result that starts like this was stopped by the policy or the cost cap, or not proposed. */
const resultTone = (result: string) =>
  /^(REFUSED|ERROR)/.test(result) ? "destructive" : /^(NOT PROPOSED|ALREADY)/.test(result) ? "warning" : /^PROPOSED/.test(result) ? "info" : "neutral";

export function Steward() {
  const canPropose = useCanCall("steward/propose");
  const { data } = useAgent();
  const symbol = (asset: string) => data.book.find((h) => h.asset === asset)?.symbol ?? asset;
  const proposal = useRun(client.steward.propose, []);
  const execution = useRun(client.executePlan);
  const [instruction, setInstruction] = useState("");
  const instructionId = useId();
  const busy = proposal.state === "running" || execution.state === "running";
  const plan = proposal.events.find((e) => e.type === "plan")?.plan;
  const executed = execution.input?.planId === plan?.id && execution.state !== "idle";

  return (
    <Card>
      <CardHeader
        icon={<Robot size={20} weight="bold" />}
        title="Steward (experimental)"
        description="GLM 5.3 Flash on NEAR AI Cloud proposes a plan inside the policy. Each response is signed in a TEE and verified before its tool calls run. Executing runs the plan exactly as proposed."
      />

      <Field data-disabled={busy}>
        <FieldLabel htmlFor={instructionId}>Instructions (optional)</FieldLabel>
        <textarea
          id={instructionId}
          aria-describedby={`${instructionId}-description`}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
          rows={2}
          className={cn(inputStyles, "h-auto min-h-22 w-full resize-y rounded-xl py-3")}
        />
        <FieldDescription id={`${instructionId}-description`}>Leave empty for a routine review: rebalance if it is worth a fee, shield anything public.</FieldDescription>
      </Field>

      <div className="flex min-h-40 flex-col gap-3">
        {proposal.events.length === 0 && proposal.state === "idle" && (
          <Empty icon={<Robot size={24} />}>Propose reads, quotes and plans. Nothing moves until you execute the plan.</Empty>
        )}
        {proposal.events.map((event, i) => {
          if (event.type === "plan") return null;
          if (event.type === "verified")
            return (
              <div key={i} className="flex justify-end">
                <Badge tone="success">
                  <ShieldCheck size={12} weight="bold" /> Verified {event.signatureKind} ·{" "}
                  <span className="font-mono">{event.completionId.slice(0, 8)}</span>
                </Badge>
              </div>
            );
          if (event.type === "say")
            return (
              <p key={i} className="min-w-0 break-words text-sm whitespace-pre-wrap">
                {event.text}
              </p>
            );
          if (event.type === "call")
            return (
              <div key={i} className="min-w-0 break-all font-mono text-sm">
                → {event.name} <span className="text-muted-foreground">{JSON.stringify(event.input)}</span>
              </div>
            );
          // Book reads are long JSON: keep them folded.
          if (event.result.startsWith("{")) return (
            <details key={i} className="min-w-0 rounded-xl bg-muted/60 px-4 text-xs">
              <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">{event.name} result</summary>
              <pre className="mt-2 overflow-x-auto font-mono">{JSON.stringify(JSON.parse(event.result), null, 2)}</pre>
            </details>
          );
          const status = event.result.match(/^(REFUSED|ERROR|NOT PROPOSED|ALREADY|PROPOSED)\b/)?.[0];
          const detail = status ? event.result.slice(status.length).replace(/^[:\s]+/, "") : event.result;
          return (
            <div key={i} className="flex min-w-0 flex-wrap items-start gap-2">
              {status && <Badge tone={resultTone(event.result)}>{status}</Badge>}
              {detail && <p className="min-w-0 break-all text-sm whitespace-pre-wrap">{detail}</p>}
            </div>
          );
        })}
        {proposal.state === "running" && (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Thinking…
          </span>
        )}
        {plan && (
          <div className="flex flex-col gap-2 rounded-xl bg-muted/60 p-4 text-sm">
            <span className="font-medium">
              Plan <span className="font-mono">{plan.id.slice(0, 8)}</span> · valid until {new Date(plan.expiresAt).toLocaleTimeString()}
            </span>
            {plan.actions.map((action, i) => {
              const done = execution.events.find((e) => e.type === "action" && e.index === i);
              return (
                <div key={i} className="flex flex-wrap items-center gap-2 font-mono">
                  {i + 1}.{" "}
                  {action.type === "swap"
                    ? `swap ${amountOf(action.amount, action.from, data.book)} → ${symbol(action.to)} · floor ${amountOf(action.minAmountOut, action.to, data.book)} · ${action.costBps} bps`
                    : `shield ${amountOf(action.amount, action.asset, data.book)}`}
                  {done?.type === "action" && done.shield && (
                    <Badge tone={statusTone(done.shield.status)}>shield {done.shield.status.toLowerCase()}</Badge>
                  )}
                  {done?.type === "action" && <StatusBadge status={done.status} failureCode={done.failureCode} />}
                </div>
              );
            })}
          </div>
        )}
        {execution.events.map((event, i) =>
          event.type === "rejected" ? <NotExecuted key={i} problems={event.problems} again="Propose" /> : null,
        )}
        <ErrorBox error={proposal.error ?? execution.error} />
      </div>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">
          {proposal.state === "done" && !plan && "Nothing proposed: nothing to execute."}
        </span>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={busy || !canPropose} onClick={() => proposal.run({ instruction })}>
            {proposal.state === "running" ? <Spinner /> : null}
            Propose
          </Button>
          <ConfirmButton
            path="executePlan"
            label={execution.state === "running" ? <><Spinner /> Executing</> : "Execute plan"}
            disabled={busy || !plan || executed}
            title="Execute this plan on mainnet?"
            description="Runs the proposed steps exactly as shown, under the agent's grant, each swap held to its previewed floor. Actions run in sequence. Checks run before execution and before later actions; if execution stops, earlier completed actions remain."
            confirm="Execute plan"
            onConfirm={() => plan && execution.run({ planId: plan.id })}
          />
        </div>
      </div>
    </Card>
  );
}
