import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { blockShield, forgetGrant, keepGrant, keptGrant, resetKeptOutcomes, shieldBlocked } from "../src/kept-outcomes.ts";
import type { GrantPrepared } from "../src/proposals-api.ts";

beforeEach(() => resetKeptOutcomes());

const grant = (correlationId: string) => ({ correlationId }) as unknown as GrantPrepared;
const DIGEST = `sha256:${"a".repeat(64)}`, OTHER = `sha256:${"b".repeat(64)}`;

test("a shield that may have gone out stays blocked for the agent, whichever page is shown, and only for that agent", () => {
  assert.equal(shieldBlocked("portfolio"), false);
  blockShield("portfolio");
  // Funding unmounts when the owner goes to Home, and mounts again on the way back: the block is not component state.
  assert.equal(shieldBlocked("portfolio"), true, "still blocked when the page is mounted again");
  assert.equal(shieldBlocked("savings"), false, "another agent's is not");
  blockShield("portfolio");
  assert.equal(shieldBlocked("portfolio"), true, "blocking twice changes nothing");
});

test("the grant prepared for a strategy is kept, so a return to the page resumes it instead of offering another", () => {
  assert.equal(keptGrant("portfolio", DIGEST), undefined);
  keepGrant("portfolio", DIGEST, grant("c1"));
  assert.equal(keptGrant("portfolio", DIGEST)?.correlationId, "c1");
  assert.equal(keptGrant("savings", DIGEST), undefined, "another agent's");
});

test("a grant kept for another strategy digest is not the one for this strategy", () => {
  keepGrant("portfolio", DIGEST, grant("c1"));
  assert.equal(keptGrant("portfolio", OTHER), undefined, "the strategy changed: a new grant is asked for");
  keepGrant("portfolio", OTHER, grant("c2"));
  assert.equal(keptGrant("portfolio", OTHER)?.correlationId, "c2");
  assert.equal(keptGrant("portfolio", DIGEST), undefined, "one grant at a time per agent");
});

test("a grant that ended without taking effect, or has bound the strategy, is forgotten", () => {
  keepGrant("portfolio", DIGEST, grant("c1"));
  forgetGrant("portfolio");
  assert.equal(keptGrant("portfolio", DIGEST), undefined);
  forgetGrant("portfolio");
  forgetGrant("never-kept");
});

test("a fresh page load forgets everything", () => {
  blockShield("portfolio");
  keepGrant("portfolio", DIGEST, grant("c1"));
  resetKeptOutcomes();
  assert.equal(shieldBlocked("portfolio"), false);
  assert.equal(keptGrant("portfolio", DIGEST), undefined);
});
