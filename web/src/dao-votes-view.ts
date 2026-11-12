// Who has approved a DAO's proposal for a request, beside the threshold the platform reads (#262). Pure, so it is tested
// without a browser. With its extension: test/dao-votes-view.test.ts loads this module under Node.
//
// The threshold is never worked out here: Sputnik's rules (roles, ratios, weights) are the platform's to apply, and the
// treasury read carries its answer as `dao.approvers`, one `{ role, threshold }` each, the threshold as text (such as
// "1/2 of the role"), not a count: no "2 of 3" can be made from it, so none is shown. It is quoted as given.

export type Approver = { role: string; threshold: string };

/** Who approved, then each role's threshold as the platform states it: "Approved by a.near, b.near · council: 1/2 of the role". Null until the DAO's proposal is filed. */
export function votesText(approvedBy: readonly string[] | undefined, approvers: readonly Approver[] | undefined): string | null {
  if (approvedBy === undefined) return null;
  const who = approvedBy.length === 0 ? "No approvals yet" : `Approved by ${approvedBy.join(", ")}`;
  return [who, ...(approvers ?? []).map(({ role, threshold }) => `${role}: ${threshold}`)].join(" · ");
}
