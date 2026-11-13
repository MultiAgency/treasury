// Which way of putting money in the Funding page leads with (#261), the rest going under "Other ways". Pure, so it is
// tested without a browser. With its extension: test/funding-view.test.ts loads this module under Node.

/**
 * - `confidential`: a confidential DAO pays from its confidential balance first.
 * - `account`: a linked funding account sends to the agent ("Money in"); for a DAO that files the Trezu proposal.
 * - `link`: no account is linked and the owner may link one, so linking comes first.
 * - `receive`: no account is linked and none can be (a DAO's is fixed at setup, or the connection can't link): the one-time deposit address.
 * Shielding is not a way in, so it is never offered here.
 */
export type Lead = "confidential" | "account" | "link" | "receive";

export function leadWay({ linked, confidential, canLink }: { linked: boolean; confidential: boolean; canLink: boolean }): Lead {
  if (linked) return confidential ? "confidential" : "account";
  return canLink ? "link" : "receive";
}

/** The lead card's title. Until the funding account is read the lead isn't known (`undefined`), so the title is the neutral one: never "Link" to an owner who may have one linked. */
export const leadTitle = (lead: Lead | undefined): string => lead === "link" ? "Link a funding account" : lead === "receive" ? "Receive funds" : "Money in";

/** Whether the one-time deposit address is the lead, and so isn't also listed under "Other ways". */
export const receiveIsOther = (lead: Lead): boolean => lead !== "receive";

/** Whether a confidential DAO's public balance is a way in, listed under "Other ways" (it is only for a confidential DAO). */
export const publicIsOther = (lead: Lead): boolean => lead === "confidential";
