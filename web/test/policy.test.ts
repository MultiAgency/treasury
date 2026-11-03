import { test } from "node:test";
import assert from "node:assert/strict";
import { changesOf, differences, draftOf, type AgentPolicy } from "../src/features/policy/policy-draft.ts";
import type { Holding } from "../src/shared/format.ts";

const USDC = "nep141:usdc", WNEAR = "nep141:wrap.near", OTHER = "nep141:other";
const book = [{ asset: USDC, symbol: "USDC", decimals: 6 }, { asset: WNEAR, symbol: "wNEAR", decimals: 24 }] as Holding[];
const policy = {
  frozen: false, actions: ["swap"], confidential: true, owner_approval: false, assets: "any",
  limits: { per_transaction: { [USDC]: "25000000", [OTHER]: "7" } }, max_actions_per_hour: 10,
  budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
} as unknown as AgentPolicy;

test("an unchanged draft asks for the policy as signed: caps in raw units, and caps the form can't show are kept", () => {
  const draft = draftOf(policy, book);
  assert.equal(draft.caps.per_transaction[USDC], "25");
  assert.deepEqual(differences(draft, draft, book), []);
  assert.deepEqual(changesOf(draft, book, policy), { changes: {
    swap: true, assets: "any", owner_approval: false, max_actions_per_hour: 10,
    budget: { daily_usd: "50", weekly_usd: null, monthly_usd: "200" },
    limits: { per_transaction: { [USDC]: "25000000", [OTHER]: "7" } },
  } });
});

test("a changed draft: each change is one line, and amounts convert exactly", () => {
  const before = draftOf(policy, book);
  const after = { ...before, rate: "12", caps: { ...before.caps, daily: { ...before.caps.daily, [WNEAR]: "1.5" } } };
  assert.deepEqual(differences(before, after, book), ["Actions an hour: 10 → 12", "wNEAR per day: none → 1.5 wNEAR"]);
  const result = changesOf(after, book, policy);
  assert.ok("changes" in result);
  assert.equal(result.changes.max_actions_per_hour, 12);
  assert.deepEqual(result.changes.limits?.daily, { [WNEAR]: "1500000000000000000000000" });
});

test("an invalid field is named, and nothing is asked for", () => {
  const draft = draftOf(policy, book);
  assert.deepEqual(changesOf({ ...draft, caps: { ...draft.caps, per_transaction: { ...draft.caps.per_transaction, [USDC]: "1.0000001" } } }, book, policy), { invalid: "USDC per payment" });
  assert.deepEqual(changesOf({ ...draft, budget: { ...draft.budget, weekly_usd: "-1" } }, book, policy), { invalid: "the budget a week" });
  assert.deepEqual(changesOf({ ...draft, rate: "1.5" }, book, policy), { invalid: "actions an hour" });
});
