import type { ProposalState } from "@multiagency/sdk";
import type { Outcome } from "../shared/execution-outcome.ts";
import type { Failure } from "./proposals-api.ts";
import type { PhaseWords } from "../../../apps/server/src/owner-action.ts";

/** Where a failure happened: the same code reads differently for a sign-in and a proposal (`expired`). */
export type Context = "read" | "sign-in" | "setup" | "consent" | "proposal" | "funding" | "autopilot" | "owner-action";

const SIGN_IN: Record<string, string> = {
  rate_limited: "Too many sign-in attempts from this address. Wait a minute, then sign in again.",
  not_full_access: "That key isn't a full-access key of the account on chain. Sign in with a full-access key.",
  bad_signature: "The signature didn't verify for this server. Sign in again.",
  expired: "The sign-in text expired before it was signed. Sign in again.",
  unknown_challenge: "That sign-in text was already used, or this server didn't issue it. Sign in again.",
};
const SETUP: Record<string, string> = {
  not_this_setup: "The signed text isn't the setup this server asks for now. Nothing was set up. Start again.",
  already_set_up: "This Treasury is already set up, or this host can't set one up now. A Treasury already set up shows under your treasuries.",
  setup_unavailable: "This host doesn't set up Treasury agents.",
  setup_refused: "The platform didn't accept the setup. Nothing was set up.",
  owner_stopped: "Your wallet stopped app access after this text was prepared, so the platform can't tell it was signed after the stop. Nothing was set up. Review the new text and sign again.",
  not_set_up: "The setup this agent was reserved with has lapsed: it's good for an hour. Set it up again, then create it.",
  already_created: "This agent is already created.",
  creation_refused: "The platform refused the creation. Nothing was prepared. If one is already waiting for a signature or a vote, sign that one, or wait for it to expire, in minutes.",
  no_creation: "The platform has no record of that creation. Create the agent again.",
  not_a_dao: "The platform doesn't read that account as a DAO. A wallet owner sets up their own Treasury.",
  not_permitted: "Your roles in the DAO don't allow this: a member who may file proposals does.",
  rate_limited: "Too many requests from this account. Wait a minute and try again; after several setups today, setting up again waits until tomorrow.",
};
const CONSENT: Record<string, string> = {
  not_created: "This agent hasn't been created yet, so it can't be connected.",
  already_connected: "This agent is already connected.",
  agent_changed: "The agent changed since this text was prepared. Nothing was stored. Review the new text and sign again.",
  not_this_consent: "The signed text isn't the consent this server asks for now. Nothing was stored. Connect again.",
  consent_refused: "The platform didn't accept the consent. Nothing was stored.",
  owner_stopped: "The owner's wallet stopped app access after this text was prepared, so the platform can't tell it was signed after the stop. Nothing was stored. Review the new text and sign again.",
  autopilot_not_stopped: "Autopilot couldn't be turned off, so nothing was disconnected: once disconnected, this page couldn't turn it off. Try again.",
  // The same code for the owner routes' per-minute limit and the daily limit on new consents.
  rate_limited: "Too many requests from this account. Wait a minute and try again; if it has connected agents several times today, connecting again waits until tomorrow.",
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
  nothing_to_propose: "The strategy picks no swap worth its cost now. Nothing was proposed.",
  too_many_proposals: "This agent already has as many open proposals as it may. Approve, reject or wait for some, then ask again.",
  not_proposable: "The platform can't propose a rebalance for this agent now: check its strategy and policy. Nothing was proposed.",
  request_conflict: "That request was already used for another proposal. Nothing was proposed. Ask again.",
  move_not_available: "That hedge move isn't available any more: the platform's list, a fresh NEAR Intents quote or a cap no longer allows it. Nothing was proposed. Read the plan again.",
};

