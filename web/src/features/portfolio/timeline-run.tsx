import { DownloadSimple } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useAgentReads, useOptionalSetup, useOverview } from "../../app/frame";
import { AGENT } from "../../app/location";
import { useCanCall, useViewer } from "../../app/viewer";
import { agent, failureMessage, runInProgress, scope, type OwnerResult, type Run } from "../../platform";
import { bindingWindow, PERIOD } from "../../shared/budget";
import { ago, amountOf, usd } from "../../shared/format";
import { OutcomeError } from "../../shared/outcome-error";
import { blockedBy } from "../../shared/send-block";
import { Badge, Button, Card, errorMessage, input, Loading, QueryError, Section, Spinner, StatusBadge, statusTone } from "../../shared/ui";
import { refusalText } from "../../shared/words";
import { ConfirmButton } from "../owner/confirm-button";
import { RunUpdates } from "./live-run";
import { checkRecording } from "./recording";

/**
 * An autopilot run as a timeline that doubles as its receipt, read from the evidence the scheduler itself records: the
 * book before, the quoted plan, each send's outcome, the budget before and after, and the book after.
 */

type Seen = NonNullable<Run["end"]>["before"];
type Window = { limit_usd: string | null; remaining_usd: string | null };

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const seen = (s: Seen) => ("error" in s ? null : s);
const budgetOf = (s: Seen) => (seen(s)?.budget ?? null) as Record<keyof typeof PERIOD, Window> | null;

/** What the window that refuses first had left before and after the run; an unknown amount says so, never $0. */
const budgetChange = (before: Seen, after: Seen) => {
  const windows = budgetOf(after);
  const w = windows ? bindingWindow(windows) : undefined;
  if (!w) return "no USD budget limit read";
  const left = (v: string | null | undefined) => (v == null ? "unknown" : usd(Number(v)));
  return `${PERIOD[w.period].toLowerCase()} budget left ${left(budgetOf(before)?.[w.period]?.remaining_usd)} → ${left(w.remaining_usd)}`;
};

/** How a run is named in a list: when, who started it, and how it ended. */
const runLabel = (run: Run) =>
  `${ago(run.at)}, ${run.trigger === "operator" ? "Run now" : "scheduled"}: ${run.end ? run.end.outcome : runInProgress(run) ? "running" : "no recorded end"}`;

/**
 * Run now: one autopilot tick, sent once. It carries no identity, so an unknown outcome can't be linked to one record: Run
 * now isn't offered again from this page, and the platform's records (a run without a recorded end, unresolved
 * operations) hold it back after a reload.
 */
function useRunNow(onStart: () => void) {
  const api = useMemo(() => agent(AGENT!), []);
  const queryClient = useQueryClient();
  const account = useViewer()?.account ?? null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnerResult<string>>();
  const [unknown, setUnknown] = useState(false);
  const start = async () => {
    if (busy || unknown) return;
    setBusy(true);
    setResult(undefined);
    const pending = api.act("autopilot/tick", undefined);
    // Its first recorded steps show while it runs.
    setTimeout(onStart, 1_000);
    const ran = await pending;
    setResult(ran);
    if (!ran.ok && ran.kind === "unknown") setUnknown(true);
    setBusy(false);
    await queryClient.invalidateQueries({ queryKey: [scope(AGENT!, account)] });
  };
  const failure = result && !result.ok ? result : undefined;
  return { start, busy, unknown, summary: result?.ok ? result.value : undefined, error: failure && failureMessage(failure), kind: failure?.kind };
}

/** The recorded runs and Run now, which records a run the view then follows. */
function useRuns(onRunNow: () => void) {
  const setup = useOptionalSetup();
  const agentReads = useAgentReads();
  const canRun = useCanCall("autopilot/tick");
  const evidence = useQuery(agentReads.runs);
  const unresolved = useQuery(agentReads.unresolved);
  const run = useRunNow(() => { onRunNow(); void evidence.refetch(); });
  const runs = evidence.data?.ticks ?? [];
  const latest = runs.at(-1);
  const pendingCount = unresolved.status === "success" ? unresolved.data.length : undefined;
  const unavailable = !canRun ? "Your account cannot start a new run."
    : !setup ? "Setup unavailable. Recorded runs remain readable; new runs are unavailable."
      : setup.executor === false ? "This instance is approve-only. Start new runs on the executor."
        : !setup.grant ? "This instance has no grant. Review grants and permissions before starting a new run."
          : run.unknown ? "The last Run now’s outcome is unknown: it may have started a run. Follow the recorded runs and Activity; Run now isn’t offered again from this page."
            : pendingCount ? `${blockedBy(pendingCount)} Follow their outcomes before a new run.`
              : undefined;
  const runNow = <ConfirmButton
    path="autopilot/tick"
    label={run.busy ? <><Spinner /> Running</> : "Run now"}
    disabled={run.busy || runInProgress(latest) || Boolean(unavailable) || !evidence.data}
    title="Run one autopilot tick on mainnet?"
    description="It shields public balances, previews swaps from the current balances, and executes only within the strategy's ceiling and the policy's limits."
    confirm="Run now"
    onConfirm={() => void run.start()}
  />;
  return { evidence, runs, run, runNow, unavailable };
}

