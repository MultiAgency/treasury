import { Coins } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SectionHeader } from "@/components/ui/action-row";
import { DataTable, td, th, TokenChip, tr, ValuePill } from "@/components/ui/data-table";
import { Badge, Button, Card, ErrorBox, Loading, QueryError, Spinner } from "../shared/ui";
import { assetColors } from "./book";
import { BLOCKED_CAVEAT, intentsLine, moveRows, planNote, PROPOSE_CAVEAT, registryRows, type MoveRow } from "./hedge-view";
import { PageLink } from "./nav";
import { proposalAddress } from "./pages";
import type { agentReads } from "./queries";
import { failureText } from "./words";

type Reads = ReturnType<typeof agentReads>;

/** A request ID of this page's own: the platform keeps one proposal per ID, so a lost answer is found by it, never asked again. */
const freshRequestId = () => `page-${Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("")}`;

/**
 * The hedge (#221) on the Strategy page: NEAR Intents' live token list against the registry (each asset's price, whether
 * the platform can trade it, any drift), and the plan into gold and other chains' assets, every move executable now or
 * blocked with each reason. Reading proposes nothing: an executable move is proposed by its own button, which asks the
 * server to plan it again and puts it on the Proposals page for the owner's signature.
 */
export function Hedge({ reads }: { reads: Reads }) {
  const read = useQuery(reads.hedge);
  return <section id="hedge" aria-labelledby="hedge-title" className="flex flex-col gap-4">
    <SectionHeader id="hedge-title" title="Hedge into gold and other chains"
      description="Live prices from NEAR Intents, and the moves that would put part of the treasury into gold or another chain's assets."
      info="NEAR Intents already settles assets from other chains. This plan prices each move with a fresh dry-run quote and checks it against the platform's list, the caps and forward risk. What the platform lists decides what can be proposed: the rest is shown, blocked, until it does."
      infoLabel="About the hedge" />
    {read.isPending ? <Card><Loading label="Reading NEAR Intents and planning…" /></Card>
      : read.isError ? <Card><QueryError error={read.error} retry={() => read.refetch()} /></Card>
      : <Contents reads={reads} />}
  </section>;
}

