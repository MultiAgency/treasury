import { confidentialStanding, incomingCreditBasis } from "./reconciliation-view";
import { ArrowLeft, Books, ClockCounterClockwise, DownloadSimple, Path, Signature, WarningCircle } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { DataTable, FilterChips, td, th, tr, TokenChip, ValuePill, type FilterOption } from "@/components/ui/data-table";
import { PanelTitle } from "@/components/ui/stat";
import { ago, describeRequest, usd } from "./shared/format";
import { Badge, Button, Card, Loading, Note, QueryError, short, statusTone, type Tone } from "./shared/ui";
import { actionBadge, actionName, actionStanding, history, pageCount, pageOf, runSummary, unresolvedAnchor, type RunStage } from "./activity-view";
import { actionPhase } from "../../apps/server/src/owner-action.ts";
import { assetColors } from "./book";
import { PageLink } from "./nav";
import { agentAddress, runAddress } from "./pages";
import { recentRuns } from "./portfolio-view";
import { activityCsvPath, type ActivityRead, type Identity } from "./server-api";
import { failureOf, type agentReads } from "./queries";
import { amountText, when } from "./ui";

type Reads = ReturnType<typeof agentReads>;
type Row = ActivityRead[number];

/** A time relative to now, with the exact time on hover. */
const At = ({ iso, className }: { iso: string; className?: string }) => <time dateTime={iso} title={when(iso)} className={className}>{ago(iso)}</time>;

/** What a history row's outcome is, for its badge and the filter: refused, recorded (by its status), or not recorded yet. */
type Kind = "success" | "failed" | "refused" | "open";
const kindOf = (row: Pick<Row, "refused" | "status">): Kind =>
  row.refused ? "refused" : !row.status ? "open" : row.status === "SUCCESS" ? "success" : statusTone(row.status) === "destructive" ? "failed" : "open";
const FILTERS: { key: Kind; label: string; dot: string }[] = [
  { key: "success", label: "Succeeded", dot: "bg-success" },
  { key: "failed", label: "Failed", dot: "bg-[var(--status-danger)]" },
  { key: "refused", label: "Refused", dot: "bg-[var(--status-danger)]" },
  { key: "open", label: "In flight", dot: "bg-warning" },
];

/**
 * One history row, dense: when (relative, exact on hover), what it was and its outcome on one line, and its operation's
 * status a click away (`/operations/:id`, by its `correlationId`).
 */
