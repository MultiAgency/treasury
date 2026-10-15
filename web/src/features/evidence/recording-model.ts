import { STAGE_LABEL } from "../../../../src/run-progress-schema.js";
import { MAX_RECORDING_BYTES, RecordingSchema, type Recording, type RunLogEvent } from "../../../../src/run-log-schema.js";

/** Read-only validation: a recording is evidence, never an instruction or a live status response. */
export function inspectRecording(value: unknown, agentId: string, tickId: string): Recording {
  const source = JSON.stringify(value);
  if (!source || source.length > MAX_RECORDING_BYTES || new TextEncoder().encode(source).length > MAX_RECORDING_BYTES)
    throw new Error("Recording is too large or missing.");
  const recording = RecordingSchema.parse(value);
  if (recording.agentId !== agentId || recording.tickId !== tickId) throw new Error("The recording does not match this agent and run.");
  return recording;
}

export function recordingSummary(recording: Recording): string {
  if (recording.completion !== "recorded-end") return "No run end recorded. The outcome is unknown.";
  const end = recording.events.at(-1);
  if (end?.type === "RUN_ERROR") return end.code === "tick_failed"
    ? "Run failure recorded. Operation outcomes are shown separately."
    : "Run end recorded with incomplete stage observations. Operation outcomes are shown separately.";
  return "Run end recorded. Operation outcomes are shown separately.";
}

type StageStart = Extract<RunLogEvent, { type: "STEP_STARTED" }>;
type StageReturn = Extract<RunLogEvent, { type: "STEP_FINISHED" }>;
export type RecordedProgressItem =
  | { kind: "stage"; id: string; stepName: StageStart["stepName"]; started: StageStart; returned?: StageReturn }
  | { kind: "submission"; id: string; method: string; correlationId: string; timestamp?: number };

/** Display projection of validated events. Missing observations remain missing, including after a run ends. */
export function recordingProgress(recording: Recording): { items: RecordedProgressItem[]; latest: RunLogEvent | undefined } {
  const items: RecordedProgressItem[] = [];
  const stages = new Map<StageStart["stepName"], Extract<RecordedProgressItem, { kind: "stage" }>>();
  let latest: RunLogEvent | undefined;
  for (const event of recording.events) {
    if (event.type === "STEP_STARTED") {
      const item: Extract<RecordedProgressItem, { kind: "stage" }> = {
        kind: "stage", id: event.metadata.eventId, stepName: event.stepName, started: event,
      };
      stages.set(event.stepName, item);
      items.push(item);
      latest = event;
    } else if (event.type === "STEP_FINISHED") {
      const item = stages.get(event.stepName);
      if (item) item.returned = event;
      latest = event;
    } else if (event.type === "CUSTOM" && event.value.stage === "submission") {
      // Steps may overlap. The source does not identify a submission's stage, so keep it independent.
      items.push({ kind: "submission", id: event.metadata.eventId, method: event.value.method,
        correlationId: event.value.correlationId, timestamp: event.timestamp });
      latest = event;
    }
  }
  return { items, latest };
}

export function observationLabel(event: RunLogEvent): string {
  if (event.type === "RUN_STARTED") return "Run started";
  if (event.type === "RUN_FINISHED") return "Run end recorded";
  if (event.type === "RUN_ERROR") return event.code === "tick_failed" ? "Run failure recorded" : "Run end · incomplete stage observations";
  if (event.type === "STEP_STARTED") return `${STAGE_LABEL[event.stepName]} · started`;
  if (event.type === "STEP_FINISHED") return `${STAGE_LABEL[event.stepName]} · returned`;
  const value = event.value;
  switch (value.stage) {
    case "submission": return `${value.method[0]!.toUpperCase()}${value.method.slice(1)} submitted · outcome not yet established`;
    case "before": return "Balances before";
    case "after": return "Balances after";
    case "plan": return "Plan recorded";
    case "shield": return `Shield ${value.index + 1} · ${value.status}`;
    case "send": return `Swap ${value.index + 1} · ${value.status}`;
  }
}
