import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerFilings, type OwnerFiling } from "../src/owner-filings.ts";

const transaction = { receiverId: "dao.near", actions: [{ type: "FunctionCall" as const, params: { methodName: "add_proposal", args: {}, gas: "1", deposit: "0" } }] };
const filing = (correlationId: string, expiresAt: number, next = 4): OwnerFiling => ({ organization: "dao--near", agent: "treasury", correlationId,
  expiresAt: new Date(expiresAt).toISOString(), filed: { dao: "dao.near", next, transactions: { proposal: transaction, proposalAndVote: null } } });

test("a filing is found by its Organization, agent and action, as a copy; the latest kept for an action replaces the one before", () => {
  const clock = { now: 1_000_000 };
  const filings = ownerFilings({ now: () => clock.now });
  filings.keep(filing("freeze-1", clock.now + 300_000));
  const found = filings.get("dao--near", "treasury", "freeze-1")!;
  assert.equal(found.filed.next, 4);
  found.filed.next = 99;
  assert.equal(filings.get("dao--near", "treasury", "freeze-1")!.filed.next, 4, "what is kept can't be changed through what is read");
  assert.equal(filings.get("other--near", "treasury", "freeze-1"), undefined, "another Organization's");
  assert.equal(filings.get("dao--near", "other", "freeze-1"), undefined, "another agent's");
  filings.keep(filing("freeze-1", clock.now + 300_000, 7));
  assert.equal(filings.get("dao--near", "treasury", "freeze-1")!.filed.next, 7);
  filings.forget("dao--near", "treasury", "freeze-1");
  assert.equal(filings.get("dao--near", "treasury", "freeze-1"), undefined);
});

test("a filing outlives its vote's deadline by an hour, so its ending can still be said, and no longer; the oldest go first when full", () => {
  const clock = { now: 1_000_000 };
  const filings = ownerFilings({ limit: 2, now: () => clock.now });
  filings.keep(filing("a", clock.now + 60_000));
  clock.now += 60_000 + 3_599_000;
  assert.ok(filings.get("dao--near", "treasury", "a"), "within the hour after its deadline");
  clock.now += 2_000;
  assert.equal(filings.get("dao--near", "treasury", "a"), undefined, "past it");
  filings.keep(filing("b", clock.now + 60_000)); filings.keep(filing("c", clock.now + 60_000)); filings.keep(filing("d", clock.now + 60_000));
  assert.deepEqual(["b", "c", "d"].map(id => filings.get("dao--near", "treasury", id) !== undefined), [false, true, true]);
});
