import { ownerActionState } from "../owner/owner-observation.js";
import type { StrategyStatus } from "../../../../src/strategy-status.js";

type Read<T> = { data?: T; error: unknown };
/** Current observations and UI permissions only; server controls still authorize every change. */
export function strategyPresentation({ status, schedule, actions, review, executor, canSave, canStop, canSchedule, busy, canSign }: {
  status: Read<StrategyStatus>;
  schedule: Read<{ on: boolean }>;
  actions: Read<{ type: string; stage: string }[]> & { isSuccess: boolean };
  review?: StrategyStatus;
  executor: boolean; canSave: boolean; canStop: boolean; canSchedule: boolean; busy: boolean; canSign: boolean;
}) {
  const value = status.data?.readiness && status.data?.strategy ? status.data : undefined;
  const pendingGrant = Boolean(ownerActionState((actions.data ?? []).filter(a => a.type === "grant_issue")).recovering);
  const current = Boolean(value && !status.error && schedule.data && !schedule.error);
  const ready = current && Boolean(value?.readiness.canEnable);
  const off = current && schedule.data?.on === false;
  const ownerRead = actions.isSuccess && !actions.error && !pendingGrant;
  const currentReview = Boolean(review && value?.digest === review.digest && !status.error);
  return {
    value, ready, currentReview,
    scheduleLabel: schedule.error ? "Schedule unknown" : schedule.data ? schedule.data.on ? "Schedule on" : "Schedule off" : undefined,
    readinessLabel: !current ? "Readiness unknown" : !executor ? "Approve-only host"
      : value!.readiness.state === "blocked" ? "Blocked"
        : value!.grantMatches ? schedule.data!.on ? "Ready for scheduled runs" : "Off · strategy authorized" : "Needs owner authorization",
    showStop: canStop && executor && Boolean(schedule.data?.on || schedule.error || status.error),
    canEdit: canSave && executor && !busy && !pendingGrant,
    canReview: executor && off && Boolean(ownerRead) && !busy,
    canAuthorize: executor && off && currentReview && Boolean(ownerRead) && canSign && !busy,
    canEnable: canSchedule && executor && ready && !busy,
  };
}
