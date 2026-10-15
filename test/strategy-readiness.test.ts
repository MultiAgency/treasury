import assert from "node:assert/strict";
import { test } from "node:test";
import { strategyReadiness } from "../src/strategy-readiness.js";

const ready = { executor: true, on: true, policyReason: null, unresolved: 0, grantMatches: true };

test("enabled schedule does not report ready with a mismatched strategy grant", () => {
  const result = strategyReadiness({ ...ready, grantMatches: false });
  assert.equal(result.state, "authorization-required");
  assert.equal(result.canEnable, false);
  assert.match(result.reasons.join(" "), /owner.*grant/i);
});

test("off is distinct from ready and from blocked; all blockers remain visible", () => {
  assert.equal(strategyReadiness({ ...ready, on: false }).state, "off");
  assert.equal(strategyReadiness({ ...ready, on: false }).canEnable, true);
  const blocked = strategyReadiness({ ...ready, on: false, unresolved: 2, policyReason: "the agent is frozen", grantMatches: false });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.canEnable, false);
  assert.equal(blocked.reasons.length, 3);
  assert.match(blocked.reasons.join(" "), /frozen/);
  assert.match(blocked.reasons.join(" "), /2 unresolved/);
});

test("approve-only hosts never offer local activation, even with a matching remote grant", () => {
  assert.equal(strategyReadiness({ ...ready, executor: false }).state, "approve-only");
  assert.equal(strategyReadiness({ ...ready, executor: false }).canEnable, false);
  assert.equal(strategyReadiness(ready).state, "ready");
});


test("approve-only authorization is unknown, not a reason to issue another grant", () => {
  const result = strategyReadiness({ ...ready, executor: false, grantMatches: false });
  assert.equal(result.state, "approve-only");
  assert.doesNotMatch(result.reasons.join(" "), /must issue|matching grant/);
  assert.match(result.reasons.join(" "), /executor/);
});
