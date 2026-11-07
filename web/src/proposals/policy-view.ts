// The policy as the Policy page shows it (#134): the terms as signed, the limits beside what is reported left, and the
// words for what a DAO's vote has. Pure, so it's tested without a browser.
// With their extensions: test/policy-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { amountOf, symbolOf, usd, type AssetInfo } from "../shared/format.ts";
import { BUDGET, WINDOWS, type AgentPolicy } from "./policy-draft.ts";

/** What an empty destination list means in each mode. */
export const destinationsText = ({ mode, list }: AgentPolicy["destinations"]) => {
  const addresses = list.map(destination => destination.address).join(", ");
  if (mode === "only") return addresses ? `Only ${addresses}` : "No external destinations allowed by this policy.";
  if (mode === "except") return addresses ? `Any destination except ${addresses}` : "Any destination (no exceptions)";
  return "Any destination";
};

/** The policy as signed, one term per row. Terms first; the page says each caveat once, not on every row. */
export function termRows(policy: AgentPolicy, book: readonly AssetInfo[]): [string, string][] {
  const caps = (window: (typeof WINDOWS)[number][0]) =>
    Object.entries(policy.limits?.[window] ?? {}).map(([asset, raw]) => amountOf(raw, asset, book)).join(" · ") || "None";
  const budget = BUDGET.flatMap(([key, label]) => policy.budget[key] ? [`${usd(policy.budget[key])} ${label}`] : []).join(" · ");
  return [
    ["Actions", policy.actions.join(", ") || "None"],
    ["Assets", policy.assets === "any" ? "Any" : policy.assets.map(asset => symbolOf(asset, book)).join(", ") || "None"],
    ["Owner approval", policy.owner_approval ? "Every payment" : "Not required inside the policy"],
    ...WINDOWS.map(([window, label]): [string, string] => [`Caps ${label.toLowerCase()}`, caps(window)]),
    ["USD budget", budget || "None"],
    ["Destinations", destinationsText(policy.destinations)],
    ["Rate", policy.max_actions_per_hour ? `${policy.max_actions_per_hour} actions an hour` : "No cap"],
    ["Confidential", policy.confidential ? "Enabled" : "Disabled"],
  ];
}

export type BudgetRow = { period: "daily" | "weekly" | "monthly"; label: string; signed: string; left: string };
const PERIODS = [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const;
type Usage = Partial<Record<"daily" | "weekly" | "monthly", { limit_usd: string | null; remaining_usd: string | null } | undefined>>;

/** The USD budget's windows: the signed limit, and what the platform reports left (unavailable is said, never guessed). */
export function budgetRows(policy: AgentPolicy | null, usage: Usage): BudgetRow[] {
  return PERIODS.map(([period, label]) => {
    const signed = policy?.budget?.[`${period}_usd`];
    const reported = usage[period];
    return { period, label,
      signed: signed === undefined ? "Not reported" : signed === null ? "No limit" : usd(signed),
      left: reported?.limit_usd === null ? "No limit" : reported?.remaining_usd == null ? "Unavailable" : usd(reported.remaining_usd) };
  });
}

/** The seconds a DAO's vote has, by what the edit changes (platform#20): off-chain fields, or on-chain ones. */
export const DAO_VOTE_SECONDS = { offChain: 290, onChain: 600 } as const;
export const daoVoteWords = () => `about ${DAO_VOTE_SECONDS.offChain} seconds, or ${DAO_VOTE_SECONDS.onChain} seconds for an edit that changes an on-chain field`;

/** A grant's or revision's date in the page's format. */
export const dateText = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** The terms a DAO member compares before filing: each field that differs between `current` and `requested`, as text. */
export function policyComparison(current: Record<string, unknown>, requested: Record<string, unknown>): { field: string; was: string; now: string }[] {
  const show = (value: unknown) => value === undefined ? "none" : typeof value === "string" ? value : JSON.stringify(value);
  return [...new Set([...Object.keys(current), ...Object.keys(requested)])].sort()
    .filter(field => JSON.stringify(current[field]) !== JSON.stringify(requested[field]))
    .map(field => ({ field, was: show(current[field]), now: show(requested[field]) }));
}
