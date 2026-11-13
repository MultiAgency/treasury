import { test } from "node:test";
import assert from "node:assert/strict";
import { firstSteps, nextStep } from "../src/first-transaction-view.ts";

const holding = (amount: string) => ({ public: amount, confidential: "0", usd: Number(amount) });
const states = (steps: ReturnType<typeof firstSteps>) => steps.map(step => [step.label, step.state]);

test("before the agent is connected, connecting is next and what it would read is not called to do", () => {
  const steps = firstSteps({ connected: false, book: undefined, notInForce: undefined, grantMatches: undefined });
  assert.deepEqual(states(steps), [["Create the agent", "done"], ["Connect Treasury", "todo"], ["Fund the agent", "unread"], ["Check the policy", "unread"],
    ["Authorize the strategy", "unread"], ["Review a proposal", "unread"]]);
  const next = nextStep(steps);
  assert.deepEqual([next.label, next.page, next.hash, next.note], ["Connect Treasury", "home", "connection", undefined], "no note about a later step");
});

test("connected, each step is read: an empty book is to fund, and the note is the next step's own", () => {
  const unfunded = firstSteps({ connected: true, book: [holding("0")], notInForce: null, grantMatches: false });
  assert.deepEqual(states(unfunded), [["Create the agent", "done"], ["Connect Treasury", "done"], ["Fund the agent", "todo"], ["Check the policy", "done"],
    ["Authorize the strategy", "todo"], ["Review a proposal", "todo"]]);
  assert.deepEqual([nextStep(unfunded).label, nextStep(unfunded).page, nextStep(unfunded).note], ["Fund the agent", "funding", undefined], "funding isn't told to authorize the strategy");

  const funded = firstSteps({ connected: true, book: [holding("5")], notInForce: null, grantMatches: false });
  assert.equal(nextStep(funded).label, "Authorize the strategy");
  assert.match(nextStep(funded).note!, /^Authorize the saved strategy on Strategy before creating a proposal\. Autopilot is optional/);

  const authorized = firstSteps({ connected: true, book: [holding("5")], notInForce: null, grantMatches: true });
  assert.deepEqual([nextStep(authorized).label, nextStep(authorized).note], ["Review a proposal", "Autopilot is optional and can stay off."]);
});

test("a blocked policy is to do, and a host that only approves has no step to authorize", () => {
  const blocked = firstSteps({ connected: true, book: [holding("5")], notInForce: "the agent is frozen", grantMatches: true });
  assert.equal(nextStep(blocked).label, "Check the policy");
  const approveOnly = firstSteps({ connected: true, book: [holding("5")], notInForce: null, grantMatches: null });
  assert.deepEqual(approveOnly.map(step => step.label), ["Create the agent", "Connect Treasury", "Fund the agent", "Check the policy", "Review a proposal"]);
  assert.match(nextStep(approveOnly).note!, /^This host only approves proposals/);
});
