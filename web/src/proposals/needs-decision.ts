// What needs the owner at the agent's home (#130), from reads the page already makes: pure, so it's tested without a
// browser. With its extensions: test/needs-decision.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import type { ProposalView } from "@multiagency/sdk";
import { legText } from "./terms.ts";

/** What an item asks of the owner, and where it leads (the page decides the link). */
export type Need = {
  key: string;
  kind: "open-proposal" | "approved-proposal" | "unresolved" | "dao-consent" | "dao-vote";
  /** What is waiting, in words. */
  text: string;
  /** When it lapses (ms since the epoch), or null for an item with no deadline. */
  deadline: number | null;
  /** The ISO time an item happened, for those with no deadline (an unresolved operation). */
  at?: string;
  target: { page: "proposal"; id: string } | { page: "connection" } | { page: "activity" };
};

type DaoWaiting = { id: string; kind: "consent" | "vote"; proposal?: string | undefined; votingUntil: number; verdict?: "approve" | "reject" | undefined };
type Unresolved = { key: string; kind: string; at: string };

const byDeadline = (a: ProposalView, b: ProposalView) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt);
const live = (view: ProposalView, now: number) => Date.parse(view.expiresAt) > now;

/** Proposals waiting for the owner's answer: `proposed` and not expired, soonest deadline first. */
export const openProposals = (proposals: readonly ProposalView[], now: number) =>
  proposals.filter(view => view.state === "proposed" && live(view, now)).sort(byDeadline);

/** Proposals the owner approved that haven't been executed: `approved` and not expired, soonest deadline first. */
export const approvedProposals = (proposals: readonly ProposalView[], now: number) =>
  proposals.filter(view => view.state === "approved" && live(view, now)).sort(byDeadline);

const swaps = (view: ProposalView) => view.legs.map(legText).join("; ");

/**
 * Everything waiting on the owner, soonest deadline first, those with no deadline last: open proposals, approved
 * proposals not executed, the DAO's requests waiting for a vote, and operations without a proven outcome (nothing to sign,
 * but nothing new runs until they're resolved). Held payouts aren't here: they're approved under a scope this app doesn't ask for.
 */
export function needsDecision({ proposals, unresolved, daoRequests, now }: {
  proposals: readonly ProposalView[]; unresolved: readonly Unresolved[]; daoRequests: readonly DaoWaiting[]; now: number;
}): Need[] {
  const items: Need[] = [
    ...openProposals(proposals, now).map((view): Need => ({ key: `proposal-${view.id}`, kind: "open-proposal", text: `Awaiting your decision: ${swaps(view)}`,
      deadline: Date.parse(view.expiresAt), target: { page: "proposal", id: view.id } })),
    ...approvedProposals(proposals, now).map((view): Need => ({ key: `proposal-${view.id}`, kind: "approved-proposal", text: `Approved, not executed yet: ${swaps(view)}`,
      deadline: Date.parse(view.expiresAt), target: { page: "proposal", id: view.id } })),
    ...daoRequests.map((request): Need => request.kind === "consent"
      ? { key: `dao-${request.id}`, kind: "dao-consent", text: "Waiting for the DAO's vote to connect the agent", deadline: request.votingUntil, target: { page: "connection" } }
      : { key: `dao-${request.id}`, kind: "dao-vote", text: `Waiting for the DAO's vote to ${request.verdict ?? "decide"} a proposal`, deadline: request.votingUntil,
        target: { page: "proposal", id: request.proposal ?? "" } }),
    ...unresolved.map((item): Need => ({ key: `unresolved-${item.key}`, kind: "unresolved", at: item.at, deadline: null,
      text: `An operation's outcome isn't proven yet (${item.kind}): nothing new runs until it's resolved, and nothing is sent again from here`, target: { page: "activity" } })),
  ];
  // Deadlines first, soonest first; then the rest, in the order the platform listed them.
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    if (a.item.deadline !== null && b.item.deadline !== null) return a.item.deadline - b.item.deadline || a.index - b.index;
    if (a.item.deadline !== null) return -1;
    if (b.item.deadline !== null) return 1;
    return a.index - b.index;
  }).map(({ item }) => item);
}
