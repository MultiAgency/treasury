// Who has approved a DAO's proposal for a request, against the threshold the platform reads (#262). Pure, so it is tested
// without a browser. With its extension: test/dao-votes-view.test.ts loads this module under Node.
//
// The threshold is never worked out here: Sputnik's rules (roles, ratios, weights) are the platform's to apply, and the
// treasury read carries its answer as `dao.approvers`, one `{ role, threshold }` each. It is quoted as given.

export type Approver = { role: string; threshold: string };

/** The approvals so far, who gave them, and the DAO's threshold as the platform states it; each part left out when not known. */
export function votesText(approvedBy: readonly string[] | undefined, approvers: readonly Approver[] | undefined): string | null {
  if (approvedBy === undefined) return null;
  const who = approvedBy.length === 0 ? "No member has approved yet" : `${approvedBy.length} approved: ${approvedBy.join(", ")}`;
  const needed = approvers && approvers.length > 0 ? `. Needed: ${approvers.map(({ role, threshold }) => `${threshold} (${role})`).join("; ")}` : "";
  return `${who}${needed}`;
}
