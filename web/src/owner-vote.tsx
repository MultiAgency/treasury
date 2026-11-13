import { useQuery } from "@tanstack/react-query";
import { DaoOfferView } from "./dao-request";
import type { agentReads } from "./queries";

type Reads = ReturnType<typeof agentReads>;
const ENDED = { Rejected: "was rejected", Expired: "expired without passing", Moved: "was moved to another DAO" } as const;

/**
 * The DAO's vote on an owner action (a freeze, a grant, a revocation, a policy edit, a creation), for every member: the
 * DAO's proposal and where to vote on it, who has approved, and how it ended if it didn't pass, so the members whose
 * votes it needs can find it within its minutes. Shown beside the action's own status, which says when it takes effect.
 * `mayFile`: this page didn't prepare the action (it was prepared before a reload, or by another member), so an unfiled
 * one is offered for filing here, from the DAO's own record of what is filed; the page that prepared it files its own.
 * Nothing is shown when the server keeps no filing for it. The role thresholds come from the treasury read if a page
 * already made it: it isn't read for this.
 */
export function OwnerActionVote({ reads, account, correlationId, mayFile }: { reads: Reads; account: string; correlationId: string; mayFile: boolean }) {
  const vote = useQuery(reads.ownerVote(correlationId));
  const treasury = useQuery({ ...reads.treasury, enabled: false });
  const read = vote.data;
  if (!read) return null;
  if (read.ended) return <p role="alert" className="text-sm">The DAO's proposal #{read.ended.proposal} {ENDED[read.ended.outcome]}, so this doesn't take effect.{" "}
    <a className="underline" href={read.ended.vote}>See it in Trezu</a>. Ask again if it is still wanted.</p>;
  return <div className="flex flex-col items-start gap-2 text-sm">
    <DaoOfferView offer={read.offer} approvedBy={read.approvedBy} approvers={treasury.data?.dao?.approvers} account={account} onChanged={() => void vote.refetch()}
      approved="Its status here says when it takes effect." mayFile={mayFile} />
  </div>;
}