function Contents({ reads }: { reads: Reads }) {
  const read = useQuery(reads.hedge);
  if (!read.data) return null;
  const data = read.data, line = intentsLine(data), registry = registryRows(data), moves = moveRows(data);
  const colors = assetColors(registry.map(r => r.symbol));
  const note = planNote(data);
  return <>
    <Card className="gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={line.tone}>{line.badge}</Badge>
        <p className="text-sm text-muted-foreground">{line.text}</p>
        <Button variant="outline" size="sm" disabled={read.isFetching} onClick={() => void read.refetch()}>{read.isFetching && <Spinner />} Check NEAR Intents again</Button>
      </div>
      {data.level !== null && <p className="text-sm text-muted-foreground">Forward risk is at L{data.level} on the stabilization agent's latest assessment.</p>}
    </Card>

    <Card className="gap-4">
      <SectionHeader level={3} title="Hedge plan" description={PROPOSE_CAVEAT} />
      {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
      {data.plan && data.plan.notes.length > 0 && <ul aria-label="Notes on the hedge plan" className="flex flex-col gap-1 text-sm text-muted-foreground">
        {data.plan.notes.map(n => <li key={n} className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />{n}</li>)}
      </ul>}
      {moves.length > 0 && <>
        <ul aria-label="Hedge moves" className="flex flex-col gap-3">
          {moves.map(move => <Move key={move.id} move={move} reads={reads} />)}
        </ul>
        <p className="text-xs text-muted-foreground">{BLOCKED_CAVEAT}</p>
      </>}
    </Card>

    <Card className="gap-4">
      <SectionHeader level={3} title="Assets on NEAR Intents" description="The registry against NEAR Intents' token list: live price, what is held, and whether the platform can trade it."
        info="Drift means the registry and the list disagree about an asset's id, decimals or chain, or its price is missing, old or off its peg. The symbol isn't compared: the list calls a bridged USDC just USDC." infoLabel="About drift" />
      <DataTable caption="Assets on NEAR Intents" minWidth="52rem">
        <thead><tr>
          <th scope="col" className={th()}>Asset</th>
          <th scope="col" className={th()}>Class</th>
          <th scope="col" className={th()}>Chain · route</th>
          <th scope="col" className={th("right")}>Live price</th>
          <th scope="col" className={th("right")}>Held</th>
          <th scope="col" className={th()}>NEAR Intents list</th>
          <th scope="col" className={th()}>Platform</th>
        </tr></thead>
        <tbody>
          {registry.map((r, i) => <tr key={r.symbol} className={tr()}>
            <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={r.symbol} color={colors[i]!} />
              {r.driftText.length > 0 && <ul aria-label={`Drift for ${r.symbol}`} className="mt-1 text-xs text-warning">{r.driftText.map(d => <li key={d}>{d}</li>)}</ul>}</th>
            <td className={td("left", "text-muted-foreground")}>{r.classText}</td>
            <td className={td("left", "text-muted-foreground")}>{r.chain} · {r.routeText}</td>
            <td className={td("right")}>{r.priceText}</td>
            <td className={td("right")}>{r.heldText}</td>
            <td className={td("left")}>{r.listed === null ? <ValuePill>{r.listText}</ValuePill> : <Badge tone={r.listed ? "success" : "neutral"}>{r.listText}</Badge>}</td>
            <td className={td("left")}><Badge tone={r.proposable ? "success" : "neutral"}>{r.platformText}</Badge></td>
          </tr>)}
        </tbody>
      </DataTable>
    </Card>
  </>;
}

function Move({ move, reads }: { move: MoveRow; reads: Reads }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<string>();
  const propose = async () => {
    setBusy(true); setError(undefined);
    const requestId = freshRequestId();
    let answer = await reads.agent.proposeHedge(requestId, move.id);
    if (!answer.ok && (answer.kind === "lost" || answer.kind === "unavailable")) {
      const found = await reads.agent.request(requestId);
      if (found.ok) answer = found;
      else if (found.kind === "refused" && found.code === "no_proposal") { setBusy(false); setError("The answer was lost, and no proposal was stored for it. Asking again is safe."); return; }
    }
    setBusy(false);
    void client.invalidateQueries({ queryKey: reads.proposals.queryKey });
    if (!answer.ok) { setError(failureText(answer, "proposal")); void client.invalidateQueries({ queryKey: reads.hedge.queryKey }); return; }
    setMade(answer.value.proposal.id);
  };
  return <li className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone={move.status === "executable" ? "success" : "warning"}>{move.statusText}</Badge>
      <span className="text-sm font-medium">{move.kindText}: {move.title}</span>
      <span className="text-sm tabular-nums">{move.sizeText}</span>
      <span className="text-xs text-muted-foreground">{move.shapeText} · {move.quoteText}</span>
    </span>
    <p className="text-sm text-muted-foreground">{move.reason}</p>
    {move.blockers.length > 0 && <ul aria-label={`Why ${move.title} is blocked`} className="flex flex-col gap-1 text-sm text-muted-foreground">
      {move.blockers.map(b => <li key={`${b.label}${b.reason}`} className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" /><span><span className="font-medium text-foreground">{b.label}.</span> {b.reason}</span></li>)}
    </ul>}
    {move.canPropose && !made && <div><Button variant="outline" disabled={busy} onClick={() => void propose()}>{busy && <Spinner />} <Coins aria-hidden="true" /> Propose this move</Button></div>}
    {made && <p role="status" className="text-sm">Proposed. <PageLink to={proposalAddress(reads.name, made)} className="underline">Review the proposal</PageLink>: nothing is sent until you approve it.</p>}
    <ErrorBox error={error} />
  </li>;
}
