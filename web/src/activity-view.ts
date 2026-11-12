// What the Activity page shows (#136), from the owner reads: pure, so it's tested without a browser.
// With its extensions: test/activity-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import type { ActivityRead, RecordingRead } from "./server-api.ts";
import { actionPhase, outcomeOf, type OwnerActionRecord } from "../../apps/server/src/owner-action.ts";

/** Rows to a page: `activity` answers every row at once, and the browser pages through them (no further reads). */
export const PAGE_SIZE = 50;

type Row = Pick<ActivityRead[number], "at"> & { correlationId?: string | undefined };

/** Every row, newest first; rows at the same moment keep the order the platform gave them. */
export const history = <R extends Row>(rows: readonly R[]): R[] =>
  rows.map((row, index) => ({ row, index })).sort((a, b) => Date.parse(b.row.at) - Date.parse(a.row.at) || a.index - b.index).map(({ row }) => row);

export const pageCount = (rows: number, size = PAGE_SIZE) => Math.max(1, Math.ceil(rows / size));

/** One page of rows (1-based); a page out of range is the nearest one. */
export function pageOf<R>(rows: readonly R[], page: number, size = PAGE_SIZE): R[] {
  const clamped = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), pageCount(rows.length, size));
  return rows.slice((clamped - 1) * size, clamped * size);
}

/** The anchor of an operation without a proven outcome, by its journal key. */
export const unresolvedAnchor = (key: string) => `unresolved-${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`;

type OwnerAction = Pick<OwnerActionRecord, "type" | "stage" | "phase" | "expiresAt" | "ownerSucceeded" | "failureCode" | "signer"> & Partial<Pick<OwnerActionRecord, "status">>;

// The record and status read share a phase, though their older stage names differ. An absent provider outcome is
// unconfirmed, rather than proof that a settled action failed or succeeded.
const actionOutcome = (action: OwnerAction) => outcomeOf({ stage: "unknown", phase: actionPhase(action), status: action.status ?? undefined, failureCode: action.failureCode });

/** The owner's action badge follows the same phase and outcome as its detailed words. */
export function actionBadge(action: OwnerAction): { label: string; tone: "warning" | "info" | "neutral" | "success" | "destructive" } {
  switch (actionPhase(action)) {
    case "open": return { label: "Waiting", tone: "warning" };
    case "submitted": return { label: "Submitting", tone: "info" };
    case "expired": return { label: "Expired", tone: "neutral" };
    case "settled": {
      const outcome = actionOutcome(action);
      return outcome === "succeeded" ? { label: "Done", tone: "success" }
        : outcome === "failed" ? { label: "Failed", tone: "destructive" }
        : outcome === "expired" ? { label: "Expired", tone: "neutral" }
        : { label: "Outcome unconfirmed", tone: "warning" };
    }
  }
}

const ACTIONS: Record<string, string> = {
  grant_issue: "Strategy grant", grant_revoke: "Revoke a grant", agent_freeze: "Freeze", agent_unfreeze: "Unfreeze", policy_update: "Policy change",
  agent_create: "Agent creation",
};
/** What an owner action is, in the owner's words; a kind this page doesn't know is shown as the platform names it. */
export const actionName = (type: string) => ACTIONS[type] ?? type;

/** Where an owner action stands, in words: its phase takes priority, and settlement alone isn't success. */
export function actionStanding(action: OwnerAction): string {
  switch (actionPhase(action)) {
    case "open": return action.signer === "dao" ? "Waiting for the DAO's vote" : "Waiting for the owner's signature";
    case "submitted": return "Signed: the platform is submitting it";
    case "expired": return "Expired before it was signed or voted on: nothing took effect";
    case "settled": {
      const outcome = actionOutcome(action);
      return outcome === "succeeded" ? "Done"
        : outcome === "failed" ? `Reported outcome: ${action.status}${action.failureCode ? ` (${action.failureCode})` : ""}`
        : outcome === "expired" ? "Expired before it was signed or voted on: nothing took effect"
        : "The action ended without a confirmed outcome";
    }
  }
}

export type RunStage = { stage: string; detail: string };
export type RunSummary = {
  startedAt: string; trigger: "schedule" | "operator"; actor: string | null;
  /** Whether the tick recorded its own end; one that didn't has only the progress it recorded. */
  completion: "recorded-end" | "no-recorded-end";
  outcome: string | null; refusal: string | null; failed: string | null;
  stages: RunStage[];
};

/** A recording's events as a short account of the run: how it started, each stage with what it found or did, and how it ended. */
export function runSummary(recording: RecordingRead): RunSummary {
  const stages: RunStage[] = [];
  let outcome: string | null = null, refusal: string | null = null, failed: string | null = null;
  for (const event of recording.events) {
    if (event.type === "RUN_FINISHED") { outcome = event.result.outcome; refusal = event.result.refusal; }
    else if (event.type === "RUN_ERROR") failed = event.message;
    else if (event.type === "CUSTOM") {
      const payload = event.value;
      switch (payload.stage) {
        case "plan": stages.push({ stage: "plan", detail: payload.plan ? `${payload.summary}: ${payload.plan.legs.length} swap(s), about ${payload.plan.usd} USD` : payload.summary }); break;
        case "send": stages.push({ stage: "send", detail: `operation ${payload.correlationId || "(none)"}: ${payload.status}${payload.failureCode ? ` (${payload.failureCode})` : ""}` }); break;
        case "shield": stages.push({ stage: "shield", detail: `${payload.asset}: ${payload.status}${payload.failureCode ? ` (${payload.failureCode})` : ""}` }); break;
        case "before": case "after": stages.push({ stage: payload.stage, detail: "error" in payload.observation ? `couldn't read: ${payload.observation.error}`
          : `${payload.observation.unresolved} unresolved, drift ${payload.observation.driftBps} bps` }); break;
        default: stages.push({ stage: payload.stage, detail: "recorded" });
      }
    }
  }
  return { startedAt: recording.context.at, trigger: recording.context.trigger, actor: recording.context.actor ?? null, completion: recording.completion, outcome, refusal, failed, stages };
}
