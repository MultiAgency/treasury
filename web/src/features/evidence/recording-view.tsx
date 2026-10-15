import { useId, useState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import type { Recording, RunLogEvent } from "../../../../src/run-log-schema";
import { observationLabel, recordingProgress, recordingSummary } from "./recording-model";
import { RecordedProgress } from "./recorded-progress";
import { Badge, Button, Details } from "../../shared/ui";

export function Observation({ event }: { event: RunLogEvent }) {
  if (event.type === "RUN_STARTED") return <p>The scheduler recorded the start of this run.</p>;
  if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
    const result = event.type === "RUN_ERROR" ? event.metadata.tickResult : event.result;
    return <div className="flex flex-col gap-2">
      {event.type === "RUN_ERROR" && event.code === "progress_incomplete" && <p>{event.message}</p>}
      <p>{result.outcome}</p>
      {result.refusal && <p>Refusal: {result.refusal}</p>}
      {result.rejected.length > 0 && <ul className="list-disc pl-5">{result.rejected.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
      <p className="text-muted-foreground">This recorded end does not prove that any operation settled.</p>
    </div>;
  }
  if (event.type === "STEP_STARTED" || event.type === "STEP_FINISHED") return <p>{observationLabel(event)}. A stage returning does not establish an operation outcome.</p>;
  const value = event.value;
  if (value.stage === "submission") return <p className="break-all">The provider accepted this {value.method}: {value.correlationId}. Acceptance does not establish settlement.</p>;
  if (value.stage === "before" || value.stage === "after") {
    const seen = value.observation;
    return "error" in seen ? <p>Observation unavailable: {seen.error}</p> : <div className="flex flex-col gap-2">
      <p>{(seen.driftBps / 100).toFixed(2)} percentage points from target · {seen.unresolved} unresolved operation{seen.unresolved === 1 ? "" : "s"}</p>
      <p>{seen.book.length} asset balances recorded at {new Date(seen.at).toLocaleString()}.</p>
      <Details summary="Balances and budget as recorded"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(seen, null, 2)}</pre></Details>
    </div>;
  }
  if (value.stage === "plan") return <div className="flex flex-col gap-2">
    <p>{value.plan ? `${value.plan.legs.length} planned swaps · $${value.plan.usd.toFixed(2)}` : "No plan recorded."}</p>
    <p>{value.summary}</p>
    {value.rejected.length > 0 && <ul className="list-disc pl-5">{value.rejected.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
    {value.plan && <Details summary="Quoted amounts and floors"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value.plan, null, 2)}</pre></Details>}
  </div>;
  return <div className="flex flex-col gap-2">
    <p>Status at run end: <strong>{value.status}</strong>{value.failureCode && ` · ${value.failureCode}`}</p>
    <p className="break-all">Operation: {value.correlationId || "Not recorded"}</p>
    <Details summary="Journal observations during this run">
      {value.history.length ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value.history, null, 2)}</pre> : <p>No associated, timed journal observations.</p>}
      {value.untimedHistory.length > 0 && <><p>Timing unknown for {value.untimedHistory.length} additional records:</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value.untimedHistory, null, 2)}</pre></>}
    </Details>
  </div>;
}

/** Optional inspection of an existing recording. No timer, network, replay, or action callbacks. */
export function RecordingView({ recording }: { recording: Recording }) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const event = recording.events[index] ?? recording.events[0]!;
  const progress = recordingProgress(recording);
  return <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-4 rounded-xl border p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2"><h3 id={`${id}-title`} className="font-medium">Recorded observations</h3><Badge>Historical · read only</Badge></div>
    <p>{recordingSummary(recording)}</p>
    <p className="text-muted-foreground">Snapshot exported {new Date(recording.exportedAt).toLocaleString()}. This is not live progress. Missing timing stays unknown.</p>
    {recording.gaps.length > 0 && <Details summary={`${recording.gaps.length} source gaps`} open>
      <ul className="flex flex-col gap-1">{recording.gaps.map((gap, i) => <li key={i} className="break-all">{gap.code}{gap.line && ` · line ${gap.line}`}{gap.ref && ` · ${gap.ref}`}</li>)}</ul>
    </Details>}
    <RecordedProgress items={progress.items} />
    <Details summary="Inspect individual observations">
    <label className="flex flex-col gap-2">Observation
      <NativeSelect value={index} onChange={(e) => setIndex(Number(e.target.value))}>
        {recording.events.map((item, i) => <option key={item.metadata.eventId} value={i}>{i + 1}. {observationLabel(item)}</option>)}
      </NativeSelect>
    </label>
    <div className="flex justify-between gap-3">
      <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</Button>
      <Button size="sm" variant="outline" disabled={index >= recording.events.length - 1} onClick={() => setIndex(index + 1)}>Next</Button>
    </div>
    <div role="status" aria-live="polite" className="flex min-w-0 flex-col gap-2">
      <h4 className="font-medium">{observationLabel(event)}</h4>
      <p className="text-muted-foreground">{event.timestamp === undefined ? "Event timing unknown" : `${event.metadata.timing === "observed" ? "Observed" : "Recorded"} ${new Date(event.timestamp).toLocaleString()}`}</p>
      <Observation event={event} />
    </div>
    </Details>
    {recording.laterObservations.length > 0 && <Details summary={`Later journal observations (${recording.laterObservations.length})`}>
      <p>Recorded after the run ended. These do not replace the run's original observations.</p>
      <ul className="flex flex-col gap-3">{recording.laterObservations.map((entry, i) => <li key={i} className="break-all">
        {entry.correlationId} · {entry.record.status ?? entry.record.type} · {entry.record.recordedAt ? new Date(entry.record.recordedAt).toLocaleString() : "Timing unknown"}
      </li>)}</ul>
    </Details>}
    <Details summary="Recording identity and context"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(recording.context, null, 2)}</pre></Details>
  </section>;
}
