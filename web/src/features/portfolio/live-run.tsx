import { queries } from "../../shared/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { client } from "../../shared/lib";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { inspectRecording, observationLabel, recordingProgress, recordingSummary } from "../evidence/recording-model";
import { RecordedProgress } from "../evidence/recorded-progress";
import { Badge, Button, Details, StatusBadge } from "../../shared/ui";

/** One read-only timeline for recorded progress, the run outcome and later operation observations. */
export function RunUpdates({ agentId, tickId, startedAt, ended, enabled, summary, nextAction, details }: {
  agentId: string; tickId: string; startedAt: string; ended: boolean; enabled: boolean;
  summary: ReactNode; nextAction: ReactNode; details: ReactNode;
}) {
  const [paused, setPaused] = useState(false);
  const cache = useQueryClient();
  const deadline = Date.parse(startedAt) + 10 * 60_000;
  const [recent, setRecent] = useState(() => Date.now() < deadline);
  // Expiry must also work while paused or disconnected, when no query causes a render.
  useEffect(() => {
    const remaining = deadline - Date.now();
    setRecent(remaining > 0);
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setRecent(false), remaining);
    return () => clearTimeout(timer);
  }, [deadline]);
  const query = useQuery({
    ...queries.recording(agentId, tickId),
    queryFn: async ({ signal }) => inspectRecording(await client.autopilot.log({ tickId }, { signal }), agentId, tickId),
    enabled: enabled && recent && !paused,
    refetchInterval: (q) => !enabled || !recent || paused || q.state.status === "error" ? false : q.state.data?.completion === "recorded-end" ? 15_000 : 3_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
  const recording = !enabled || query.error ? undefined : query.data;
  const progress = recording ? recordingProgress(recording) : undefined;
  const latest = progress?.latest;
  useEffect(() => {
    if (!ended && recording?.completion === "recorded-end") {
      void cache.invalidateQueries({ queryKey: ["autopilot", "evidence", "timeline", "history"] });
    }
  }, [cache, ended, recording?.completion]);
  return <section aria-label="Run timeline" className="min-w-0"><Card>
    <CardHeader className="flex flex-wrap items-center justify-between gap-3">
      <CardTitle><h3>Run timeline</h3></CardTitle>
      <Badge>{!enabled ? "Retained records" : query.error ? "Read unavailable" : !recent ? "On request" : paused ? "Paused" : "Following"}</Badge>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4 text-sm">
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
    {enabled && query.dataUpdatedAt > 0 && !query.error && <p className="text-xs text-muted-foreground">Last read {new Date(query.dataUpdatedAt).toLocaleTimeString()}{paused || !recent ? ". Updates are not automatic." : "."}</p>}
    {recording && recording.gaps.length > 0 && <p className="text-muted-foreground">Some evidence is incomplete. Open Run details to inspect the recording.</p>}
    {progress && progress.items.length > 0 && <RecordedProgress items={progress.items} />}
    {recording && recording.laterObservations.length > 0 && <div>
      <h4 className="font-medium">Later operation outcomes</h4>
      <p className="text-muted-foreground">Recorded after the run ended; these do not replace its original observations.</p>
      <ul className="divide-y">{recording.laterObservations.map((entry) => {
        const matches = recording.events.filter(event => event.type === "CUSTOM" && (event.value.stage === "send" || event.value.stage === "shield") && event.value.correlationId === entry.correlationId);
        const event = matches.length === 1 ? matches[0] : undefined;
        const label = event?.type === "CUSTOM" && (event.value.stage === "send" || event.value.stage === "shield")
          ? `${event.value.stage === "send" ? "Swap" : "Shield"} ${event.value.index + 1}` : "Operation";
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
      <p>Checks every {recording?.completion === "recorded-end" ? 15 : 3} seconds for ten minutes after the run starts. Pauses in background tabs. Pausing this view does not stop the executor.</p>
      {recent && <Button variant="outline" size="sm" className="self-start" onClick={() => setPaused(!paused)}>{paused ? "Resume updates" : "Pause updates"}</Button>}
      </div>}
    </Details>
    </CardContent>
  </Card></section>;
}
