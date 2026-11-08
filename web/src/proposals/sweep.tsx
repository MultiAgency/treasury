import { mayCall } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { assetColor, fromUnits } from "../shared/format";
import { Badge, Button, ErrorBox, Loading, QueryError, Spinner, type Tone } from "../shared/ui";
import { blockShield, useShieldBlock } from "./kept-outcomes";
import type { Identity } from "./proposals-api";
import { refreshPortfolio, type agentReads } from "./queries";
import { sweepOutcome } from "./sweep-run";
import { ReviewDialog } from "./ui";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;
type Read = ReturnType<typeof sweepOutcome>;

/** What a failed sweep means for the owner, by kind: never the platform's text. */
const FAILED: Record<string, string> = {
  partial: "At least one shield went out, and not every one succeeded. Funds may have moved: check Activity, in Portfolio on the agent's Home page, before shielding again.",
  unknown: "The sweep's outcome isn't known: a shield may have gone out. Check Activity, in Portfolio on the agent's Home page, before shielding again.",
  refused: "Nothing was shielded: the platform refused the sweep.",
  provider: "Nothing was shielded: the provider refused it.",
  busy: "Nothing was shielded: the agent is busy with another operation. Try again shortly.",
  unresolved: "Nothing was shielded: an earlier operation's outcome isn't proven yet.",
  unavailable: "The sweep didn't answer. Reading again is safe.",
};

type StepState = "done" | "active" | "next" | "waiting" | "blocked";
const STEP: Record<StepState, { label: string; tone: Tone; ring: string }> = {
  done: { label: "Done", tone: "success", ring: "border-border" },
  active: { label: "Working", tone: "info", ring: "border-info/40" },
  next: { label: "Next", tone: "brand", ring: "border-brand/40" },
  waiting: { label: "Waiting", tone: "neutral", ring: "border-border" },
  blocked: { label: "Check", tone: "destructive", ring: "border-destructive/40" },
};

