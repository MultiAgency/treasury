/** Explanations of observed state only. Existing presentation and server checks govern every control. */
export function strategyProgress({ editing, statusUnknown, actionsUnknown, pendingGrant, grantMatches, scheduleOn, executor, ready }: {
  editing: boolean;
  statusUnknown: boolean;
  actionsUnknown: boolean;
  pendingGrant?: string;
  grantMatches: boolean | null;
  scheduleOn?: boolean;
  executor: boolean;
  ready: boolean;
}) {
  const unknown = statusUnknown || actionsUnknown;
  return {
    configuration: editing ? "Unsaved draft" : statusUnknown ? "Last loaded strategy" : "Saved strategy",
    authorization: unknown ? "Authorization not confirmed" : pendingGrant ? `Owner action ${pendingGrant}`
      : grantMatches === null ? "Check on the executor" : grantMatches ? "Authorized for the saved strategy" : "Matching grant needed",
    schedule: scheduleOn === undefined ? "Schedule not confirmed" : !scheduleOn ? "Off · no scheduled runs"
      : unknown ? "On · readiness not confirmed" : ready ? "On · ready for scheduled runs" : "On · readiness blocked",
    next: editing ? "Your draft does not change the saved strategy. Saving stops the schedule; review authorization before turning it on again."
      : !executor ? "Continue strategy setup on the executor. This instance does not run the schedule."
      : unknown || scheduleOn === undefined ? "Retry the unavailable checks before authorizing or enabling the schedule."
      : pendingGrant ? "Follow the existing owner action before preparing another authorization."
      : !grantMatches ? scheduleOn ? "Turn off the schedule, then review authorization for the saved strategy." : "Review authorization for the saved strategy. Authorizing does not turn on the schedule."
      : !ready ? "Review the blockers below. A matching grant alone does not make the strategy ready to run."
      : scheduleOn ? "Follow Runs to inspect what happened. An enabled schedule does not prove an operation completed."
      : "Review Turn on to enable scheduled runs. The matching grant is already recorded for this saved strategy.",
  };
}