/** Downloads one run's recording on request; it neither starts a run nor changes what is followed. */
function RunDownload({ tickId, agentId }: { tickId: string; agentId: string }) {
  const agentReads = useAgentReads();
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ busy?: boolean; message?: string }>({});
  const download = async () => {
    setState({ busy: true, message: "Preparing download…" });
    try {
      const recording = checkRecording(await queryClient.fetchQuery(agentReads.recording(tickId)), agentId, tickId);
      const href = URL.createObjectURL(new Blob([JSON.stringify(recording)], { type: "application/json" }));
      const link = Object.assign(document.createElement("a"), { href, download: `run-${tickId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json` });
      document.body.append(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1_000); }
      const gaps = recording.gaps.length;
      setState({ message: `Recording prepared${gaps ? ` with ${gaps} source gap${gaps === 1 ? "" : "s"}, listed in the file` : ""}.` });
    } catch (e) {
      setState({ message: `Download unavailable: ${errorMessage(e)}` });
    }
  };
  return <div className="flex min-w-0 flex-col gap-2">
    <p className="text-xs text-muted-foreground">Private JSON with this run’s balances and operation details.</p>
    <Button variant="outline" size="sm" className="self-start" disabled={state.busy} onClick={() => void download()}>
      {state.busy ? <Spinner /> : <DownloadSimple size={16} aria-hidden="true" />} Download recording
    </Button>
    <p role="status" aria-atomic="true" className={state.message ? "text-xs text-muted-foreground" : "sr-only"}>{state.message}</p>
  </div>;
}

/** One run's timeline, with its original outcome in view and its evidence on request. */
function RunView({ run }: { run: Run }) {
  const setup = useOptionalSetup();
  const book = useOverview()?.book ?? [];
  const end = run.end;
  const interrupted = end === null && !runInProgress(run);
  const before = end ? seen(end.before) : null;
  const after = end ? seen(end.after) : null;
  const sent = end?.steps ?? [];
  return <RunUpdates key={run.id} agentId={run.agentId} tickId={run.id} startedAt={run.at} ended={Boolean(end)} enabled={setup?.executor !== false}
    summary={<>
      {interrupted && <p className="text-sm text-warning-muted-foreground">This run started {ago(run.at)} and recorded no end: it was interrupted, or its outcome is unknown. Check Activity before running again.</p>}
      {!end ? <p>{interrupted ? "Current stage and outcome are unknown." : "Run started. No end recorded yet."}</p> : <>
        <p className="font-medium">Run outcome: {end.outcome}{end.refusal ? ` · refused: ${refusalText(end.refusal)}` : ""}</p>
        <p className="text-sm">At run end: {sent.length ? `${sent.filter(s => s.status === "SUCCESS").length} of ${sent.length} recorded swaps succeeded` : "No swap results recorded"}. {end.shields.length} shield results recorded.</p>
        <p className="text-sm text-muted-foreground">A recorded end does not prove every operation settled. Activity shows subsequent recorded outcomes.</p>
        {(!before || !after) && <p className="text-sm text-warning-muted-foreground">Some balance or budget observations are unavailable. Review Run details.</p>}
        {end.rejected.length > 0 && <p className="text-sm text-warning-muted-foreground">Execution stopped: {end.rejected.join("; ")}</p>}
      </>}
    </>}
    nextAction={<div className="flex flex-wrap gap-4 text-sm">
      <Button asChild variant="outline"><Link to="/activity">Check operation outcomes in Activity</Link></Button>
      {end?.plan && <Link to="/" hash="rebalance" className="inline-flex min-h-11 items-center underline">Create a fresh rebalance preview</Link>}
    </div>}
    details={<>
      {end && <>
        {(end.plan?.legs.length || end.shields.length) ? <h4 className="font-medium">Operations at run end</h4> : null}
        {end.plan && <ul className="flex flex-col divide-y text-sm">
          {end.plan.legs.map((leg, i) => {
            const step = sent.find(s => s.index === i);
            return <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex flex-col gap-1">
                <span>{amountOf(leg.amount, leg.from, book)} → estimated {amountOf(leg.amountOut, leg.to, book)}</span>
                <span className="text-xs text-muted-foreground">Swap {i + 1} · quoted cost {leg.costBps / 100}%</span>
              </span>
              {step ? <span className="flex items-center gap-2">
                <StatusBadge status={step.status} failureCode={step.failureCode} />
                <Link to="/activity" hash={`operation-${step.correlationId}`} className="font-mono text-xs underline" title={step.correlationId}>Inspect {step.correlationId.slice(0, 12)}…</Link>
              </span> : <Badge>No result recorded</Badge>}
            </li>;
          })}
        </ul>}
        {end.shields.length > 0 && <ul aria-label="Shield results at run end" className="flex flex-wrap gap-2 text-sm">
          {end.shields.map(s => <li key={s.correlationId}><Link to="/activity" hash={`operation-${s.correlationId}`}><Badge tone={statusTone(s.status)}>{s.asset.replace(/^nep141:/, "")} · {s.status.toLowerCase()} · inspect</Badge></Link></li>)}
        </ul>}
        <dl className="grid gap-2 text-sm">
          <dt className="text-muted-foreground">The book before</dt><dd>{before ? `${pct(before.driftBps)} from target` : "Observation unavailable"}</dd>
          <dt className="text-muted-foreground">The plan</dt><dd>{end.plan ? `${end.plan.legs.length} swaps · ${usd(end.plan.usd)}` : "No plan recorded"}</dd>
          <dt className="text-muted-foreground">Budget and book after</dt><dd>{after ? `${pct(after.driftBps)} from target; ${budgetChange(end.before, end.after)}` : "Observation unavailable"}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">Recorded {new Date(run.at).toLocaleString()} → {new Date(end.endedAt).toLocaleString()} · policy revision {run.policy.revision ?? "–"} · build {run.build.deployment ?? "local"}</p>
      </>}
      <RunDownload key={run.id} tickId={run.id} agentId={run.agentId} />
    </>}
  />;
}

