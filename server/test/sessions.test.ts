import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessions } from "../src/sessions.ts";

const setup = () => {
  const clock = { now: 0 };
  return { clock, sessions: createSessions({ idleMs: 1_000, maxMs: 5_000, now: () => clock.now }) };
};

test("a session gives its account while it's live, and activity keeps it live", () => {
  const { clock, sessions } = setup();
  const token = sessions.start("owner.near");
  assert.equal(sessions.account(token), "owner.near");
  for (let i = 0; i < 4; i++) { clock.now += 900; assert.equal(sessions.account(token), "owner.near"); }
});

test("a session ends after its idle time", () => {
  const { clock, sessions } = setup();
  const token = sessions.start("owner.near");
  clock.now += 1_001;
  assert.equal(sessions.account(token), undefined);
  clock.now -= 1_001;
  assert.equal(sessions.account(token), undefined, "an ended session stays ended");
});

test("a session ends at its maximum age, however active", () => {
  const { clock, sessions } = setup();
  const token = sessions.start("owner.near");
  while (clock.now < 5_000) { clock.now += 900; sessions.account(token); }
  assert.equal(sessions.account(token), undefined);
});

test("sign-out ends a session, and tokens are unguessable and distinct", () => {
  const { sessions } = setup();
  const token = sessions.start("owner.near");
  assert.ok(token.length >= 43 && token !== sessions.start("owner.near"));
  sessions.end(token);
  assert.equal(sessions.account(token), undefined);
  assert.equal(sessions.account(undefined), undefined);
});
