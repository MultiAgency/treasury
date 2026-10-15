import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STRATEGY, Strategy } from "../src/strategy-digest.js";
import { parseStrategyDraft, strategyDraft } from "../web/src/features/portfolio/strategy-form.js";

test("unchanged strategy survives the editor without changing its grant binding", () => {
  assert.deepEqual(parseStrategyDraft(strategyDraft(DEFAULT_STRATEGY)).strategy, DEFAULT_STRATEGY);
});

test("decimal targets sum exactly and parse through the server's strategy schema", () => {
  const draft = strategyDraft(DEFAULT_STRATEGY);
  const assets = Object.keys(draft.targets);
  draft.targets = Object.fromEntries(assets.map((asset, i) => [asset, i === 2 ? "33.34" : "33.33"]));
  const result = parseStrategyDraft(draft);
  assert.deepEqual(result.errors, {});
  assert.equal(Object.values(Strategy.parse(result.strategy).targetBps).reduce((a, b) => a + b, 0), 10_000);
});

test("incomplete allocations, exponent notation, unsafe integers and fractional intervals cannot save", () => {
  const draft = strategyDraft(DEFAULT_STRATEGY);
  const asset = Object.keys(draft.targets)[0]!;
  for (const invalid of ["", "NaN", "1e2", "-1", "100.001"]) {
    assert.equal(parseStrategyDraft({ ...draft, targets: { ...draft.targets, [asset]: invalid } }).strategy, null);
  }
  assert.match(parseStrategyDraft({ ...draft, targets: { ...draft.targets, [asset]: "0" } }).errors.targets!, /100/);
  for (const everyMin of ["4", "5.5", "1441", "9007199254740992"])
    assert.ok(parseStrategyDraft({ ...draft, everyMin }).errors.everyMin);
  assert.equal(parseStrategyDraft({ ...draft, maxUsd: "0" }).strategy?.autopilot.maxUsd, 0);
});
