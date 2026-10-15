import assert from "node:assert/strict";
import { test } from "node:test";
import { strategyProgress } from "../web/src/features/portfolio/strategy-progress.js";

const facts = { editing: false, statusUnknown: false, actionsUnknown: false, pendingGrant: undefined as string | undefined,
  grantMatches: true as boolean | null, scheduleOn: false as boolean | undefined, executor: true, ready: true };

test("strategy progress separates authorization from scheduling", () => {
  assert.equal(strategyProgress(facts).authorization, "Authorized for the saved strategy");
  assert.equal(strategyProgress(facts).schedule, "Off · no scheduled runs");
  assert.match(strategyProgress(facts).next, /Turn on/);
  const blocked = strategyProgress({ ...facts, ready: false, scheduleOn: true });
  assert.equal(blocked.schedule, "On · readiness blocked");
  assert.match(blocked.next, /blockers/);
});

test("unknown and pending observations never claim authorization or readiness", () => {
  for (const change of [{ statusUnknown: true }, { actionsUnknown: true }]) {
    const progress = strategyProgress({ ...facts, ...change });
    assert.equal(progress.authorization, "Authorization not confirmed");
    assert.match(progress.next, /Retry/);
  }
  assert.equal(strategyProgress({ ...facts, pendingGrant: "submitted" }).authorization, "Owner action submitted");
  assert.match(strategyProgress({ ...facts, pendingGrant: "submitted" }).next, /existing owner action/);
  assert.equal(strategyProgress({ ...facts, scheduleOn: undefined }).schedule, "Schedule not confirmed");
});

test("drafts do not imply a changed saved strategy or stopped schedule", () => {
  const progress = strategyProgress({ ...facts, editing: true, scheduleOn: true });
  assert.equal(progress.configuration, "Unsaved draft");
  assert.equal(progress.schedule, "On · ready for scheduled runs");
  assert.match(progress.next, /Saving stops the schedule/);
  assert.match(progress.next, /draft does not change/);
  assert.match(strategyProgress({ ...facts, executor: false, grantMatches: null }).next, /executor/);
});
