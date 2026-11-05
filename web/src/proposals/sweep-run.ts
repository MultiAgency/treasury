import type { OwnerFailure, OwnerOutput } from "@multiagency/sdk";
import { sweepActivity, SWEEP_ACTIVITY } from "../../../apps/server/src/contract.ts";
import { settle, type Outcome } from "../shared/execution-outcome.ts";
import type { SweepRun } from "./proposals-api.ts";

type Activity = ReturnType<typeof sweepActivity.parse>;

/**
 * What a sweep's AG-UI run reported, decided as the owner UI decides a sweep (`settle`): its last activity snapshot, and
 * how it ended. `RUN_FINISHED` ended normally; `RUN_ERROR` failed, its `code` the failure's kind; no terminal event is a
 * truncated run, which the SDK reports as `unknown`: a shield may have gone out. `offerAgain` is false when funds may
 * have moved.
 */
export function sweepOutcome(run: SweepRun, execute: boolean): { activity: Activity; outcome: Outcome; offerAgain: boolean } {
  const snapshots = run.events.filter(event => event.type === "ACTIVITY_SNAPSHOT" && event.activityType === SWEEP_ACTIVITY);
  const last = snapshots.at(-1);
  const activity = last ? sweepActivity.parse(last.content) : { exposed: [], shields: [] };
  const end = run.events.at(-1);
  // `settle` reads only a failure's kind here; the platform's text never reaches the page.
  const ended = end?.type === "RUN_FINISHED" ? undefined
    : end?.type === "RUN_ERROR" ? { ok: false, kind: end.code ?? "unavailable", error: end.message } as OwnerFailure
    : { ok: false, kind: "unknown", procedure: "sweep", identity: { execute } } as OwnerFailure;
  const events: OwnerOutput<"sweep">[] = activity.shields.map(shield => ({ type: "shield", ...shield }));
  return { activity, ...settle({ procedure: "sweep", input: { execute }, events, ended }) };
}
