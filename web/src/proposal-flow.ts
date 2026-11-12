/**
 * The app's money path for proposals, apart from React so its rules are tested where they live:
 * - a verdict signs exactly `proposalText` of the proposal as read right before the wallet signs, and is shown first;
 * - an execute is asked for once, and whether Execute is offered again is decided only from a fresh read.
 */
import { proposalText, type ProposalView } from "@multiagency/sdk";
import { settle, type Outcome } from "./shared/execution-outcome.ts";
import { freshNonce, type AgentApi, type ExecuteResult, type Failure, type Result, type SignRequest, type Signed, type Verdict } from "./server-api.ts";

/** Whether the owner may still approve or reject: it's open and its time hasn't passed. */
export const verdictOffered = (view: ProposalView, now = Date.now()) => view.state === "proposed" && Date.parse(view.expiresAt) > now;

/**
 * Whether Execute is offered: only for a proposal a read says is `approved`, and never while an execute's outcome is
 * held unknown (`held`) until a read after it answers. An execute's own answer is never such a read.
 */
export const executeOffered = (view: ProposalView, held: boolean) => view.state === "approved" && !held;

/** The text the owner reviews and signs for `verdict`: the SDK's, byte for byte, from the proposal as read. */
export const verdictText = (view: ProposalView, verdict: Verdict) => proposalText(view, verdict);

/** A proposal read now, as a review starts or before the wallet signs. */
export type Review =
  | { kind: "review"; view: ProposalView; text: string }
  /** Not open any more: nothing to sign. */
  | { kind: "closed"; view: ProposalView }
  | { kind: "failed"; failure: Failure };

/** Reads the proposal and, while it's open, the exact text the owner would sign. */
export async function review(api: AgentApi, id: string, verdict: Verdict, now = Date.now()): Promise<Review> {
  const read = await api.proposal(id);
  if (!read.ok) return { kind: "failed", failure: read };
  const view = read.value.proposal;
  return verdictOffered(view, now) ? { kind: "review", view, text: verdictText(view, verdict) } : { kind: "closed", view };
}

export type VerdictOutcome =
  | Review
  /** The proposal changed since `shown` was reviewed: nothing was signed; show the new text and ask again. */
  | { kind: "changed"; view: ProposalView; text: string }
  /** The wallet signed for another account than the agent's owner: nothing was relayed. */
  | { kind: "wrong_account"; signer: string }
  /** The server relayed the verdict, and the proposal now reads as it answered. */
  | { kind: "done"; view: ProposalView }
  /**
   * Refused or unanswered after signing. `read` is the proposal as read afterwards when the code says nothing was
   * relayed or the answer was lost, so the page decides from it.
   */
  | { kind: "refused"; failure: Failure; read?: Result<{ proposal: ProposalView }> };

/** Refusals after which nothing was relayed and the proposal may have moved on: read it again before anything else. */
const REREAD = new Set(["not_this_text", "not_open", "expired", "invalidated", "withdrawn", "no_proposal"]);

/**
 * Signs and relays the owner's verdict on `shown`, the text they reviewed. The proposal is read once more right before
 * the wallet is asked: if its text is no longer `shown`, nothing is signed and the new text is answered instead.
 */
export async function signVerdict({ api, id, verdict, shown, owner, host, sign, now = Date.now() }: {
  api: AgentApi; id: string; verdict: Verdict; shown: string;
  /** The agent's owner, as the server answered it: the only account whose signature is relayed. */
  owner: string;
  /** The platform's host: the NEP-413 recipient for a proposal's text. */
  host: string;
  sign: (request: SignRequest) => Promise<Signed>;
  now?: number;
}): Promise<VerdictOutcome> {
  const current = await review(api, id, verdict, now);
  if (current.kind !== "review") return current;
  if (current.text !== shown) return { kind: "changed", view: current.view, text: current.text };
  const nonce = freshNonce();
  const signed = await sign({ message: shown, recipient: host, nonce });
  if (signed.accountId !== owner) return { kind: "wrong_account", signer: signed.accountId };
  const answer = await api.verdict(id, verdict, { message: shown, nonce, publicKey: signed.publicKey, signature: signed.signature });
  if (answer.ok) return { kind: "done", view: answer.value.proposal };
  const lost = answer.kind === "lost" || answer.kind === "unavailable";
  if (!lost && !(answer.kind === "refused" && REREAD.has(answer.code))) return { kind: "refused", failure: answer };
  const read = await api.proposal(id);
  // An answer lost after signing: a read showing the verdict means it was recorded, so it's the owner's own.
  if (lost && read.ok && read.value.proposal.state === (verdict === "approve" ? "approved" : "rejected")) return { kind: "done", view: read.value.proposal };
  return { kind: "refused", failure: answer, read };
}

/** What an execute came to, for the page. `view` is the proposal as last known; `held` keeps Execute off until a later read. */
export type Execution =
  | { kind: "final"; view: ProposalView; outcome: Outcome }
  /** The outcome isn't known yet. `read` is the proposal read after it, which alone decides whether Execute returns. */
  | { kind: "pending"; view: ProposalView | null; read: Result<{ proposal: ProposalView }> }
  /** Refused before anything was claimed: nothing was sent, and the server's read after it says it's still approved. */
  | { kind: "not_executable"; view: ProposalView }
  /** Refused before sending; `read` is the proposal read after, when the code says it may have moved on. */
  | { kind: "refused"; failure: Failure; read?: Result<{ proposal: ProposalView }> };

/** Execute's answer as the page decides it: a final proposal by what it reports (`settle`), never by its message. */
function executionOf(result: ExecuteResult): Exclude<Execution, { kind: "pending" | "refused" }> | { kind: "pending"; view: ProposalView | null } {
  switch (result.result) {
    case "final": return { kind: "final", view: result.proposal, outcome: settle({ procedure: "proposal", view: result.proposal }).outcome };
    case "not_executable": return { kind: "not_executable", view: result.proposal };
    case "pending": return { kind: "pending", view: result.proposal };
  }
}

/**
 * Asks for the proposal's execution once. A `pending` answer, or one that was lost or unanswered, is never followed by
 * another execute: the proposal is read, and only that read decides what the page offers next.
 */
export async function execute(api: AgentApi, id: string): Promise<Execution> {
  const answer = await api.execute(id);
  if (answer.ok) {
    const execution = executionOf(answer.value);
    return execution.kind === "pending" ? { ...execution, read: await api.proposal(id) } : execution;
  }
  if (answer.kind === "lost" || answer.kind === "unavailable") return { kind: "pending", view: null, read: await api.proposal(id) };
  const reread = answer.kind === "refused" && answer.code === "not_approved";
  return { kind: "refused", failure: answer, ...(reread && { read: await api.proposal(id) }) };
}

/** Whether Execute is held after `execution`: until a read after it, unless that read came back with it. */
export function heldAfter(execution: Execution) {
  if (execution.kind === "pending") return !execution.read.ok;
  if (execution.kind === "refused") return execution.read !== undefined && !execution.read.ok;
  return false;
}

/**
 * The proposal as the page should now show it after `execution`, or null to keep what it shows: a final or refused
 * answer's own proposal (read by the server after it), else only a read after it. A pending answer's proposal is never
 * shown as current: it may read `approved` while the execution runs.
 */
export function shownAfter(execution: Execution): ProposalView | null {
  if (execution.kind === "final" || execution.kind === "not_executable") return execution.view;
  return execution.read?.ok ? execution.read.value.proposal : null;
}
