import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ago, describeRequest, usd } from "../shared/format";
import { Button, Card, Loading, Note, QueryError, short } from "../shared/ui";
import { actionName, actionStanding, history, pageCount, pageOf, pageOfRow, rowAnchor, runSummary, unresolvedAnchor } from "./activity-view";
import { PageLink } from "./nav";
import { agentAddress, runAddress } from "./pages";
import { recentRuns } from "./portfolio-view";
import { activityCsvPath, type ActivityRead, type Identity } from "./proposals-api";
import { failureOf, type agentReads } from "./queries";
import { amountText, when } from "./ui";

type Reads = ReturnType<typeof agentReads>;

/** One history row, with its operation's status a click away (`/operations/:id`, by its `correlationId`). */
function Row({ reads, row, book }: { reads: Reads; row: ActivityRead[number]; book: Parameters<typeof describeRequest>[1] }) {
  const [asked, setAsked] = useState(false);
  const status = useQuery({ ...reads.operation(row.correlationId ?? "none"), enabled: asked && row.correlationId !== undefined });
  return <li id={row.correlationId ? rowAnchor(row.correlationId) : undefined} className="flex flex-col gap-1 scroll-mt-24">
    <span>
      <time dateTime={row.at}>{when(row.at)}</time> · {row.kind} · {describeRequest(row.request, book)}
      {row.refused ? ` · refused: ${row.refused}` : row.status ? ` · ${row.status}` : " · outcome not recorded yet"}
    </span>
    {row.correlationId && <span className="flex flex-wrap items-center gap-3 text-muted-foreground">
      <Button variant="ghost" size="sm" disabled={status.isFetching} onClick={() => asked ? void status.refetch() : setAsked(true)}>
        {status.isFetching ? "Checking…" : "Check status"}<span className="sr-only"> of the operation at {when(row.at)}</span>
      </Button>
      {status.data && <span role="status">Status: {status.data.status ?? "outcome not recorded yet"}{status.data.refused ? ` · refused: ${status.data.refused}` : ""}</span>}
      {status.isError && <span role="alert">The status couldn't be read.</span>}
    </span>}
  </li>;
}

/**
 * The agent's activity (#136): operations without a proven outcome, the full history (every row the platform keeps,
 * refusals included, newest first, 50 to a page in the browser: `activity` answers them all at once), the ledger as a CSV,
 * the owner's actions and where each stands, the autopilot's recorded runs, and the books. Read-only: nothing here acts.
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
  const hash = useRouterState({ select: state => state.location.hash });
  const rows = useMemo(() => history(activity.data ?? []), [activity.data]);
  const [page, setPage] = useState(1);
  // A link to a row (`#op-…`) opens the page that holds it.
  useEffect(() => { if (hash.startsWith("op-")) setPage(pageOfRow(rows, hash.slice(3))); }, [hash, rows]);
  const pages = pageCount(rows.length);
  const shown = pageOf(rows, page);
  const fetching = [activity, unresolved, actions, runs, books].some(read => read.isFetching);
  const refresh = () => [reads.activity, reads.unresolved, reads.ownerActions, reads.runs, reads.books].forEach(read => void client.invalidateQueries({ queryKey: read.queryKey }));

  return <div className="flex flex-col gap-10">
    <div className="flex justify-end"><Button variant="ghost" size="sm" disabled={fetching} onClick={refresh}>{fetching ? "Checking…" : "Check again"}</Button></div>

    {unresolved.data && unresolved.data.length > 0 && <section id="unresolved" aria-labelledby="unresolved-title" className="flex flex-col gap-4">
      <h2 id="unresolved-title" className="text-xl font-semibold">Without a proven outcome</h2>
      <Card>
        <p className="text-sm text-muted-foreground">Nothing new runs until these are resolved, and nothing is sent again from here: the platform reconciles them on its own.</p>
        <ul aria-label="Without a proven outcome" className="flex flex-col gap-2 text-sm">
          {unresolved.data.map(item => <li key={item.key} id={unresolvedAnchor(item.key)} className="scroll-mt-24">
            <time dateTime={item.at}>{when(item.at)}</time> · {item.kind} · {describeRequest(item.request, book)}{item.status ? ` · ${item.status}` : ""} ({ago(item.at)})
          </li>)}
        </ul>
      </Card>
    </section>}

    <section id="history" aria-labelledby="history-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="history-title" className="text-xl font-semibold">History</h2>
        <a className="text-sm underline" href={activityCsvPath(reads.name)} download>Download CSV</a>
      </div>
      <Card>
        {activity.isPending ? <Loading label="Reading activity…" />
          : activity.isError ? <QueryError error={activity.error} retry={() => activity.refetch()} />
          : rows.length === 0 ? <Note>No activity yet. <PageLink to={agentAddress(identity.agent, "proposals")} className="underline">Propose a rebalance</PageLink> to get the agent started.</Note>
          : <>
            <ul aria-label="History" className="flex flex-col gap-4 text-sm">
              {shown.map((row, i) => <Row key={row.correlationId ?? `${row.at}-${i}`} reads={reads} row={row} book={book} />)}
            </ul>
            <nav aria-label="History pages" className="flex flex-wrap items-center gap-3 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
              <span role="status">Page {Math.min(page, pages)} of {pages} · {rows.length} {rows.length === 1 ? "row" : "rows"}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</Button>
            </nav>
          </>}
      </Card>
    </section>

    <section id="owner-actions" aria-labelledby="owner-actions-title" className="flex flex-col gap-4">
      <h2 id="owner-actions-title" className="text-xl font-semibold">Owner actions</h2>
      <Card>
        <p className="text-sm text-muted-foreground">What was asked of the owner for this agent, and where each stands, as the platform records it: the same on every device.</p>
        {actions.isPending ? <Loading label="Reading the owner's actions…" />
          : actions.isError ? <QueryError error={actions.error} retry={() => actions.refetch()} />
          : actions.data.length === 0 ? <p className="text-sm" role="status">No owner actions yet.</p>
          : <ul aria-label="Owner actions" className="flex flex-col gap-3 text-sm">
            {actions.data.map(action => <li key={action.correlationId} className="flex flex-col gap-1">
              <span className="font-medium">{actionName(action.type)}</span>
              <span>{actionStanding(action)}{action.stage === "prepared" && <> · expires {when(action.expiresAt)}</>}</span>
            </li>)}
          </ul>}
      </Card>
    </section>

    <section id="runs" aria-labelledby="runs-title" className="flex flex-col gap-4">
      <h2 id="runs-title" className="text-xl font-semibold">Autopilot runs</h2>
      <Card>
        {runs.isPending ? <Loading label="Reading the autopilot's runs…" />
          : runs.isError ? <QueryError error={runs.error} retry={() => runs.refetch()} />
          : runs.data.ticks.length === 0 ? <p className="text-sm" role="status">The autopilot hasn't run.</p>
          : <ul aria-label="Autopilot runs" className="flex flex-col gap-2 text-sm">
            {recentRuns(runs.data, Number.POSITIVE_INFINITY).map(run => <li key={run.id} className="flex flex-wrap items-center gap-x-3">
              <span><time dateTime={run.at}>{when(run.at)}</time> · {run.trigger === "schedule" ? "scheduled" : "by the operator"} · {run.outcome}{run.planUsd !== null && ` · plan ${usd(run.planUsd)}`}</span>
              <PageLink to={runAddress(identity.agent, run.id)} className="underline">Open the run of {when(run.at)}</PageLink>
            </li>)}
          </ul>}
        {runs.data && runs.data.corrupt.length > 0 && <p className="text-sm" role="alert">{runs.data.corrupt.length} recorded line(s) couldn't be read.</p>}
      </Card>
    </section>

    <section id="books" aria-labelledby="books-title" className="flex flex-col gap-4">
      <h2 id="books-title" className="text-xl font-semibold">Books</h2>
      <Card>
        <p className="text-sm text-muted-foreground">The provider's balances checked against the chain, and its private balances against recorded executions.</p>
        {books.isPending ? <Loading label="Reading the books…" />
          : books.isError ? <QueryError error={books.error} retry={() => books.refetch()} />
          : books.data.length === 0 ? <p className="text-sm" role="status">No balances to reconcile.</p>
          : <table className="w-full text-sm">
            <caption className="sr-only">Books</caption>
            <thead><tr className="text-left text-muted-foreground"><th scope="col" className="py-1 font-medium">Asset</th><th scope="col" className="py-1 font-medium">Public drift from chain</th><th scope="col" className="py-1 font-medium">Private, not attributed</th></tr></thead>
            <tbody>{books.data.map(row => <tr key={row.asset} className="border-t">
              <th scope="row" className="py-1 font-medium">{row.symbol}</th>
              <td className="py-1 font-mono break-all">{row.public.drift === "0" ? "none" : amountText(row.public.drift, row.asset)}</td>
              <td className="py-1 font-mono break-all">{row.confidential.unattributed === "0" ? "none" : amountText(row.confidential.unattributed, row.asset)}</td>
            </tr>)}</tbody>
          </table>}
      </Card>
    </section>
  </div>;
}

/** One recorded run of the autopilot (#136): how it started, what each stage found or did, and how it ended. */
export function Run({ reads, id, identity }: { reads: Reads; id: string; identity: Identity }) {
  const recording = useQuery(reads.recording(id));
  const missing = (() => { const failure = failureOf(recording.error); return failure?.kind === "refused" && failure.code === "not_found"; })();
  const summary = recording.data ? runSummary(recording.data) : undefined;
  return <section aria-labelledby="run-title" className="flex flex-col gap-4">
    <PageLink to={agentAddress(identity.agent, "activity")} className="self-start text-sm underline">Back to activity</PageLink>
    <h2 id="run-title" className="text-xl font-semibold">Run <span className="font-mono">{short(id, 12)}</span></h2>
    <Card>
      {recording.isPending ? <Loading label="Reading the run's recording…" />
        : missing ? <p role="alert">No run has this ID.</p>
        : recording.isError ? <QueryError error={recording.error} retry={() => recording.refetch()} />
        : summary && <div className="flex flex-col gap-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Started</dt><dd><time dateTime={summary.startedAt}>{when(summary.startedAt)}</time></dd>
            <dt className="text-muted-foreground">Started by</dt><dd>{summary.trigger === "schedule" ? "the schedule" : `the operator${summary.actor ? ` (${summary.actor})` : ""}`}</dd>
            <dt className="text-muted-foreground">How it ended</dt>
            <dd><span role="status">{summary.failed ? `Failed: ${summary.failed}` : summary.outcome !== null ? `${summary.outcome}${summary.refusal ? ` (refused: ${summary.refusal})` : ""}`
              : summary.completion === "no-recorded-end" ? "No end was recorded: only the progress it recorded is shown." : "No outcome recorded."}</span></dd>
          </dl>
          {summary.stages.length === 0 ? <p>No stages were recorded.</p>
            : <ol aria-label="Stages" className="flex flex-col gap-2">{summary.stages.map((stage, i) => <li key={i}><span className="font-medium">{stage.stage}</span> · {stage.detail}</li>)}</ol>}
        </div>}
    </Card>
  </section>;
}
