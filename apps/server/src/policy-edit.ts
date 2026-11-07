// Whether a policy edit changes anything (#134): an edit that would leave the policy as it is is refused before anything is
// prepared, so no signature or DAO vote is asked for it. Pure, so it's tested without a platform.
// With its extension: test/policy-edit.test.ts loads this module under Node, which resolves only explicit `.ts` paths.

type Caps = Partial<Record<string, Record<string, string> | undefined>>;
type Policy = {
  actions: readonly string[]; assets: "any" | readonly string[]; owner_approval: boolean; max_actions_per_hour: number | null;
  budget: Partial<Record<"daily_usd" | "weekly_usd" | "monthly_usd", string | null>>; limits?: { [window: string]: unknown };
};
type Changes = {
  swap?: boolean | undefined; assets?: "any" | readonly string[] | undefined; owner_approval?: boolean | undefined; max_actions_per_hour?: number | null | undefined;
  budget?: Partial<Record<"daily_usd" | "weekly_usd" | "monthly_usd", string | null>> | undefined; limits?: Caps | undefined;
  destinations?: unknown; withdrawals?: unknown;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (assets: "any" | readonly string[]) => assets === "any" ? assets : [...assets].sort();

/**
 * True when every field the edit names already has that value. Destinations and withdrawals are not compared (the
 * platform holds their canonical form), so an edit naming either is taken to change something.
 */
export function changesNothing(policy: Policy, changes: Changes): boolean {
  if (changes.destinations !== undefined || changes.withdrawals !== undefined) return false;
  if (changes.swap !== undefined && changes.swap !== policy.actions.includes("swap")) return false;
  if (changes.assets !== undefined && !same(sorted(changes.assets), sorted(policy.assets))) return false;
  if (changes.owner_approval !== undefined && changes.owner_approval !== policy.owner_approval) return false;
  if (changes.max_actions_per_hour !== undefined && changes.max_actions_per_hour !== policy.max_actions_per_hour) return false;
  for (const [key, value] of Object.entries(changes.budget ?? {}))
    if (value !== (policy.budget[key as keyof Policy["budget"]] ?? null)) return false;
  if (changes.limits !== undefined)
    for (const window of new Set([...Object.keys(changes.limits), ...Object.keys(policy.limits ?? {})]))
      if (!same(Object.entries(changes.limits[window] ?? {}).sort(), Object.entries((policy.limits?.[window] ?? {}) as Record<string, string>).sort())) return false;
  return true;
}
