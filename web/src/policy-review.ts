import type { z } from "zod";
import type { policyUpdateRequest } from "../../apps/server/src/contract.ts";
import type { OverviewRead } from "./server-api.ts";

type ReviewedPolicy = z.input<typeof policyUpdateRequest>["expectedPolicy"];

/** Identify the reviewed policy. Owners may edit a frozen policy; sending still needs authorization. */
export function reviewedPolicyOf(data: Pick<OverviewRead, "policy" | "digest">): ReviewedPolicy | undefined {
  const revision = data.policy.revision;
  return data.policy.policy && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 && data.digest
    ? { revision, digest: data.digest } : undefined;
}

export function sameReviewedPolicy(a?: ReviewedPolicy, b?: ReviewedPolicy) {
  return Boolean(a && b && a.revision === b.revision && a.digest === b.digest);
}
