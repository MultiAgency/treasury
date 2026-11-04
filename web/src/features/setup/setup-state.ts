import type { OwnerActionRecord, Overview, Setup } from "../../platform.ts";

/** The owner actions that set an agent up: creating it, and its first policy and grant. */
export const SETUP_ACTIONS = ["agent_create", "grant_issue", "policy_update"] as const;

/**
 * The recorded setup actions, and whether another may be offered. While the records are unread or unreadable, an earlier
 * one is prepared or submitted, or (for creation) a creation already succeeded, nothing new is offered: a succeeded
 * creation with no agent reported yet is observed by reading setup again, never replaced by a second creation.
 */
export function setupBlock(records: readonly OwnerActionRecord[] | undefined, creationOnly: boolean) {
  const types: readonly string[] = creationOnly ? ["agent_create"] : SETUP_ACTIONS;
  const relevant = (records ?? []).filter(a => types.includes(a.type));
  const unfinished = relevant.filter(a => a.stage === "prepared" || a.stage === "submitted");
  const awaitingSetup = creationOnly && relevant.some(a => a.ownerSucceeded);
  return { records: relevant, unfinished, awaitingSetup, blocked: records === undefined || unfinished.length > 0 || awaitingSetup };
}

/** What a recorded setup action means for the next step, in words. */
export function setupRecordNote(a: Pick<OwnerActionRecord, "stage" | "ownerSucceeded" | "status">) {
  return a.stage === "submitted" ? "Submission attempted. Its outcome is not yet confirmed here; do not sign again."
    : a.stage === "prepared" ? "Prepared request. Review this request and any existing DAO proposal before signing again."
      : a.stage === "expired" ? "Signing window closed without a recorded submission attempt."
        : a.ownerSucceeded ? "Owner action succeeded. Check setup status to see what is now configured."
          : `Recorded outcome: ${a.status ?? "not available"}. Review this result before starting again.`;
}

/**
 * The next step for a created agent without a grant: the policy first while it isn't confirmed in force, then the
 * strategy, whose authorization is the Treasury agent's grant. Every agent in this build is a Treasury agent.
 */
export function nextSetupStep(setup: Pick<Setup, "executor">, overview: Pick<Overview, "notInForce"> | undefined) {
  const policyInForce = overview !== undefined && overview.notInForce === null;
  return {
    policy: !overview ? "Policy observations are unavailable. Review them before authorizing an action."
      : !policyInForce ? `Review the policy first: ${overview.notInForce ?? "its current state is not confirmed"}.`
        : "The policy is reported in force. This does not establish permission or funds for a particular action.",
    grant: setup.executor === false ? "This instance is approve-only; it does not hold an executor grant token." : "No current grant was reported for this instance.",
    to: policyInForce ? "/automations" as const : "/policy" as const,
    link: policyInForce ? "Review and authorize the Portfolio strategy" : "Review policy and permissions",
  };
}

/** The owner's signer for an agent not created yet: the DAO when the host lists its owner as one, otherwise the wallet. */
export const creationSigner = (listedAsDao: boolean | undefined, setup: Pick<Setup, "dao">): "wallet" | "dao" =>
  (listedAsDao ?? Boolean(setup.dao)) ? "dao" : "wallet";
