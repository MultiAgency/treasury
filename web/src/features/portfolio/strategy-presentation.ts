import type { StrategyStatus } from "../../platform";
import { awaitingOutcome } from "../owner/owner-observation";

type Read<T> = { data?: T; error: unknown };
/** Current observations and UI permissions only; server controls still authorize every change. */
export function strategyPresentation({ status, schedule, actions, review, executor, canSave, canStop, canSchedule, busy, canSign }: {
  status: Read<StrategyStatus>;
  schedule: Read<{ on: boolean }>;
  actions: Read<{ type: string; stage: string; signer: string; correlationId: string }[]> & { isSuccess: boolean };
  review?: StrategyStatus;
  executor: boolean; canSave: boolean; canStop: boolean; canSchedule: boolean; busy: boolean; canSign: boolean;
}) {
  const value = status.data?.readiness && status.data?.strategy ? status.data : undefined;
  // A grant submitted, or proposed to the DAO and awaiting its vote: never signed or proposed again from here.
  const pendingGrant = awaitingOutcome(actions.data ?? [], ["grant_issue"]);
  const current = Boolean(value && !status.error && schedule.data && !schedule.error);
  const ready = current && Boolean(value?.readiness.canEnable);
  const off = current && schedule.data?.on === false;
  const ownerRead = actions.isSuccess && !actions.error && !pendingGrant;
  const currentReview = Boolean(review && value?.digest === review.digest && !status.error);
  return {
    value, ready, currentReview, pendingGrant,
    scheduleLabel: schedule.error ? "Schedule unknown" : schedule.data ? schedule.data.on ? "Schedule on" : "Schedule off" : undefined,
    readinessLabel: !current ? "Readiness unknown" : !executor ? "Approve-only host"
      : value!.readiness.state === "blocked" ? "Blocked"
        : value!.grantMatches ? schedule.data!.on ? "Ready for scheduled runs" : "Off · strategy authorized" : "Needs owner authorization",
    // Offered unless the schedule's latest read confirms it off, as on the Overview.
    showStop: canStop && executor && Boolean(!schedule.data || schedule.error || schedule.data.on),
    canEdit: canSave && executor && !busy && !pendingGrant,
    canReview: executor && off && Boolean(ownerRead) && !busy,
    canAuthorize: executor && off && currentReview && Boolean(ownerRead) && canSign && !busy,
    canEnable: canSchedule && executor && ready && !busy,
  };
}
