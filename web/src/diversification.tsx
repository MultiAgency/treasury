import { useQuery } from "@tanstack/react-query";
import { SectionHeader } from "@/components/ui/action-row";
import { DataTable, td, th, TokenChip, tr, ValuePill } from "@/components/ui/data-table";
import { usd } from "./shared/format";
import { Badge, Card, Loading, QueryError } from "./shared/ui";
import { assetColors } from "./book";
import type { DiversificationRead } from "./server-api";
import { Hedge } from "./hedge";
import { CAP_CAVEAT, holdingViews, phaseViews, sourceText, stableViews, venueViews } from "./diversification-view";
import type { agentReads } from "./queries";

type Reads = ReturnType<typeof agentReads>;

/**
 * The diversified book (#221) on the Strategy page: every holding with its class, chain, route and venues, the exposure
 * and cap of each venue, the stablecoin split with each coin's peg level, and each phase's status with the platform's
 * reason when it can't run. Display only: the caps are app-side, and the platform's signed policy still has the last word.
 * One server read (one platform `overview`), read when the page shows it.
 */
export function Diversification({ reads }: { reads: Reads }) {
  const read = useQuery(reads.diversification);
  return <><section id="diversification" aria-labelledby="diversification-title" className="flex flex-col gap-4">
    <SectionHeader id="diversification-title" title="Diversification"
      description="Which assets the book may hold, through which venues, under which caps, and what the platform must list for the next phase."
      info="Each venue is where a holding settles: the agent's NEAR Intents account, and the bridge each asset from another chain arrived through. A holding counts at every venue on its path. The caps come from the agent's configured mandate terms when it has them; otherwise they are marked as the profile's defaults or absent."
      infoLabel="About diversification" />
    {read.isPending ? <Card><Loading label="Reading the diversified book…" /></Card>
      : read.isError ? <Card><QueryError error={read.error} retry={() => read.refetch()} /></Card>
      : <Contents read={read.data} />}
  </section>
  <Hedge reads={reads} /></>;
}