function IncompleteRuns({ retry }: { retry: () => void }) {
  return <div className="flex flex-col items-start gap-2 text-sm">
    <p className="text-warning-muted-foreground">Some run records could not be read. The available history is incomplete.</p>
    <Button variant="outline" onClick={retry}>Check again</Button>
  </div>;
}

/** The Runs page: the latest recorded run by default, any retained run selectable, and Run now. */
export function RunTimeline() {
  const { run: picked } = useSearch({ strict: false }) as { run?: string };
  const navigate = useNavigate();
  const setPicked = (run?: string) => { void navigate({ to: "/follow/run", search: run ? { run } : {}, replace: true }); };
  const { evidence, runs, run, runNow, unavailable } = useRuns(() => setPicked(undefined));
  const shown = picked ? runs.find(t => t.id === picked) : runs.at(-1);
  const incomplete = Boolean(evidence.data?.corrupt.length);
  return <Section title="Follow this run"
    description={shown ? `An autopilot run, ${shown.trigger === "operator" ? "started by Run now" : "on its schedule"}, ${ago(shown.at)}. Each step is what the scheduler recorded.` : undefined}>
    {run.summary !== undefined && <p role="status" className="text-sm">Run now returned: {run.summary} Operation outcomes are shown separately.</p>}
    <OutcomeError error={run.error} kind={run.kind} />
    {evidence.error && <QueryError error={evidence.error} retry={() => evidence.refetch()} />}
    {evidence.isPending && <Loading label="Loading recorded runs…" />}
    {incomplete && <IncompleteRuns retry={() => void evidence.refetch()} />}
    {runs.length > 0 && <label className="flex flex-col gap-2 text-sm">
      Run to view
      <select className={input} value={picked ?? ""} onChange={e => setPicked(e.target.value || undefined)}>
        <option value="">Latest run</option>
        {picked && !shown && <option value={picked}>Selected run no longer listed</option>}
        {[...runs].reverse().map(t => <option key={t.id} value={t.id}>{runLabel(t)}</option>)}
      </select>
    </label>}
    {shown && <RunView key={shown.id} run={shown} />}
    {evidence.isSuccess && !shown && !incomplete && <Card>
      <p className="text-sm">{picked ? "The selected run was not found in this executor’s retained records." : "No autopilot run found in this executor’s retained records."}</p>
      {picked && runs.length > 0 ? <Link to="/follow/run" search={{}} replace className="inline-flex min-h-11 items-center text-sm underline">View latest run</Link>
        : unavailable ? <Link to="/activity" className="inline-flex min-h-11 items-center text-sm underline">Review operation history</Link>
          : <p className="text-sm text-muted-foreground">Review Run now below to start the first recorded run.</p>}
    </Card>}
    {evidence.data && <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-6">
      <div className="max-w-prose text-sm">
        <h3 className="font-medium">Start a new run</h3>
        <p className="text-muted-foreground">{unavailable ?? (runInProgress(runs.at(-1)) ? "A run is in progress. Follow it above before starting another." : "Run now starts an autopilot tick using the current balances and policy.")}</p>
      </div>
      {runNow}
    </div>}
  </Section>;
}
