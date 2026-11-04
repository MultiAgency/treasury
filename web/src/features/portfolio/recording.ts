import { STAGE_LABEL, type RunLogEvent } from "@multiagency/sdk";
import type { Recording } from "../../platform.ts";

/**
 * A run's recording, as `autopilot/log` answers it (the SDK has already validated its format). It is evidence of what the
 * scheduler observed, never an instruction or a live status: a recording for another agent or run is refused.
 */
export function checkRecording(recording: Recording, agentId: string, tickId: string): Recording {
  if (recording.agentId !== agentId || recording.tickId !== tickId) throw new Error("The recording does not match this agent and run.");
  return recording;
}

/** What the recording says about the run's end; operation outcomes are always read separately. */
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

/** Display projection of the recorded events. A missing observation stays missing, including after a run ends. */
export function recordingProgress(recording: Pick<Recording, "events">): { items: RecordedProgressItem[]; latest: RunLogEvent | undefined } {
  const items: RecordedProgressItem[] = [];
  const stages = new Map<StageStart["stepName"], Extract<RecordedProgressItem, { kind: "stage" }>>();
  let latest: RunLogEvent | undefined;
  for (const event of recording.events) {
    if (event.type === "STEP_STARTED") {
      const item: Extract<RecordedProgressItem, { kind: "stage" }> = { kind: "stage", id: event.metadata.eventId, stepName: event.stepName, started: event };
      stages.set(event.stepName, item);
      items.push(item);
      latest = event;
    } else if (event.type === "STEP_FINISHED") {
      const item = stages.get(event.stepName);
      if (item) item.returned = event;
      latest = event;
    } else if (event.type === "CUSTOM" && event.value.stage === "submission") {
      // Steps may overlap, and the record doesn't say which stage a submission belongs to: it stays its own item.
      items.push({ kind: "submission", id: event.metadata.eventId, method: event.value.method, correlationId: event.value.correlationId, timestamp: event.timestamp });
      latest = event;
    }
  }
  return { items, latest };
}

const capital = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** One recorded event in words. A submission never reads as settled. */
export function observationLabel(event: RunLogEvent): string {
  if (event.type === "RUN_STARTED") return "Run started";
  if (event.type === "RUN_FINISHED") return "Run end recorded";
  if (event.type === "RUN_ERROR") return event.code === "tick_failed" ? "Run failure recorded" : "Run end · incomplete stage observations";
  if (event.type === "STEP_STARTED") return `${STAGE_LABEL[event.stepName]} · started`;
  if (event.type === "STEP_FINISHED") return `${STAGE_LABEL[event.stepName]} · returned`;
  const value = event.value;
  switch (value.stage) {
    case "submission": return `${capital(value.method)} submitted · outcome not yet established`;
    case "before": return "Balances before";
    case "after": return "Balances after";
    case "plan": return "Plan recorded";
    case "shield": return `Shield ${value.index + 1} · ${value.status}`;
    case "send": return `Swap ${value.index + 1} · ${value.status}`;
  }
}

/** The send or shield a later journal observation belongs to, by its correlation id; "Operation" when it isn't one. */
export function operationLabel(recording: Pick<Recording, "events">, correlationId: string): string {
  const matches = recording.events.flatMap(event => event.type === "CUSTOM" && (event.value.stage === "send" || event.value.stage === "shield")
    && event.value.correlationId === correlationId ? [event.value] : []);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? `${only.stage === "send" ? "Swap" : "Shield"} ${only.index + 1}` : "Operation";
}