/** The owner actions the frame offers (#133): a freeze, an unfreeze. */
const OWNER_ACTION: Record<string, string> = {
  action_pending: "An earlier owner action of this kind is already waiting for its vote or its outcome. Follow it rather than sending another: nothing new was prepared.",
  no_change: "That edit leaves the policy as it is, so nothing was prepared.",
  owner_not_allowed: "Your connection doesn't allow owner actions. Allow them in Connection, on the agent's Home page, first. Nothing was sent.",
  action_refused: "The platform refused it, so nothing took effect. It may already be in the state you asked for: read the agent's state again.",
  no_action: "The platform has no record of that action.",
  not_connected: "The agent isn't connected to this app: connect it first. Nothing was sent.",
};
const AUTOPILOT: Record<string, string> = {
  strategy_changed: "The saved strategy changed since you saw it. Nothing was changed. Review it again.",
  strategy_refused: "The platform refused that strategy. Nothing was saved.",
  no_proposal: "That proposal was already adopted, declined or replaced. Nothing was changed.",
  autopilot_on: "Turn autopilot off before authorizing a strategy. Nothing was prepared.",
  approve_only: "This host only approves: strategies are authorized on the agent's executor. Nothing was prepared.",
  grant_pending: "A grant is already waiting for its signature, vote or outcome. Follow it rather than signing another.",
  owner_not_allowed: "Your connection doesn't allow owner actions. Allow them in Connection first, then authorize the strategy.",
  grant_refused: "The platform refused the grant. Nothing took effect.",
  no_grant: "The platform has no record of that grant. Authorize the strategy again.",
  autopilot_refused: "The agent refused: read the strategy's readiness below. If the saved strategy changed since you saw it, review it again.",
  not_permitted: "Your roles don't allow this: autopilot and Run now need a member who may both file and vote on proposals.",
};
const FUNDING: Record<string, string> = {
  funding_refused: "The platform didn't accept that change to the funding account. Nothing changed. Check the account exists, then try again.",
  not_permitted: "Your roles don't allow this. A DAO agent's funding account is the DAO itself, and a deposit address is asked for by a member who may file proposals.",
};

/** A failure in words for the owner, from its kind and code only. */
/** Codes that read the same in every context. */
const ANY: Record<string, string> = {
  platform_rate_limited: "The platform is limiting this app's requests for now. Nothing was done; try again in a few minutes.",
  too_many_tokens: "This agent already has as many access tokens as it may. Revoke one you no longer use, then create another.",
  no_token: "That token has already ended, so there is nothing to revoke.",
};

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
      const table = context === "sign-in" ? SIGN_IN : context === "setup" ? SETUP : context === "consent" ? CONSENT : context === "proposal" ? PROPOSAL : context === "funding" ? FUNDING : context === "autopilot" ? AUTOPILOT : context === "owner-action" ? OWNER_ACTION : {};
      return table[failure.code] ?? ANY[failure.code] ?? PROPOSAL[failure.code] ?? `The server refused the request (${failure.code}).`;
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

/** The scopes of a connection in a fixed order (read, treasury, owner, then any other), as "read, treasury and owner". */
const SCOPE_ORDER = ["read", "treasury", "owner"];
export const scopeList = (scopes: readonly string[]) => [...scopes]
  .sort((a, b) => (SCOPE_ORDER.indexOf(a) + 1 || 99) - (SCOPE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
  .join(", ").replace(/, ([^,]*)$/, " and $1");

/** What has happened to a grant's revocation, by its phase and outcome. */
export const revokeWords: PhaseWords = {
  open: "Waiting for the signature, or for the DAO's vote.",
  submitted: "Signed; the platform is submitting it.",
  settled: "Done: the platform has the revocation, and the grant no longer acts.",
  expired: "It expired before it was signed or voted on. The grant is still live.",
  failed: "The platform couldn't carry it out. The grant is still live.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
  unconfirmed: "The revocation ended without a confirmed outcome. Read the grant's current state before acting again.",
};

/** Grant and creation progress use the same outcome checks as the controls that allow another attempt. */
export const grantWords: PhaseWords = {
  open: "Waiting for the signature, or for the DAO's vote.",
  submitted: "Signed; the platform is submitting it.",
  settled: "Authorized: the grant binds this strategy once the agent takes it up.",
  expired: "It expired before it was signed. Nothing took effect. Authorize the strategy again.",
  failed: "The platform couldn't issue the grant. Nothing took effect.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
  unconfirmed: "The grant ended without a confirmed outcome. Read the saved strategy before authorizing it again.",
};

export const creationWords: PhaseWords = {
  open: "Waiting for the signature.",
  submitted: "Signed; the platform is submitting it.",
  settled: "Created. Reading the agent again…",
  expired: "It expired before it was signed. Nothing was created.",
  failed: "The platform couldn't create it. Nothing was created.",
  unknown: "Its outcome isn't known yet. Nothing is sent again from here.",
  unconfirmed: "The creation ended without a confirmed outcome. Read the agent's current state before creating it again.",
};
