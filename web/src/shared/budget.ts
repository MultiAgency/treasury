import { bindingWindow } from "../../../src/budget-window.js";

export const PERIOD = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const;

/** The Overview's budget figure: the window that refuses first, by the one rule the server plans with too. */
export const bindingBudget = <W extends { limit_usd: string | null; remaining_usd: string | null }>(data: {
  policy: { usage: { budget: Record<keyof typeof PERIOD, W> } };
}) => bindingWindow(data.policy.usage.budget);
