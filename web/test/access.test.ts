import { test } from "node:test";
import assert from "node:assert/strict";
import { accessState, deniedAt, settleDenials } from "../src/app/access.ts";
import { agent } from "../src/platform.ts";

/** A gateway denial of `scope` on an agent, as the platform module reports it. */
async function denied(name: string, access: "session" | "agent") {
  Object.assign(globalThis, { location: new URL("https://treasury.test/") });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: `${access} denied`, access }, { status: 403 });
  try { await agent(name).read("overview", undefined).catch(() => {}); } finally { globalThis.fetch = realFetch; }
}
const session = (account: string, ...agents: string[]) => ({ account, access: Object.fromEntries(agents.map(name => [name, {}])) });

test("a refreshed session lifts the denials it answers, including after another account signs in", async () => {
  settleDenials(session("owner.near", "portfolio", "other"));
  await denied("portfolio", "agent");
  await denied("other", "agent");
  assert.ok(deniedAt(accessState(), "portfolio"));

  // Another account signs in and may see portfolio, but not other: portfolio's records return, other's stay hidden.
  settleDenials(session("member.near", "portfolio"));
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
  assert.ok(deniedAt(accessState(), "other"));

  // A session denial hides everything until a session read succeeds.
  await denied("portfolio", "session");
  assert.ok(deniedAt(accessState(), "portfolio"));
  settleDenials(session("member.near", "portfolio"));
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
  assert.ok(deniedAt(accessState(), "other"));

  // Signed out, nothing stays latched for the next sign-in.
  settleDenials(null);
  assert.deepEqual(accessState(), { agents: {} });
});

test("when the session read and the agent's route disagree, the agent stays hidden instead of alternating", async () => {
  settleDenials(session("owner.near", "portfolio"));
  await denied("portfolio", "agent");
  // The session read grants it again (say, the provider check passed this time): lifted, once.
  settleDenials(session("owner.near", "portfolio"));
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);

  // The route denies it again, and the next session read grants it again: the gateway contradicts itself, so it stays
  // hidden until "Check access again" reloads the page.
  await denied("portfolio", "agent");
  settleDenials(session("owner.near", "portfolio"));
  assert.ok(deniedAt(accessState(), "portfolio"));
  settleDenials(session("owner.near", "portfolio"));
  assert.ok(deniedAt(accessState(), "portfolio"), "still hidden on every later read");

  // Another account's session answers for itself: its access lifts the denial.
  settleDenials(session("member.near", "portfolio"));
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
  // Signing out starts again: a later denial may be lifted once more.
  settleDenials(null);
  settleDenials(session("owner.near", "portfolio"));
  await denied("portfolio", "agent");
  settleDenials(session("owner.near", "portfolio"));
  assert.equal(deniedAt(accessState(), "portfolio"), undefined);
});
