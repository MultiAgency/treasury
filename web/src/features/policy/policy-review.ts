import type { ReviewedPolicy } from "../../../../src/mandate";
import type { Overview } from "../../shared/lib";

/** Identify the reviewed policy. Owners may edit a frozen policy; sending still needs authorization. */
export function reviewedPolicyOf(data: Overview): ReviewedPolicy | undefined {
  const revision = data.policy.revision;
  return data.policy.policy && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 && data.digest
    ? { revision, digest: data.digest } : undefined;
}

export function sameReviewedPolicy(a?: ReviewedPolicy, b?: ReviewedPolicy) {
  return Boolean(a && b && a.revision === b.revision && a.digest === b.digest);
}
