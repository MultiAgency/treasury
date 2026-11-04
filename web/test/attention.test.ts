// What the Overview's "Needs attention" lists, from the agent's reads: only what those reads show, nothing guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionOf } from "../src/features/workspace/attention.ts";
import type { InboxEntry, Overview, Setup } from "../src/platform.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const setup = (grant: Setup["grant"], executor = true) => ({ agentId: "a1", executor, wallet: null, owner: null, grant, dao: null }) as Setup;
const overview = (policy: { frozen: boolean } | null, notInForce: string | null = null) =>
  ({ agentId: "a1", book: [], unmanaged: [], target: {}, policy: { policy }, digest: null, notInForce, grants: [] }) as unknown as Overview;
const entry = (id: string, at: string, text: string, level: InboxEntry["level"] = "warn", dismissed?: boolean): InboxEntry => ({ id, at, text, level, ...(dismissed !== undefined && { dismissed }) });

test("nothing read, nothing listed: a missing setup isn't taken as a missing grant", () => {
  assert.deepEqual(attentionOf({ now: NOW }), []);
});

test("unresolved operations come first and block new sends", () => {
  const [first] = attentionOf({ unresolved: [{ key: "k", at: iso(-3_600_000), kind: "swap", request: {}, status: null, sent: true }], now: NOW });
  assert.equal(first?.to, "/activity");
  assert.equal(first?.tone, "destructive");
  assert.match(first!.text, /^1 money action has no proven outcome, the oldest from .+\. Nothing new moves until it is resolved\.$/);
});

test("a frozen agent, or a policy not in force, sends the owner to the policy", () => {
  assert.equal(attentionOf({ overview: overview({ frozen: true }), now: NOW })[0]?.text, "The agent is frozen. Nothing moves until the owner unfreezes it.");
  assert.equal(attentionOf({ overview: overview({ frozen: false }, "not signed"), now: NOW })[0]?.text, "The policy isn't in force: not signed. Nothing moves until it is.");
  assert.deepEqual(attentionOf({ overview: overview({ frozen: false }), now: NOW }), []);
});

test("the Treasury's grant: none, or expiring within a week, sends the owner to the Strategy page; an approve-only instance needs none", () => {
  assert.deepEqual(attentionOf({ setup: setup(null), now: NOW }).map(i => [i.to, i.action]), [["/automations", "Authorize"]]);
  assert.deepEqual(attentionOf({ setup: setup({ id: "g", label: "treasury:abc", expiresAt: iso(2 * 86_400_000) }), now: NOW }).map(i => [i.to, i.action]), [["/automations", "Renew"]]);
  assert.deepEqual(attentionOf({ setup: setup({ id: "g", label: "treasury:abc", expiresAt: iso(30 * 86_400_000) }), now: NOW }), []);
  assert.deepEqual(attentionOf({ setup: setup(null, false), now: NOW }), []);
});

test("a held payout is named with its amount and payee, and reviewed in Activity", () => {
  const [item] = attentionOf({ held: [{ at: iso(-60_000), kind: "pay", correlationId: "c", approvalId: "ap",
    request: { amount: "1500000", asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", recipient: "bob.near" } }], nameOf: a => `@${a}`, now: NOW });
  assert.equal(item?.to, "/activity");
  assert.match(item!.text, /^1\.5 USDC to @bob\.near is held for the owner's approval/);
});

test("inbox: dismissed and run entries are left out; a message raised again is one item, newest first, dismissed together", () => {
  const items = attentionOf({ inbox: [
    entry("old", iso(-120_000), "Drift is 12 min old above target"),
    entry("new", iso(-60_000), "Drift is 3 min old above target"),
    entry("gone", iso(-30_000), "Dismissed already", "warn", true),
    entry("run", iso(-30_000), "Tick finished", "run"),
    entry("act", iso(-10_000), "Fund the agent", "action"),
  ], now: NOW });
  assert.deepEqual(items.map(i => i.inboxIds), [["act"], ["new", "old"]]);
  assert.deepEqual(items.map(i => i.tone), ["info", "warning"]);
  assert.match(items[1]!.text, /^Drift is 3 min old above target \(2 times, latest .+\)$/);
  for (const item of items) assert.equal(item.to, "/automations");
});
