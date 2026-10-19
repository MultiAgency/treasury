import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { GatewayAgent } from "../../app/session";
import { areaName } from "../../app/workspace";
import { clientFor } from "../../shared/client";
import { queriesFor } from "../../shared/queries";
import { deniedAt, onAccessDenial, recheckAccess, useAccessState } from "../../shared/access";
import { accessDenied, ReadFailure } from "../../shared/read-failure";
import { ago, kindOf, type Overview } from "../../shared/format";
import { refusalText } from "../../shared/words";
import { Badge, Button, CopyButton, Details, ErrorBox, Loading, Section } from "../../shared/ui";
import { BooksTable, downloadLedger, isProbe, Row } from "../activity/activity";
import { OwnerActionRecord } from "../owner/owner-actions";
import { describeOperation, describeOwner, describeRun, matchesHistory, type HistoryFilters } from "./activity-filters";

/** Books are requested only when opened, with this agent's API and cache scope. */
function AgentBooks({ agent, book }: { agent: GatewayAgent; book: Overview["book"] }) {
  const [open, setOpen] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const api = clientFor(`/a/${agent.name}`);
  const books = useQuery({ ...queriesFor(api, `/a/${agent.name}`).books, enabled: open, retry: false });
  useEffect(() => {
    const unsubscribe = onAccessDenial(denial => {
      if (denial.scope === "session" || denial.scope === "agent" && denial.base === `/a/${agent.name}`)
        exportController.current?.abort();
    });
    return () => {
      unsubscribe();
      exportController.current?.abort();
    };
  }, [agent.name]);
  const exportLedger = async () => {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(undefined);
    try { await downloadLedger(api, `ledger-${agent.name}`, controller.signal); }
    catch (error) { if (!controller.signal.aborted) setExportError(error instanceof Error ? error.message : "Ledger export failed."); }
    finally {
      if (exportController.current === controller) exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  };
  return <details className="text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-muted-foreground">Compare balances with records</summary>
    {open && <div className="mt-4 flex flex-col gap-3">
      <p>Public balances checked against the chain, confidential ones against the API's recorded executions. History filters do not change this comparison or the full ledger export.</p>
      {books.error ? <ReadFailure label="Books" error={books.error} retry={() => books.refetch()} retained={books.data !== undefined} updatedAt={books.dataUpdatedAt} />
        : books.isPending ? <Loading label="Reconciling the books…" />
          : <BooksTable rows={books.data} book={book} onExport={() => { if (!exporting) void exportLedger(); }} />}
      {exporting && <p role="status">Preparing ledger export…</p>}
      <ErrorBox error={exportError} />
    </div>}
  </details>;
}

/** One query set per agent, shared by unfiltered checks and filtered history. */
export function useHistory(agents: GatewayAgent[]) {
  const access = useAccessState();
  const reads = agents.map(agent => queriesFor(clientFor(`/a/${agent.name}`), `/a/${agent.name}`));
  const activities = useQueries({ queries: reads.map(read => ({ ...read.activity, retry: false, refetchInterval: 30_000 })) });
  const owners = useQueries({ queries: reads.map(read => ({ ...read.ownerActions, retry: false, refetchInterval: 30_000 })) });
  const unresolved = useQueries({ queries: reads.map(read => ({ ...read.unresolved, retry: false })) });
  const overviews = useQueries({ queries: reads.map(read => ({ ...read.overview, retry: false, staleTime: 30_000 })) });
  const treasury = agents.map((agent, i) => agent.area ? agent.area === "treasury" : overviews[i]?.data ? kindOf(overviews[i]!.data!) === "treasury" : areaName(agent) === "Portfolio");
  const runs = useQueries({ queries: reads.map((read, i) => ({ ...read.runs, enabled: treasury[i], retry: false, refetchInterval: 30_000 })) });
  return agents.map((agent, i) => {
    const checks = [activities[i]!, owners[i]!, unresolved[i]!, overviews[i]!, ...(treasury[i] ? [runs[i]!] : [])];
    return { agent, activity: activities[i]!, owners: owners[i]!, unresolved: unresolved[i]!, overview: overviews[i]!, runs: runs[i]!, treasury: treasury[i]!,
      denied: Boolean(deniedAt(access, `/a/${agent.name}`)) || checks.some(read => accessDenied(read.error)),
      incomplete: checks.some(read => Boolean(read.error) || read.isPending),
    };
  });
}
export type AgentHistoryState = ReturnType<typeof useHistory>[number];

export function historyRecords(history: AgentHistoryState) {
  if (history.denied) return [];
  return [
    ...(history.activity.data ?? []).map(describeOperation),
    ...(history.owners.data ?? []).map(describeOwner),
    ...(history.treasury ? history.runs.data?.ticks ?? [] : []).map(describeRun),
  ];
}

/** These observations are never affected by history filters, including the selected area. */
export function HistoryChecks({ history }: { history: AgentHistoryState }) {
  const { agent, activity, owners, unresolved, overview, runs, treasury, denied } = history;
  const unfinished = treasury ? runs.data?.ticks.filter(tick => !tick.end).length ?? 0 : 0;
  const checks = [["Unresolved operations", unresolved], ["Activity", activity], ["Owner actions", owners], ["Asset display data", overview], ...(treasury ? [["Run history", runs] as const] : [])] as const;
  return <div className="flex min-w-0 flex-col gap-3 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="font-medium">{areaName(agent)} · <span className="break-all">{agent.name}</span></p>
      {!denied && <a href={`/a/${agent.name}/activity`} className="inline-flex min-h-11 items-center underline">Review operation status<span className="sr-only"> · {agent.name}</span></a>}
    </div>
    {denied ? <>
      <p role="status" className="text-warning-muted-foreground">Access is unavailable. Private records for this agent are hidden.</p>
      <Button variant="outline" className="self-start" onClick={recheckAccess}>Check access again</Button>
    </> : <>
      {checks.map(([label, query]) => query.error && <ReadFailure key={label} label={label} error={query.error} retry={() => query.refetch()} retained={label !== "Asset display data" && query.data !== undefined} updatedAt={query.dataUpdatedAt} />)}
      {checks.some(([, query]) => query.isPending) && <Loading label="Checking history and unresolved operations…" />}
      {unresolved.isSuccess && !unresolved.data.length && <p className="text-muted-foreground">No unresolved operations are recorded on this instance.</p>}
      {Boolean(unresolved.data?.length) && <>
        <p className="text-warning-muted-foreground">Unresolved operations have no proven outcome. The agent sends nothing new until each is resolved.</p>
        <ul className="divide-y">{unresolved.data!.map(op => <li key={op.key} className="flex flex-wrap items-center gap-2 py-3">
          <span>{op.kind} · {ago(op.at)}</span><Badge tone="warning">{op.status?.toLowerCase() ?? "outcome unknown"}</Badge>
          <Details summary="Operation reference" className="basis-full"><span className="break-all font-mono text-xs">{op.key}</span><div><CopyButton text={op.key} /></div></Details>
        </li>)}</ul>
      </>}
      {(overview.error || !overview.data) && <p className="text-muted-foreground">Asset display data unavailable; amounts may appear in raw units.</p>}
      {treasury && Boolean(runs.data?.corrupt?.length) && <p className="text-warning-muted-foreground">{runs.data!.corrupt.length} unreadable run record{runs.data!.corrupt.length === 1 ? "" : "s"}; this history is incomplete.</p>}
      {unfinished > 0 && <p className="text-warning-muted-foreground">{unfinished} run{unfinished === 1 ? " has" : "s have"} no recorded end. They may still be active, interrupted, or their outcomes may be unknown.</p>}
    </>}
  </div>;
}

/** Full returned history stays scoped to its agent; filters only change its presentation. */
export function AgentHistory({ history, filters }: { history: AgentHistoryState; filters: HistoryFilters }) {
  const { agent, activity, owners, overview, runs, treasury, denied } = history;
  const base = `/a/${agent.name}` as const;
  const rows = denied ? [] : activity.data ?? [];
  const actions = rows.filter(op => !isProbe(op) && matchesHistory(describeOperation(op), filters));
  const probes = rows.filter(op => isProbe(op) && matchesHistory(describeOperation(op), filters));
  const ticks = (treasury && !denied ? runs.data?.ticks ?? [] : []).filter(tick => matchesHistory(describeRun(tick), filters));
  const ownerRows = (denied ? [] : owners.data ?? []).filter(action => matchesHistory(describeOwner(action), filters));
  const total = historyRecords(history).length;
  const count = actions.length + probes.length + ticks.length + ownerRows.length;
  if (denied) return null;
  const book = !overview.error ? overview.data?.book ?? [] : [];
  return <Section title={areaName(agent)} description={`${agent.owner} · ${agent.name}`}>
    {count > 0 && <p className="text-sm text-muted-foreground">{count} of {total} returned records shown.{history.incomplete && " Checks are incomplete; retained records may be out of date."}</p>}
      {ticks.length > 0 && <div className="flex flex-col gap-3 text-sm">
        <h3 className="font-medium">Runs</h3>
        <p className="text-muted-foreground">Recorded autopilot runs. A recorded end does not prove every operation settled.</p>
        {ticks.length > 0 && <Details summary={`Run history (${ticks.length})`}>
          <ol aria-label={`${agent.name} run history`} className="divide-y">
            {[...ticks].reverse().map(tick => <li key={tick.id} id={`${agent.name}-run-${tick.id}`}>
              <a href={`${base}/follow/run?run=${encodeURIComponent(tick.id)}`} className="flex min-h-11 flex-col gap-2 rounded-lg px-2 py-3 hover:bg-muted">
                <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{new Date(tick.at).toLocaleString()} · {tick.trigger === "operator" ? "Started manually" : "Scheduled"}</span><Badge tone={tick.end ? tick.end.refusal || tick.end.rejected.length ? "warning" : "neutral" : "warning"}>{tick.end ? "Recorded end" : "No recorded end"}</Badge></span>
                <span className="break-words">{tick.end?.outcome ?? "The current stage and outcome are unknown from this record."}</span>
                {tick.end?.refusal && <span className="text-warning-muted-foreground">Refused: {refusalText(tick.end.refusal)}</span>}
                {Boolean(tick.end?.rejected.length) && <span className="break-words text-warning-muted-foreground">Execution stopped: {tick.end!.rejected.join("; ")}</span>}
                <span className="underline">Inspect run</span>
              </a>
            </li>)}
          </ol>
        </Details>}
      </div>}
      {(actions.length > 0 || probes.length > 0) && <div className="flex flex-col gap-3">
        <h3 className="font-medium">Money actions</h3>
        <p className="text-sm text-muted-foreground">Recorded operations, including refusals, newest first.</p>
        <ol>{actions.map((op, i) => <Row key={`${op.at}-${i}`} op={op} idPrefix={`${agent.name}-`} book={book} nameOf={a => a} />)}</ol>
        {probes.length > 0 && <Details summary={`Earlier policy tests (${probes.length}): requests sent to be refused, from retired probes`}>
          <ol>{probes.map((op, i) => <Row key={`${op.at}-${i}`} op={op} idPrefix={`${agent.name}-`} book={book} nameOf={a => a} />)}</ol>
        </Details>}
      </div>}
      {ownerRows.length > 0 && <div className="flex flex-col gap-3">
        <h3 className="font-medium">Owner actions</h3>
        <p className="text-sm text-muted-foreground">Owner approval and payment settlement are separate outcomes.</p>
        {ownerRows.map(action => <OwnerActionRecord key={action.correlationId} action={action} base={base} idPrefix={`${agent.name}-`} />)}
      </div>}
      <AgentBooks agent={agent} book={book} />
  </Section>;
}
