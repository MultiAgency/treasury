import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { api } from "../src/api.js";
import { bindingWindow } from "../src/budget-window.js";
import { budgetRemaining } from "../src/holdings.js";

/** A plan shows the budget the provider refuses at first: the limited window with the least left. */

const window = (limit: string | null, remaining: string | null) => ({ limit_usd: limit, remaining_usd: remaining, spent_usd: "0", resets_at: null });

test("the window with the least left binds, and an unlimited one never does", () => {
  const budget = { daily: window("25", "4.50"), weekly: window("75", "40"), monthly: window(null, null) };
  assert.equal(bindingWindow(budget)?.period, "daily");
  assert.equal(bindingWindow({ ...budget, daily: window(null, null) })?.period, "weekly");
  assert.equal(bindingWindow({ daily: window(null, null), weekly: window(null, null), monthly: window(null, null) }), undefined);
});

test("a plan's budget is the binding window's, not the monthly one's", async () => {
  mock.method(api, "getPolicy", async () => ({ usage: { budget: { daily: window("25", "4.50"), weekly: window("75", "40"), monthly: window("150", "90") } } }));
  assert.equal(await budgetRemaining(), "4.50");
  mock.method(api, "getPolicy", async () => ({ usage: { budget: { daily: window(null, null), weekly: window(null, null), monthly: window(null, null) } } }));
  assert.equal(await budgetRemaining(), null);
  mock.restoreAll();
});
