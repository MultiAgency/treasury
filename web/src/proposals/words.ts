import type { ProposalState } from "@multiagency/sdk";
import type { Outcome } from "../shared/execution-outcome.ts";
import type { Failure } from "./proposals-api.ts";

/** Where a failure happened: the same code reads differently for a sign-in and a proposal (`expired`). */
export type Context = "read" | "sign-in" | "consent" | "proposal";

const SIGN_IN: Record<string, string> = {
  rate_limited: "Too many sign-in attempts from this address. Wait a minute, then sign in again.",
  not_full_access: "That key isn't a full-access key of the account on chain. Sign in with a full-access key.",
  bad_signature: "The signature didn't verify for this server. Sign in again.",
  expired: "The sign-in text expired before it was signed. Sign in again.",
  unknown_challenge: "That sign-in text was already used, or this server didn't issue it. Sign in again.",
};
const CONSENT: Record<string, string> = {
  not_created: "This agent hasn't been created yet, so it can't be connected.",
  already_connected: "This agent is already connected.",
  agent_changed: "The agent changed since this text was prepared. Nothing was stored. Review the new text and sign again.",
  not_this_consent: "The signed text isn't the consent this server asks for now. Nothing was stored. Connect again.",
  consent_refused: "The platform didn't accept the consent. Nothing was stored.",
  // The same code for the owner routes' per-minute limit and the daily limit on new consents.
  rate_limited: "Too many requests from this account. Wait a minute and try again; if it has connected agents several times today, connecting again waits until tomorrow.",
};
/** Codes for a DAO-owned agent, wherever they come. */
const DAO: Record<string, string> = {
  dao_owner: "A DAO owns this agent: it approves and connects by its own vote, never a wallet signature.",
  not_dao: "This agent's owner signs with a wallet, not by a DAO's vote.",
  not_permitted: "Your roles in the DAO don't allow this.",
  vote_open: "A vote on the other verdict is still open for this proposal. Wait for it to end first.",
  dao_refused: "The platform didn't accept the request. Nothing was filed.",
  too_many_requests: "The app has filed as many DAO requests as the platform allows today. Try again tomorrow.",
};
const PROPOSAL: Record<string, string> = {
  no_proposal: "There's no such proposal for this agent.",
  not_this_text: "The signed text no longer matches the proposal. Nothing was relayed. Review it again.",
  not_open: "The proposal is no longer open. Nothing was relayed.",
  expired: "The proposal has expired. Nothing was relayed.",
  not_approved: "The proposal isn't approved, so nothing was sent.",
  not_connected: "No live consent connects this agent to the Treasury app. Connect it, then try again.",
  signature_invalid: "The signature didn't verify as the owner's, with a full-access key, for the platform. Nothing was relayed. Sign again.",
  invalidated: "The policy, the strategy or the agent changed since it was proposed, so it can't run. Nothing was relayed.",
  withdrawn: "It was withdrawn: the consent it was made under has ended. Nothing was relayed.",
  policy_not_in_force: "The policy this proposal was quoted under isn't in force. Nothing was relayed. Fix the policy first.",
  rate_limited: "Too many requests from this account. Wait a minute, then try again.",
};

/** A failure in words for the owner, from its kind and code only. */
export function failureText(failure: Failure, context: Context): string {
  switch (failure.kind) {
    case "not_signed_in": return "You're not signed in, or your session has ended. Sign in again.";
    case "not_owner": return "The signed-in account doesn't own this agent, or there's no such agent.";
    case "unavailable": return context === "read"
      ? "The Treasury server or the platform didn't answer. Reading again is safe."
      : "The Treasury server or the platform didn't answer. Read the current state before trying again.";
    case "lost": return context === "read"
      ? "The answer was lost or couldn't be read. Reading again is safe."
      : "The answer was lost, so the outcome isn't known. Read the current state before trying again.";
    case "refused": {
      const table = context === "sign-in" ? SIGN_IN : context === "consent" ? CONSENT : context === "proposal" ? PROPOSAL : {};
      return table[failure.code] ?? DAO[failure.code] ?? PROPOSAL[failure.code] ?? `The server refused the request (${failure.code}).`;
    }
  }
}

export const STATE_WORDS: Record<ProposalState, string> = {
  proposed: "Awaiting your decision",
  approved: "Approved",
  executing: "Executing",
  executed: "Executed",
  stopped: "Stopped",
  unknown: "Outcome unknown",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  expired: "Expired",
  invalidated: "Invalidated",
};

/** A final proposal's outcome, decided by `settle` from what it reports. */
export function outcomeText(outcome: Outcome, state: ProposalState): string {
  if (outcome.ok) return "Executed. Every swap succeeded.";
  if (outcome.kind === "partial") return "At least one swap went out, and not every one succeeded. Funds may have moved: review the operations below before acting again.";
  if (outcome.kind === "unknown") return "The outcome isn't known yet: a swap may have gone out. Nothing is sent again from here; read it again later.";
  const reason = outcome.kind === "refused" && outcome.error ? `: ${outcome.error}` : ".";
  return `${STATE_WORDS[state]}. Nothing was sent${reason}`;
}

/** Why `not_executable` holds a proposal: the platform's causes, since the server forwards no message. */
export const NOT_EXECUTABLE = "Nothing was sent, and the proposal is still approved. The platform refused to start it before claiming it: a price below a signed floor, a provider warning, a short balance, no live treasury grant, or the policy not in force. You can execute it again later.";

export const PENDING = "The outcome isn't known yet: the execution may still be running, or its answer was lost. Nothing is sent again from here.";
