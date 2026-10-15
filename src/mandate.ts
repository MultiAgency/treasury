import { createHash } from "node:crypto";
import type { Policy } from "@near-intents-agent-api/sdk";

/** The exact policy observation an operator or owner reviewed before confirming an action. */
export type ReviewedPolicy = { revision: number; digest: string };

/**
 * The owner's mandate as one reproducible digest: an audit identifier, not a commitment the owner's
 * signature is shown to cover. The API's `agent_policy_hash` can't serve: it isn't the sha256 of the
 * policy JSON, the public `outlayer.near` `store_wallet_policy` takes no such argument, and the policy
 * is stored encrypted to the custody keystore, so no one outside it can check what is enforced.
 *
 * Canonical form: object keys sorted, no whitespace, and every array whose order carries no meaning
 * sorted by its entries' canonical form. A policy holds only strings, booleans, integers and null, so
 * for policies this is RFC 8785 (JCS) output: anyone can recompute the digest from the policy JSON.
 */

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`A policy number must be an integer, not ${value}`);
  return JSON.stringify(value);
};

const asSet = <T>(list: readonly T[]) => [...list].sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));

export function canonicalPolicy(policy: Policy): string {
  return canonical({
    ...policy,
    actions: asSet(policy.actions),
    assets: policy.assets === "any" ? "any" : asSet(policy.assets),
    destinations: { ...policy.destinations, list: asSet(policy.destinations.list) },
    ...(policy.schedule && {
      schedule: { ...policy.schedule, windows: asSet(policy.schedule.windows.map((w) => ({ ...w, days: asSet(w.days) }))) },
    }),
    ...(policy.sign && { sign: { ...policy.sign, recipients: asSet(policy.sign.recipients) } }),
  });
}

export const mandateDigest = (policy: Policy) =>
  `sha256:${createHash("sha256").update(canonicalPolicy(policy), "utf8").digest("hex")}`;
