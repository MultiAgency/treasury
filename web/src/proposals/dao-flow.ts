/**
 * A DAO-owned agent's rules on the proposals page, apart from React so they're tested where they live:
 * - a member files only the transaction the platform answered, after reading its description and check link;
 * - a request is never filed again because an answer was lost: it's read by its state, which the server follows.
 */
import type { TransactionOutcome } from "../app/wallet-transaction.ts";
import type { DaoConsent, DaoRequest, DaoVote, Identity } from "./proposals-api.ts";

/**
 * Whether the check link is the platform's own page for this request: `https://<platform host>/confirm/dao/<hash>`.
 * Anything else isn't offered as a link: the member must be able to trust that it recomputes the hash the DAO signs.
 */
export const checkLinkOf = (request: DaoRequest, host: string) =>
  request.checkUrl === `https://${host}/confirm/dao/${encodeURIComponent(request.hash)}` ? request.checkUrl : null;

/** States after which nothing is open: a member who may propose can ask again, for a new vote. */
export const askable = (state: (DaoConsent | DaoVote)["state"]) => state === "none" || state === "expired" || state === "ended" || state === "gone";

/** Why a request ended, in words, or null for one still open or done. */
export function endedText(state: (DaoConsent | DaoVote)["state"]): string | null {
  switch (state) {
    case "expired": return "The DAO's vote didn't pass in time. You can ask again, for a new vote.";
    case "ended": return "The DAO stopped this agent, which ended the request. You can ask again, for a new vote.";
    case "gone": return "The platform no longer has that request. You can ask again, for a new vote.";
    default: return null;
  }
}

/**
 * What a wallet's answer to filing means. Only a failure proves nothing was filed, so only then is filing offered again;
 * after an unknown answer the member checks the DAO's proposals first: a second filing is a second proposal (and bond).
 */
export function filedOutcome(outcome: TransactionOutcome): { tone: "status" | "alert"; text: string; fileAgain: boolean } {
  switch (outcome.kind) {
    case "succeeded": return { tone: "status", text: "Filed with the DAO. Once its vote passes, check the vote here: reading it is what completes it.", fileAgain: false };
    case "failed": return { tone: "alert", text: "The DAO refused the transaction, so nothing was filed. Your roles may not allow it, or the bond was short.", fileAgain: true };
    case "unknown": return { tone: "alert", text: "The wallet didn't say whether it was filed. Check the DAO's proposals before filing again: a second filing is a second proposal.", fileAgain: false };
  }
}

/** Who the signed-in account is to this agent, in words. */
export const memberText = (identity: Identity) => identity.signer === "dao"
  ? `You're signed in as a member of ${identity.owner}, the DAO that owns this agent.`
  : `Signed in as ${identity.owner}`;
