import type { TransactionOutcome } from "./wallet-transaction.ts";

type Filing = { actions: readonly { params: { methodName: string } }[] };

/**
 * Whether a member's filing also casts their approval: the platform adds the vote (`act_proposal`) for a member who may
 * vote (`proposalAndVote`, platform `src/dao-owner.ts`). With a one-vote threshold the proposal then passes at once.
 */
export const filesAndVotes = (transaction: Filing) => transaction.actions.some(action => action.params.methodName === "act_proposal");
/** The button that files it, once the transaction is known. */
export const fileLabel = (transaction: Filing) => filesAndVotes(transaction) ? "File and vote" : "File the DAO proposal";
/**
 * What the page says once the wallet sent a filing: whose votes are still needed, by when, and `otherwise`, what happens
 * if they don't come. One that voted may already have passed; its status, read next, says.
 */
export const filedText = (transaction: Filing, until: string, otherwise: string) => filesAndVotes(transaction)
  ? `Filed with your approval. If the DAO needs more votes, they must come by ${until}, ${otherwise}. Its status below says when it passes.`
  : `Filed. The DAO's vote must pass by ${until}, ${otherwise}.`;

/**
 * Whether filing stays held after the member's wallet answered `last`. Only a failure proves nothing was filed. After
 * a success, or an answer that didn't say, the DAO's proposal may not be readable yet (the server reads the DAO's
 * proposals at most a few seconds ago, at final finality), so offering the transaction again would file a second
 * proposal: it stays held until the offer changes, or the page is opened again.
 */
export const filingHeld = (last: TransactionOutcome["kind"] | undefined) => last === "succeeded" || last === "unknown";

/**
 * Why the connected wallet account can't file for `member`, or null when it can: a DAO filing goes out as whichever
 * account the wallet has connected, and the offer shown was built from the signed-in member's roles.
 */
export function signerProblem(connected: string | undefined, member: string): string | null {
  if (!connected) return `No wallet account is connected. Nothing was filed. Connect ${member}.`;
  return connected === member ? null : `Your wallet is connected as ${connected}, but you signed in as ${member}. Nothing was filed. Switch the wallet to ${member}.`;
}
