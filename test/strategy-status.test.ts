import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { treasuryPolicy } from "../src/policy.js";
import { readStrategyStatus } from "../src/strategy-status.js";
import { DEFAULT_STRATEGY, strategyLabelSuffix } from "../src/strategy-digest.js";
import { fixtureGrant, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("strategy-status");
beforeEach(() => {
  mock.restoreAll(); offline();
  process.env.AGENT_GRANT_TOKEN = "fixture-strategy-token";
  process.env.AUTOPILOT = "on";
  delete process.env.EXECUTOR;
  mock.method(api, "getPolicy", async () => policyView(treasuryPolicy));
  mock.method(api, "listGrants", async () => [fixtureGrant()]);
});

test("readiness exposes only the live held grant and never its credential", async () => {
  const value = await readStrategyStatus();
  assert.equal(value.readiness.state, "ready");
  assert.equal(value.grantMatches, true);
  assert.doesNotMatch(JSON.stringify(value), /fixture-strategy-token|credential/);
});

test("a grant for another purpose or expired or held by another server cannot authorize the displayed strategy", async () => {
  const suffix = strategyLabelSuffix(DEFAULT_STRATEGY);
  for (const grant of [
    fixtureGrant(`payout:${suffix}`),
    { ...fixtureGrant(), expires_at: "2000-01-01T00:00:00Z" },
    { ...fixtureGrant(), owner_message: { ...fixtureGrant().owner_message, credential: "another-token-commitment" } },
  ]) {
    mock.method(api, "listGrants", async () => [grant]);
    const value = await readStrategyStatus();
    assert.equal(value.grantMatches, false);
    assert.equal(value.readiness.state, "authorization-required");
  }
});

test("an unavailable provider read is not presented as an off or ready strategy", async () => {
  mock.method(api, "getPolicy", async () => { throw new Error("policy unavailable"); });
  await assert.rejects(readStrategyStatus(), /policy unavailable/);
});

test("approve-only and frozen views cannot report ready", async () => {
  process.env.EXECUTOR = "off";
  const remote = await readStrategyStatus();
  assert.equal(remote.readiness.state, "approve-only");
  assert.equal(remote.grantMatches, null);
  assert.doesNotMatch(remote.readiness.reasons.join(" "), /must issue/);
  delete process.env.EXECUTOR;
  mock.method(api, "getPolicy", async () => policyView({ ...treasuryPolicy, frozen: true }));
  assert.equal((await readStrategyStatus()).readiness.state, "blocked");
});