function HistoryRow({ reads, row, book }: { reads: Reads; row: Row; book: Parameters<typeof describeRequest>[1] }) {
  const [asked, setAsked] = useState(false);
  const status = useQuery({ ...reads.operation(row.correlationId ?? "none"), enabled: asked && row.correlationId !== undefined });
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
    <At iso={row.at} className="col-span-2 text-xs text-muted-foreground tabular-nums sm:col-span-1" />
    <span className="min-w-0 leading-6 break-words">
      <span className="font-medium">{row.kind}</span><span className="text-muted-foreground"> · </span>{describeRequest(row.request, book)}<span className="text-muted-foreground"> · </span>
      {row.refused ? <Badge tone="destructive">refused: {row.refused}</Badge> : row.status ? <Badge tone={statusTone(row.status)}>{row.status}</Badge> : <Badge tone="warning">outcome not recorded yet</Badge>}
    </span>
    {row.correlationId ? <Button variant="ghost" size="xs" disabled={status.isFetching} onClick={() => asked ? void status.refetch() : setAsked(true)}>
      {status.isFetching ? "Checking…" : "Check status"}<span className="sr-only"> of the operation at {when(row.at)}</span>
    </Button> : <span />}
    {row.correlationId && (status.data || status.isError) && <span className="col-span-2 text-xs text-muted-foreground sm:col-start-2">
      {status.data && <span role="status">Status: {status.data.status ?? "outcome not recorded yet"}{status.data.refused ? ` · refused: ${status.data.refused}` : ""}</span>}
      {status.isError && <span role="alert">The status couldn't be read.</span>}
    </span>}
  </li>;
}

/**
 * The agent's activity (#136): operations without a proven outcome, the full history (every row the platform keeps,
 * refusals included, newest first, 50 to a page in the browser: `activity` answers them all at once) with a filter by
 * outcome (#195), the ledger as a CSV, the owner's actions and where each stands, the autopilot's recorded runs, and the
 * books. Read-only: nothing here acts.
 */
export function Activity({ reads, identity }: { reads: Reads; identity: Identity }) {
  const client = useQueryClient();
  const activity = useQuery(reads.activity);
  const unresolved = useQuery(reads.unresolved);
  const actions = useQuery(reads.ownerActions);
  const runs = useQuery(reads.runs);
  const books = useQuery(reads.books);
  const overview = useQuery(reads.overview);
  const book = overview.data?.book ?? [];
  const all = useMemo(() => history(activity.data ?? []), [activity.data]);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const rows = useMemo(() => filter === "all" ? all : all.filter(row => kindOf(row) === filter), [all, filter]);
  const [page, setPage] = useState(1);
  const pages = pageCount(rows.length);
  const shown = pageOf(rows, page);
  const fetching = [activity, unresolved, actions, runs, books].some(read => read.isFetching);
  const refresh = () => [reads.activity, reads.unresolved, reads.ownerActions, reads.runs, reads.books].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));
  const counts = useMemo(() => all.reduce<Record<Kind, number>>((count, row) => ({ ...count, [kindOf(row)]: count[kindOf(row)] + 1 }), { success: 0, failed: 0, refused: 0, open: 0 }), [all]);
  const options: FilterOption<Kind | "all">[] = [{ key: "all", label: "All", count: all.length }, ...FILTERS.filter(option => counts[option.key] > 0).map(option => ({ ...option, count: counts[option.key] }))];
  const colors = assetColors(books.data?.map(row => row.symbol) ?? []);

  return <div className="flex flex-col gap-3">
    {unresolved.data && unresolved.data.length > 0 && <section id="unresolved" aria-labelledby="unresolved-title">
      <Card className="gap-3 border-warning/30">
        <PanelTitle id="unresolved-title" title="Pending" icon={<WarningCircle weight="duotone" />} tone="warning"
          description="No action needed. The platform is checking these; nothing new runs until they settle, and nothing is sent again from here."
          infoLabel="About pending operations" info="These were sent but their result isn't confirmed yet. The platform reconciles them on its own.">
          <Badge tone="warning">{unresolved.data.length} open</Badge>
        </PanelTitle>
        <ul aria-label="Pending" className="flex flex-col divide-y divide-border text-sm">
          {unresolved.data.map(item => <li key={item.key} id={unresolvedAnchor(item.key)} className="grid scroll-mt-24 grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <At iso={item.at} className="text-xs text-muted-foreground" />
            <span className="min-w-0 break-words"><span className="font-medium">{item.kind}</span><span className="text-muted-foreground"> · </span>{describeRequest(item.request, book)}
              {item.status && <> <Badge tone={statusTone(item.status)}>{item.status}</Badge></>}</span>
          </li>)}
        </ul>
      </Card>
    </section>}

    <section id="history" aria-labelledby="history-title">
      <Card className="gap-3">
        <PanelTitle id="history-title" title="History" icon={<ClockCounterClockwise weight="duotone" />} tone="brand" description="Every recorded operation, newest first">
          <Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button>
          <a className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-accent md:min-h-8" href={activityCsvPath(reads.name)} download>
            <DownloadSimple aria-hidden="true" className="size-4" />Download CSV</a>
        </PanelTitle>
        {activity.isPending ? <Loading label="Reading activity…" />
          : activity.isError ? <QueryError error={activity.error} retry={() => activity.refetch()} />
          : all.length === 0 ? <Note>No activity yet. <PageLink to={agentAddress(identity.agent, "proposals")} className="underline">Propose a rebalance</PageLink> to get the agent started.</Note>
          : <>
            <FilterChips label="Filter the history by outcome" options={options} value={filter} onChange={key => { setFilter(key); setPage(1); }} />
            <ul aria-label="History" className="-my-1 flex flex-col divide-y divide-border text-sm">
              {shown.map((row, i) => <HistoryRow key={row.correlationId ?? `${row.at}-${i}`} reads={reads} row={row} book={book} />)}
            </ul>
            <nav aria-label="History pages" className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
              <span role="status">Page {Math.min(page, pages)} of {pages} · {rows.length} {rows.length === 1 ? "row" : "rows"}</span>
              <span className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</Button>
              </span>
            </nav>
          </>}
      </Card>
    </section>

    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <section id="owner-actions" aria-labelledby="owner-actions-title" className="min-w-0">
        <Card className="h-full gap-3">
          <PanelTitle id="owner-actions-title" title="Owner actions" icon={<Signature weight="duotone" />} tone="info" infoLabel="About owner actions"
            info="What was asked of the owner for this agent, and where each stands, as the platform records it: the same on every device." />
          {actions.isPending ? <Loading label="Reading the owner's actions…" />
            : actions.isError ? <QueryError error={actions.error} retry={() => actions.refetch()} />
            : actions.data.length === 0 ? <p className="text-sm text-muted-foreground" role="status">No owner actions yet.</p>
            : <ul aria-label="Owner actions" className="flex flex-col divide-y divide-border text-sm">
              {actions.data.map(action => {
                const badge = actionBadge(action);
                const open = actionPhase(action) === "open";
                const standing = actionStanding(action);
                return <li key={action.correlationId} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                  <span className="flex items-center justify-between gap-3"><span className="font-medium">{actionName(action.type)}</span><Badge tone={badge.tone}>{badge.label}</Badge></span>
                  {(standing !== badge.label || open) && <span className="text-xs text-muted-foreground">
                    {standing !== badge.label && standing}{open && <> · expires <At iso={action.expiresAt} /></>}
                  </span>}
                </li>;
              })}
            </ul>}
        </Card>
      </section>

      <section id="runs" aria-labelledby="runs-title" className="min-w-0">
        <Card className="h-full gap-3">
          <PanelTitle id="runs-title" title="Autopilot runs" icon={<Path weight="duotone" />} tone="eth">
            {runs.data && <Badge tone="neutral">{runs.data.ticks.length} recorded</Badge>}
          </PanelTitle>
          {runs.isPending ? <Loading label="Reading the autopilot's runs…" />
            : runs.isError ? <QueryError error={runs.error} retry={() => runs.refetch()} />
            : runs.data.ticks.length === 0 ? <p className="text-sm text-muted-foreground" role="status">The autopilot hasn't run.</p>
            : <DataTable caption="Autopilot runs" minWidth="26rem">
              <thead><tr>
                <th scope="col" className={th()}>Started</th>
                <th scope="col" className={th()}>By</th>
                <th scope="col" className={th()}>Outcome</th>
                <th scope="col" className={th("right")}>Plan</th>
                <th scope="col" className={th("right")}><span className="sr-only">Run</span></th>
              </tr></thead>
              <tbody>{recentRuns(runs.data, Number.POSITIVE_INFINITY).map(run => <tr key={run.id} className={tr()}>
                <td className={td("left", "text-xs whitespace-nowrap text-muted-foreground")}><At iso={run.at} /></td>
                <td className={td()}><Badge tone="neutral">{run.trigger === "schedule" ? "Schedule" : "Operator"}</Badge></td>
                <td className={td("left", "max-w-48")}>{run.outcome === "running" ? <Badge tone="info">Running</Badge> : <span className="line-clamp-2 text-xs" title={run.outcome}>{run.outcome}</span>}</td>
                <td className={td("right")}>{run.planUsd !== null ? usd(run.planUsd) : <span className="text-muted-foreground">—</span>}</td>
                <td className={td("right", "font-sans")}><PageLink to={runAddress(identity.agent, run.id)} className="text-xs underline underline-offset-2">Open<span className="sr-only"> the run of {when(run.at)}</span></PageLink></td>
              </tr>)}</tbody>
            </DataTable>}
          {runs.data && runs.data.corrupt.length > 0 && <p className="text-sm" role="alert">{runs.data.corrupt.length} recorded line(s) couldn't be read.</p>}
        </Card>
      </section>
    </div>

    <section id="books" aria-labelledby="books-title">
      <Card className="gap-3">
        <PanelTitle id="books-title" title="Books" icon={<Books weight="duotone" />} tone="usdc" infoLabel="About the books"
          info="Public balances are checked against chain transfers. Private balances include recorded executions and receipt-backed credits. Missing incoming history holds proposals; it does not establish missing funds." />
        {books.isPending ? <Loading label="Reading the books…" />
          : books.isError ? <QueryError error={books.error} retry={() => books.refetch()} />
          : books.data.length === 0 ? <p className="text-sm text-muted-foreground" role="status">No balances to reconcile.</p>
          : <DataTable caption="Books" minWidth="24rem">
            <thead><tr>
              <th scope="col" className={th()}>Asset</th>
              <th scope="col" className={th("right")}>Private records</th>
              <th scope="col" className={th("right")}>Public drift</th>
            </tr></thead>
            <tbody>{books.data.map((row, i) => <tr key={row.asset} className={tr()}>
              <th scope="row" className={td("left", "font-normal")}><TokenChip symbol={row.symbol} color={colors[i]!} /></th>
              <td className={td("right")}>{row.confidential.unattributed === "0" ? <span className="text-muted-foreground">Recorded balance matches</span> : <ValuePill tone="warning">{amountText(row.confidential.unattributed, row.asset)}</ValuePill>}<span className="block text-xs whitespace-normal text-muted-foreground">{row.confidential.unattributed !== "0" && confidentialStanding(row.confidential.unattributed)}</span>{incomingCreditBasis(row.confidential) && <span className="block text-xs whitespace-normal text-muted-foreground">{incomingCreditBasis(row.confidential)}</span>}</td>
              <td className={td("right")}>{row.public.drift === "0" ? <span className="text-muted-foreground">none</span> : <ValuePill tone="warning">{amountText(row.public.drift, row.asset)}</ValuePill>}</td>
            </tr>)}</tbody>
          </DataTable>}
      </Card>
    </section>
  </div>;
}

