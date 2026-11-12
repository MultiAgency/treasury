// The funding cells of "Where the agent stands" on Home (#258): whether the agent holds anything, and whether a funding
// account is linked. Pure, so it is tested without a browser. With its extension: test/standing-view.test.ts loads this
// module under Node, which resolves only explicit `.ts` paths.

type Holding = { public: string; confidential: string; usd: number | null };

/** Whether the agent holds any of a managed asset, publicly or confidentially. Unmanaged assets don't count: the strategy can't use them. */
export const isFunded = (book: readonly Pick<Holding, "public" | "confidential">[]): boolean =>
  book.some(holding => BigInt(holding.public) > 0n || BigInt(holding.confidential) > 0n);

/** What the funding cell says. With no price on a holding the total is left out, never shown as zero. */
export function fundedStatus(book: readonly Holding[]): { funded: boolean; detail: string } {
  if (!isFunded(book)) return { funded: false, detail: "The agent holds nothing yet. Fund it to let the strategy run." };
  const priced = book.every(holding => holding.usd !== null);
  const total = book.reduce((sum, holding) => sum + (holding.usd ?? 0), 0);
  return { funded: true, detail: priced ? `Holds about ${total.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })}` : "Holds managed assets" };
}

/** The funding account cell exists for a wallet owner only: a DAO's funding account is the DAO, fixed at setup. */
export const showsFundingAccount = (signer: "wallet" | "dao"): boolean => signer === "wallet";
