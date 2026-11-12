import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { StrategyRead } from "../src/server-api.ts";
import { symbolOf } from "../src/shared/format.ts";

/** Check the actual wallet/DAO dialog against the saved server record before any grant is prepared. */
export async function checkStrategyReview(page: Page, agent: string) {
  const saved = await page.evaluate(async name => {
    const response = await fetch(`/api/agents/${name}/strategy`);
    const body = await response.json();
    if (!body.ok) throw new Error("Saved strategy unavailable");
    return body.value;
  }, agent) as StrategyRead;
  const review = page.getByRole("dialog", { name: "Authorize this saved strategy?" });
  const targets = review.getByRole("list", { name: "Strategy being authorized" });
  assert.deepEqual(await targets.getByRole("listitem").allTextContents(),
    Object.entries(saved.strategy.targetBps).filter(([, bps]) => bps > 0)
      .map(([asset, bps]) => `${symbolOf(asset, [])}: ${bps / 100}%`));
  const text = await review.innerText();
  assert.ok(text.includes(saved.digest), "the terms and digest come from the same saved record");
  assert.ok(text.includes(`Swaps of at least $${saved.strategy.minLegUsd}, costing at most ${saved.strategy.maxCostBps / 100}%`));
  assert.ok(text.includes(`every ${saved.strategy.autopilot.everyMin} minutes`));
  assert.ok(text.includes(`up to $${saved.strategy.autopilot.maxUsd} a run`));
  if (saved.strategy.cashFloor) {
    assert.ok(text.includes(`Cash floor: $${saved.strategy.cashFloor.usd} in ${saved.strategy.cashFloor.assets.map(asset => symbolOf(asset, [])).join(", ")}`));
  }
  return saved;
}