const STAGE_NAMES: Record<string, string> = { before: "Balances before", after: "Balances after", plan: "Plan", send: "Send", shield: "Shield" };
/** A stage's dot: red when what it found is a failure or an unreadable balance, else by what it is. */
function stageDot(stage: RunStage) {
  if (/couldn't|fail|error|refus/i.test(stage.detail)) return "bg-[var(--status-danger)]";
  return stage.stage === "plan" ? "bg-brand" : stage.stage === "send" ? "bg-info" : stage.stage === "shield" ? "bg-asset-eth" : "bg-muted-foreground";
}

/** One recorded run of the autopilot (#136): how it started, then a timeline of what each stage found or did, and how it ended. */
export function Run({ reads, id, identity }: { reads: Reads; id: string; identity: Identity }) {
  const recording = useQuery(reads.recording(id));
  const missing = (() => { const failure = failureOf(recording.error); return failure?.kind === "refused" && failure.code === "not_found"; })();
  const summary = recording.data ? runSummary(recording.data) : undefined;
  const ended: { label: string; tone: Tone } | undefined = summary && (summary.failed ? { label: "Failed", tone: "destructive" } : summary.outcome !== null ? (summary.refusal ? { label: "Refused", tone: "warning" } : { label: "Ended", tone: "success" })
    : { label: "No end recorded", tone: "warning" });
  return <section aria-labelledby="run-title" className="flex flex-col gap-3">
    <PageLink to={agentAddress(identity.agent, "activity")} className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
      <ArrowLeft aria-hidden="true" className="size-3.5" />Back to activity</PageLink>
    <Card className="gap-4">
      <PanelTitle id="run-title" title={<>Run <span className="font-mono">{short(id, 12)}</span></>} icon={<Path weight="duotone" />} tone="eth">
        {ended && <Badge tone={ended.tone}>{ended.label}</Badge>}
      </PanelTitle>
      {recording.isPending ? <Loading label="Reading the run's recording…" />
        : missing ? <p role="alert">No run has this ID.</p>
        : recording.isError ? <QueryError error={recording.error} retry={() => recording.refetch()} />
        : summary && <>
          <dl className="grid gap-2 text-sm sm:grid-cols-[1fr_1fr_2fr]">
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 p-3">
              <dt className="text-xs text-muted-foreground">Started</dt><dd><At iso={summary.startedAt} /></dd>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 p-3">
              <dt className="text-xs text-muted-foreground">Started by</dt><dd>{summary.trigger === "schedule" ? "the schedule" : `the operator${summary.actor ? ` (${summary.actor})` : ""}`}</dd>
            </div>
            <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 p-3">
              <dt className="text-xs text-muted-foreground">How it ended</dt>
              <dd><span role="status">{summary.failed ? `Failed: ${summary.failed}` : summary.outcome !== null ? `${summary.outcome}${summary.refusal ? ` (refused: ${summary.refusal})` : ""}`
                : summary.completion === "no-recorded-end" ? "No end was recorded: only the progress it recorded is shown." : "No outcome recorded."}</span></dd>
            </div>
          </dl>
          {summary.stages.length === 0 ? <p className="text-muted-foreground">No stages were recorded.</p>
            : <ol aria-label="Stages" className="flex flex-col">{summary.stages.map((stage, i) => <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
              {/* The timeline's rail, from this stage's dot down to the next one's. */}
              {i < summary.stages.length - 1 && <span aria-hidden="true" className="absolute top-4 bottom-0 left-[5px] w-px bg-border-strong" />}
              <span aria-hidden="true" className={`relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-card ${stageDot(stage)}`} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{STAGE_NAMES[stage.stage] ?? stage.stage}</span>
                <span className="text-xs break-words text-muted-foreground">{stage.detail}</span>
              </div>
            </li>)}</ol>}
        </>}
    </Card>
  </section>;
}