function Contents({ read }: { read: DiversificationRead }) {
  const holdings = holdingViews(read), venues = venueViews(read), stables = stableViews(read), phases = phaseViews(read);
  const venueLabel = new Map(read.venues.map(v => [v.id, v.label]));
  const colors = assetColors(holdings.map(h => h.symbol));
  const stableColors = assetColors(stables.map(s => s.symbol));
  return <>
    <p className="text-sm text-muted-foreground">{sourceText(read.source)} {CAP_CAVEAT}</p>
    {read.notes.length > 0 && <Card className="gap-2"><h3 className="text-sm font-medium">What this read can't say</h3>
      <ul aria-label="Limits of this diversification read" className="flex flex-col gap-1 text-sm text-muted-foreground">
        {read.notes.map(note => <li key={note} className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />{note}</li>)}
      </ul></Card>}

    <Card className="gap-4">
      <SectionHeader level={3} title="Holdings and venues" description="Each asset, its chain, how it reaches NEAR Intents, and every venue its holding depends on." />
      <DataTable caption="Diversified holdings" minWidth="48rem">
        <thead><tr>
          <th scope="col" className={th()}>Asset</th>
          <th scope="col" className={th()}>Class</th>
          <th scope="col" className={th()}>Chain · route</th>
          <th scope="col" className={th()}>Venues</th>
          <th scope="col" className={th("right")}>Value</th>
          <th scope="col" className={th("right")}>Platform</th>
        </tr></thead>
        <tbody>
          {holdings.map((h, i) => <tr key={h.asset} className={tr()}>
            <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={h.symbol} color={colors[i]!} /></th>
            <td className={td()}>{h.classText}</td>
            <td className={td("left", "text-muted-foreground")}>{h.chain ?? "—"}{h.route ? ` · ${h.route}` : ""}</td>
            <td className={td("left", "text-muted-foreground")}>{h.venues.length ? h.venues.map(v => venueLabel.get(v) ?? v).join(", ") : "—"}</td>
            <td className={td("right")}>{usd(h.usd)}</td>
            <td className={td("right")}><Badge tone={h.proposable ? "success" : "neutral"}>{h.platformText}</Badge></td>
          </tr>)}
          {holdings.length === 0 && <tr><td className={td()} colSpan={6}>The book holds nothing.</td></tr>}
        </tbody>
      </DataTable>
    </Card>

    <Card className="gap-4">
      <SectionHeader level={3} title="Venue exposure and caps" description="A holding counts at every venue on its path. A buy must leave each of them inside its cap."
        info="Exposure is the USD counted at the venue now, as the app reads the book. The caps are app-side: the engine refuses to propose past them, but the platform checks only the signed policy." infoLabel="About venue caps" />
      <DataTable caption="Venue exposure and caps" minWidth="34rem">
        <thead><tr>
          <th scope="col" className={th()}>Venue</th>
          <th scope="col" className={th()}>Kind</th>
          <th scope="col" className={th("right")}>Exposure</th>
          <th scope="col" className={th("right")}>Cap</th>
          <th scope="col" className={th()}>Cap from</th>
        </tr></thead>
        <tbody>{venues.map(v => <tr key={v.id} className={tr()}>
          <th scope="row" className={td("left", "font-normal")}>{v.label}</th>
          <td className={td("left", "text-muted-foreground")}>{v.kind === "account" ? "Account" : "Bridge"}</td>
          <td className={td("right")}>{v.exposureText}</td>
          <td className={td("right")}>{v.capPct === null ? <ValuePill>No cap</ValuePill> : v.capText}</td>
          <td className={td("left", "text-xs text-muted-foreground")}>{v.capNote}</td>
        </tr>)}</tbody>
      </DataTable>
    </Card>

    <Card className="gap-4">
      <SectionHeader level={3} title="Stablecoins and the reserve split" description="The reserve and operating cash, each coin's share now and its target, and whether it is on its peg."
        info="A coin off its peg is an L2 fault from 1% and an L3 fault from 3%. With more than one listed stablecoin, a depeg moves the holding into the coins on peg; today the platform lists only USDC, so no split can be traded." infoLabel="About the stablecoin split" />
      {stables.length === 0 ? <p role="status" className="text-sm text-muted-foreground">No stablecoin is held.</p>
        : <DataTable caption="Stablecoins and the reserve split" minWidth="36rem">
          <thead><tr>
            <th scope="col" className={th()}>Coin</th>
            <th scope="col" className={th("right")}>Value</th>
            <th scope="col" className={th("right")}>Share now</th>
            <th scope="col" className={th("right")}>Target</th>
            <th scope="col" className={th("right")}>Peg</th>
          </tr></thead>
          <tbody>{stables.map((s, i) => <tr key={s.symbol} className={tr()}>
            <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={s.symbol} color={stableColors[i]!} /></th>
            <td className={td("right")}>{usd(s.usd)}</td>
            <td className={td("right")}>{s.shareText}</td>
            <td className={td("right")}>{s.targetPct === null ? <ValuePill>No target</ValuePill> : s.targetText}</td>
            <td className={td("right")}><Badge tone={s.pegTone}>{s.pegText}</Badge></td>
          </tr>)}</tbody>
        </DataTable>}
    </Card>

    <Card className="gap-3">
      <SectionHeader level={3} title="Phases" description="What can run today, and what the platform must list first."
        info="Phase 1 needs two cross-chain majors through NEAR Intents; phase 2 needs a second listed stablecoin; phase 3 needs a listed tokenized T-bill and the owner's eligibility and KYC. Nothing is assumed beyond the registry and the platform's proposal assets." infoLabel="About the phases" />
      <ul aria-label="Diversification phases" className="flex flex-col gap-3">
        {phases.map(phase => <li key={phase.phase} className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/40 p-3">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={phase.on ? "success" : "warning"}>{phase.badge}</Badge>
            <span className="text-sm font-medium">{phase.phase}. {phase.title}</span>
          </span>
          {phase.reasons.length === 0
            ? <p className="text-sm text-muted-foreground">Running.</p>
            : <ul aria-label={`Why phase ${phase.phase} can't run`} className="flex flex-col gap-1 text-sm text-muted-foreground">
              {phase.reasons.map(reason => <li key={reason} className="flex gap-2"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />{reason}</li>)}
            </ul>}
        </li>)}
      </ul>
    </Card>
  </>;
}
