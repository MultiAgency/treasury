import { STAGE_LABEL } from "@multiagency/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useAgentReads } from "../../app/frame";
import { RUN_STALE_MS } from "../../platform";
import { Badge, Button, Card, Details, StatusBadge } from "../../shared/ui";
import { checkRecording, observationLabel, operationLabel, recordingProgress, recordingSummary, type RecordedProgressItem } from "./recording";

function RecordedTime({ timestamp }: { timestamp?: number }) {
  return timestamp === undefined ? <>Timing unknown</> : <time dateTime={new Date(timestamp).toISOString()}>{new Date(timestamp).toLocaleTimeString()}</time>;
}

/** One row per observed stage, with each submission on its own. No progress or settlement is inferred. */
function RecordedProgress({ items }: { items: RecordedProgressItem[] }) {
  return <div className="flex flex-col gap-2">
    <p className="text-muted-foreground">Stages are listed by recorded start. A return or submission does not establish an operation outcome.</p>
    <ol aria-label="Recorded stages and submissions" className="flex flex-col divide-y">
      {items.map(item => <li key={item.id} className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
        {item.kind === "stage" ? <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{STAGE_LABEL[item.stepName]}</span>
            <Badge>{item.returned ? "Return recorded" : "No return recorded"}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Started <RecordedTime timestamp={item.started.timestamp} />
            {item.returned && <> · Returned <RecordedTime timestamp={item.returned.timestamp} /></>}
          </p>
        </> : <>
          <p className="font-medium">{item.method[0]!.toUpperCase()}{item.method.slice(1)} submitted</p>
          <p className="text-muted-foreground">Outcome not yet established by this observation.</p>
          <p className="text-xs text-muted-foreground"><RecordedTime timestamp={item.timestamp} /></p>
          <Link to="/activity" hash={`operation-${item.correlationId}`} className="inline-flex min-h-11 items-center self-start underline">Inspect submitted {item.method}</Link>
        </>}
      </li>)}
    </ol>
  </div>;
}

/**
 * One read-only timeline for a run: its recorded progress, its outcome and the operation outcomes recorded after it. The
 * recording is read every few seconds for ten minutes after the run starts, then only on request. Nothing here sends.
 */
export function RunUpdates({ agentId, tickId, startedAt, ended, enabled, summary, nextAction, details }: {
  agentId: string; tickId: string; startedAt: string; ended: boolean; enabled: boolean;
  summary: ReactNode; nextAction: ReactNode; details: ReactNode;
}) {
  const agentReads = useAgentReads();
  const [paused, setPaused] = useState(false);
  const cache = useQueryClient();
  const deadline = Date.parse(startedAt) + RUN_STALE_MS;
  const [recent, setRecent] = useState(() => Date.now() < deadline);
  // Following must end on time while paused or offline too, when no read causes a render.
  useEffect(() => {
    const remaining = deadline - Date.now();
    setRecent(remaining > 0);
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setRecent(false), remaining);
    return () => clearTimeout(timer);
  }, [deadline]);
  const read = agentReads.recording(tickId);
  const query = useQuery({
    ...read,
    queryFn: async context => checkRecording(await read.queryFn!(context as never), agentId, tickId),
    enabled,
    refetchInterval: q => !enabled || !recent || paused || q.state.status === "error" ? false : q.state.data?.completion === "recorded-end" ? 15_000 : 3_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const recording = !enabled || query.error ? undefined : query.data;
  const progress = recording ? recordingProgress(recording) : undefined;
  const latest = progress?.latest;
  useEffect(() => {
    if (!ended && recording?.completion === "recorded-end") void cache.invalidateQueries({ queryKey: agentReads.runs.queryKey, exact: true });
  }, [cache, ended, recording?.completion, agentReads]);
  return <section aria-label="Run timeline" className="min-w-0"><Card>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-heading text-lg font-medium">Run timeline</h3>
      <Badge>{!enabled ? "Retained records" : query.error ? "Read unavailable" : !recent ? "On request" : paused ? "Paused" : "Following"}</Badge>
    </div>
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {!ended && recording?.completion === "recorded-end"
        ? <p className="font-medium">{recordingSummary(recording)} The run receipt has not refreshed yet.</p>
        : summary}
      {enabled && <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 text-muted-foreground">
          {query.error ? "Run updates unavailable. The recorded run summary may be out of date."
            : !recent ? "Automatic following ended. Refresh outcomes to read the latest recorded evidence."
              : paused ? "Automatic updates paused. The agent may still be running."
                : !recording ? "Checking run updates…"
                  : ended || recording.completion === "recorded-end" ? "Following later operation outcomes."
                    : latest ? `Last recorded: ${observationLabel(latest)}.` : "No stage observations recorded yet."}
        </p>
        <Button variant="outline" size="sm" aria-busy={query.isFetching} disabled={query.isFetching} onClick={() => void query.refetch()}>{query.error ? "Retry run updates" : "Refresh outcomes"}</Button>
      </div>}
      {enabled && query.error && <p className="text-muted-foreground">{query.error.message}</p>}
      {enabled && query.dataUpdatedAt > 0 && !query.error && <p className="text-xs text-muted-foreground">Last read {new Date(query.dataUpdatedAt).toLocaleTimeString()}{paused || !recent ? ". Updates are not automatic." : "."}</p>}
      {recording && recording.gaps.length > 0 && <p className="text-muted-foreground">Some evidence is incomplete. Open Run details to inspect the recording.</p>}
      {progress && (progress.items.length > 0 ? <RecordedProgress items={progress.items} /> : <p className="text-muted-foreground">This recording has no stage observations.</p>)}
      {recording && recording.laterObservations.length > 0 && <div className="flex flex-col gap-2">
        <h4 className="font-medium">Later operation outcomes</h4>
        <p className="text-muted-foreground">Recorded after the run ended; these do not replace its original observations.</p>
        <ul className="divide-y">{recording.laterObservations.map(entry => {
          const label = operationLabel(recording, entry.correlationId);
          return <li key={`${entry.correlationId}:${entry.record.line}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
            <div className="flex flex-col gap-1">
              <span className="font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{entry.record.recordedAt ? new Date(entry.record.recordedAt).toLocaleString() : "Timing unknown"}</span>
            </div>
            <StatusBadge status={entry.record.status ?? entry.record.type} />
            <Link to="/activity" hash={`operation-${entry.correlationId}`} className="inline-flex min-h-11 items-center underline" aria-label={`Inspect ${label.toLowerCase()} in Activity`}>Inspect operation</Link>
          </li>;
        })}</ul>
      </div>}
      {nextAction}
      <Details summary="Run details">
        {details}
        {enabled && <div className="flex flex-col gap-3 border-t pt-4">
          <p>Checks every {recording?.completion === "recorded-end" ? 15 : 3} seconds for ten minutes after the run starts. Pausing this view does not stop the executor.</p>
          {recent && <Button variant="outline" size="sm" className="self-start" onClick={() => setPaused(!paused)}>{paused ? "Resume updates" : "Pause updates"}</Button>}
        </div>}
      </Details>
    </div>
  </Card></section>;
}
