import type { TransactionOutcome } from "../app/wallet-transaction.ts";

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
