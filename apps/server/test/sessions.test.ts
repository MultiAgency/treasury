import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessions, memorySessions } from "../src/sessions.ts";

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

test("ended sessions are swept, whether or not their token comes back", () => {
  const removed: string[] = [];
  const clock = { now: 0 };
  const store = new Map<string, { account: string; createdAt: number; lastSeen: number }>();
  const sessions = createSessions({ idleMs: 1_000, maxMs: 5_000, now: () => clock.now, store: {
    get: token => store.get(token), set: (token, session) => { store.set(token, session); },
    delete: token => { removed.push(token); store.delete(token); },
    sweep: ended => { for (const [token, session] of store) if (ended(session)) { removed.push(token); store.delete(token); } },
  } });
  const abandoned = sessions.start("a.near");
  clock.now += 1_001;
  sessions.sweep();
  assert.deepEqual(removed, [abandoned]);
  const live = sessions.start("b.near");
  clock.now += 900;
  sessions.sweep();
  assert.equal(store.has(live), true, "a live session stays");
  clock.now += 1_001;
  sessions.start("c.near");
  assert.equal(store.has(live), false, "every sign-in sweeps too");
});

test("the in-memory store sweeps exactly the sessions said to have ended", () => {
  const store = memorySessions();
  store.set("old", { account: "a.near", createdAt: 0, lastSeen: 0 });
  store.set("new", { account: "b.near", createdAt: 10, lastSeen: 10 });
  store.sweep(session => session.lastSeen < 5);
  assert.equal(store.get("old"), undefined);
  assert.equal(store.get("new")?.account, "b.near");
});
