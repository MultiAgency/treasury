import { proposalText, type ProposalState, type ProposalView } from "@multiagency/sdk";

export type Verdict = "approve" | "reject";

/**
 * Whether the owner's signed verdict may be relayed: the proposal, read anew from the platform, is still open and
 * unexpired, and the text is exactly `proposalText` of it for that verdict. The page signs the text of the proposal it
 * shows, so a proposal whose terms changed since, or a text for anything else, is refused before the platform sees it.
 */
export function checkVerdict(message: string, fresh: ProposalView, verdict: Verdict, now = Date.now()):
  { ok: true } | { ok: false; code: "not_open" | "expired" | "not_this_text" } {
  const open = checkOpen(fresh, now);
  if (!open.ok) return open;
  if (message !== proposalText(fresh, verdict)) return { ok: false, code: "not_this_text" };
  return { ok: true };
}

/**
 * Whether a proposal, read anew, may still get a verdict: open and unexpired. A DAO's vote is filed only then, since a
 * vote must pass before the proposal's `expiresAt`; the platform files it from the proposal's own text.
 */
export function checkOpen(fresh: ProposalView, now = Date.now()): { ok: true } | { ok: false; code: "not_open" | "expired" } {
  // The platform reports a waiting proposal `expired` once its time passes; either way, that's what the owner is told.
  if (fresh.state === "expired" || Date.parse(fresh.expiresAt) <= now) return { ok: false, code: "expired" };
  if (fresh.state !== "proposed") return { ok: false, code: "not_open" };
  return { ok: true };
}

/** The states that end a proposal: nothing more will happen to it. */
const FINAL: readonly ProposalState[] = ["executed", "stopped", "invalidated", "expired", "rejected", "withdrawn"];

/**
 * What an execute answer means for the page. `final`: the proposal ended (a `stopped` one may still have run a swap:
 * show its operations). `pending`: it may still run, or the answer was lost while it read `approved`, since the
 * platform marks it `executing` only after quoting. Offer no Execute then; read it again later. The platform claims a
 * proposal once, so an Execute offered again once it reads `approved` later can't run it twice.
 */
export const outcomeOf = (state: ProposalState): "final" | "pending" => FINAL.includes(state) ? "final" : "pending";
