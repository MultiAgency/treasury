import { canonicalJson } from "./chain.ts";
import type { Access, DaoTransactions, MemberTransaction } from "./contract.ts";
import type { DaoProposal, Policy, ProposalsFrom } from "./dao.ts";

/** What the server keeps of a filed DAO request to show it again: the platform answers its transactions only once. */
export type Filed = {
  dao: string;
  /**
   * The DAO's next proposal number, read before filing: a proposal filed for this request has this number or a later
   * one, so the DAO's proposals are searched from it.
   */
  next: number;
  transactions: DaoTransactions;
};

/** The proposal number a file-and-vote transaction votes on: its `act_proposal`'s `id`, as the platform wrote it. */
const votesOn = (transaction: MemberTransaction) =>
  (transaction.actions.find(action => action.params.methodName === "act_proposal")?.params.args as { id?: unknown } | undefined)?.id;

/** Where members vote on a DAO's proposal: Trezu, which shows any Sputnik DAO's proposals (treasury#100). */
export const voteLink = (dao: string, proposal: number) => `https://trezu.app/${dao}/requests/${proposal}`;

/**
 * What a member is offered for a DAO request still waiting for its vote, by what the DAO holds (treasury#100, "A
 * request waiting for its vote"):
 * - `filed`: a matching proposal is open; vote on it in Trezu, and file nothing;
 * - `approved`: it passed; the server's next read of the request completes it;
 * - `failed`: its call failed when executed; a member who may finalize runs it again in Trezu;
 * - `ended`: the DAO rejected it, or it expired; a new request is filed only if a member asks;
 * - `file`: none is filed; the stored transaction a member may file, or null for a member who may not file.
 */
export type Offer =
  | { state: "filed" | "approved" | "failed"; proposal: number; vote: string }
  | { state: "ended"; proposal: number; vote: string; outcome: "Rejected" | "Expired" | "Moved" }
  | { state: "file"; transaction: MemberTransaction | null };

/** The kind of proposal `filed` asks the DAO for: a `FunctionCall` to `v1.signer` signing the request's hash. */
const kindOf = (filed: Filed) => canonicalJson((filed.transactions.proposal.actions[0]!.params.args as { proposal: { kind: unknown } }).proposal.kind);

/**
 * The offer for `filed`, from the DAO's proposals numbered `filed.next` or later. A proposal counts only if its kind is
 * exactly the one filed: never by its description, which any proposer writes. An open proposal past its period counts as
 * expired, since Sputnik marks it only when someone acts on it. Of several matches, the one that can still complete
 * the request decides: open, then approved, then failed, then the latest ended one.
 */
export function offerFor(filed: Filed, read: ProposalsFrom, policy: Policy, access: Access, nowMs: number): Offer {
  const kind = kindOf(filed);
  const deadline = (proposal: DaoProposal) => BigInt(proposal.submission_time) + BigInt(policy.proposal_period);
  const now = BigInt(nowMs) * 1_000_000n;
  const status = (proposal: DaoProposal) => proposal.status === "InProgress" && deadline(proposal) < now ? "Expired" : proposal.status;
  const matching = read.proposals.filter(proposal => proposal.id >= filed.next && canonicalJson(proposal.kind) === kind);
  for (const wanted of ["InProgress", "Approved", "Failed"] as const) {
    const found = matching.find(proposal => status(proposal) === wanted);
    if (found) return { state: wanted === "InProgress" ? "filed" : wanted === "Approved" ? "approved" : "failed", proposal: found.id, vote: voteLink(filed.dao, found.id) };
  }
  const ended = matching.filter(proposal => ["Rejected", "Expired", "Moved"].includes(status(proposal))).at(-1);
  if (ended) return { state: "ended", proposal: ended.id, vote: voteLink(filed.dao, ended.id), outcome: status(ended) as "Rejected" | "Expired" | "Moved" };
  if (!access.canPropose) return { state: "file", transaction: null };
  // The stored vote names the proposal number the platform read when it filed: the DAO refuses it whole unless that's
  // still the number its next proposal gets.
  const voteFits = access.canVote && filed.transactions.proposalAndVote !== null && votesOn(filed.transactions.proposalAndVote) === read.next;
  return { state: "file", transaction: voteFits ? filed.transactions.proposalAndVote : filed.transactions.proposal };
}