/** One step of the sweep: its number (a check once done), title, what it does, its state, its action, and what it found. */
function Step({ n, title, detail, state, action, children }: { n: number; title: string; detail: string; state: StepState; action: ReactNode; children?: ReactNode }) {
  const look = STEP[state];
  return <li className={`flex min-w-0 flex-col gap-3 rounded-lg border bg-background/40 p-3 ${look.ring}`}>
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${state === "done" ? "bg-success text-black" : state === "blocked" ? "bg-[var(--status-danger)] text-black" : "bg-secondary text-foreground ring-1 ring-border-strong"}`}>
        {state === "done" ? <CheckCircle weight="bold" className="size-4" /> : state === "blocked" ? <WarningCircle weight="bold" className="size-4" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <Badge tone={look.tone}>{look.label}</Badge>
    </div>
    {children}
    <div className="flex flex-wrap gap-2">{action}</div>
  </li>;
}

/**
 * Previews, then shields, the agent's managed public balances into its confidential balance. Each sweep is sent once and
 * decided from what its run reported; after one whose outcome is unknown or partly sent, Shield isn't offered again
 * while the page is loaded, whichever of the agent's pages it is left for. Shielding needs the executor to hold a treasury grant.
 */
export function Sweep({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const account = useQuery(reads.account);
  const [read, setRead] = useState<Read & { execute: boolean }>();
  const [busy, setBusy] = useState<"preview" | "shield">();
  const [error, setError] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  // Outside the component: leaving Funding for Home and back must not offer Shield again (`kept-outcomes.ts`).
  const unsettled = useShieldBlock(reads.name);
  const grant = account.data?.grant?.label;
  const canShield = account.data?.executor === true && (grant === "treasury" || Boolean(grant?.startsWith("treasury:")));
  const canSweep = mayCall(identity.access, "sweep") && canShield;
  const exposed = read?.activity.exposed ?? [];

  const run = async (execute: boolean) => {
    setReviewing(false);
    setBusy(execute ? "shield" : "preview");
    setError(undefined);
    const answer = await reads.agent.sweep(execute);
    setBusy(undefined);
    // A shield may have moved funds whatever its answer, so the portfolio (Activity included) is read anew.
    if (execute) refreshPortfolio(client, reads);
    if (!answer.ok) {
      // A shield's lost answer may have sent one: never offered again from here.
      if (execute && answer.kind === "lost") blockShield(reads.name);
      setError(failureText(answer, execute ? "funding" : "read"));
      return;
    }
    const decided = sweepOutcome(answer.value, execute);
    setRead({ ...decided, execute });
    if (!decided.offerAgain) blockShield(reads.name);
    if (!decided.outcome.ok) setError(FAILED[decided.outcome.kind] ?? `The sweep failed (${decided.outcome.kind}).`);
  };

  if (account.isPending) return <Loading label="Reading the agent's account…" />;
  if (account.isError) return <QueryError error={account.error} retry={() => account.refetch()} />;
  const shielded = Boolean(read?.execute && read.outcome.ok);
  const previewState: StepState = read ? "done" : busy === "preview" ? "active" : "next";
  const shieldState: StepState = shielded ? "done" : read?.execute && !read.outcome.ok ? "blocked" : read && !read.execute && exposed.length > 0 ? "next" : "waiting";
  return <div className="flex flex-col gap-3 text-sm">
    {!canShield && <p role="status" className="rounded-lg border border-warning/30 bg-warning-muted px-3 py-2 text-warning-muted-foreground">Shielding needs the agent to hold a treasury grant. Payout and invoice grants can't shield funds.</p>}
    <ol aria-label="Shield in two steps" className="grid gap-3 md:grid-cols-2">
      <Step n={1} title="Preview" detail="Read what is in public view now" state={previewState}
        action={<Button variant="outline" size="sm" disabled={busy !== undefined || !canSweep} onClick={() => void run(false)}>{busy === "preview" && <Spinner />} Preview</Button>}>
        {read && (exposed.length === 0
          ? <p role="status" className="text-muted-foreground">No public USDC, wNEAR or ETH balances found.</p>
          : <ul aria-label="Public balances" className="flex flex-col divide-y divide-border">
            {exposed.map(holding => {
              const shield = read.activity.shields.find(item => item.asset === holding.asset);
              return <li key={holding.asset} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${assetColor(holding.symbol)}`} />
                <span className="font-mono">{fromUnits(holding.public, holding.decimals)} {holding.symbol} public{shield && ` · shield ${shield.status.toLowerCase()}`}</span>
              </li>;
            })}
          </ul>)}
      </Step>
      <Step n={2} title="Shield" detail="Move them into the private balance, after a review" state={shieldState}
        action={<Button size="sm" disabled={busy !== undefined || !canSweep || unsettled || !read || read.execute || exposed.length === 0} onClick={() => setReviewing(true)}>
          {busy === "shield" && <Spinner />} Shield</Button>}>
        {shielded && <p role="status" className="text-success-muted-foreground">Shielded. The portfolio shows it in the private balance.</p>}
        {unsettled && <p role="status" className="text-warning-muted-foreground">Shield isn't offered again from this page until its outcome is known.</p>}
      </Step>
    </ol>
    <ErrorBox error={error} />
    <ReviewDialog open={reviewing} busy={busy !== undefined} onClose={() => setReviewing(false)} title="Shield these public balances?"
      description="Moves them into the agent's private balance: they stay in the account, out of public view. The agent reads its balances again when it runs, and shields each public USDC, wNEAR and ETH balance it then finds, so anything that arrived since this preview is shielded too."
      actions={<Button disabled={busy !== undefined} onClick={() => void run(true)}>Shield now</Button>}>
      <ul aria-label="Public balances to shield" className="text-sm font-mono">
        {exposed.map(holding => <li key={holding.asset}>{fromUnits(holding.public, holding.decimals)} {holding.symbol}</li>)}
      </ul>
    </ReviewDialog>
  </div>;
}
