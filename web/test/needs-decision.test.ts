import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedProposals, needsDecision, openProposals } from "../src/needs-decision.ts";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const MIN = 60_000, HOUR = 60 * MIN;
import { USDC } from "./server-fixtures.ts";
const leg = { from: USDC, to: "nep141:wrap.near", amount: "1000000", minAmountOut: "499500000000000000000000" };
const view = (id: string, state: string, expiresInMs: number) => ({ id, state, legs: [leg], expiresAt: new Date(NOW + expiresInMs).toISOString() }) as never;
const ids = (list: readonly { id: string }[]) => list.map(item => item.id);

test("which proposals count as open: proposed and not expired, soonest deadline first", () => {
  const list = [view("late", "proposed", 5 * HOUR), view("soon", "proposed", 10 * MIN), view("expired", "proposed", -MIN), view("now", "proposed", 0),
    view("approved", "approved", HOUR), view("executed", "executed", HOUR), view("rejected", "rejected", HOUR), view("withdrawn", "withdrawn", HOUR)];
  assert.deepEqual(ids(openProposals(list, NOW)), ["soon", "late"]);
});

test("which proposals count as approved, not executed: approved and not expired, soonest deadline first", () => {
  const list = [view("b", "approved", 3 * HOUR), view("a", "approved", HOUR), view("gone", "approved", -HOUR), view("open", "proposed", HOUR),
    view("running", "executing", HOUR), view("done", "executed", HOUR), view("unknown", "unknown", HOUR), view("expired", "expired", HOUR)];
  assert.deepEqual(ids(approvedProposals(list, NOW)), ["a", "b"]);
});

test("a deadline exactly now is expired, and the input is not changed", () => {
  const list = [view("x", "proposed", 0), view("y", "approved", 0)];
  const copy = structuredClone(list);
  assert.deepEqual(openProposals(list, NOW), []);
  assert.deepEqual(approvedProposals(list, NOW), []);
  assert.deepEqual(list, copy);
});

test("the list: open and approved proposals and the DAO's requests by deadline, then operations without a deadline, in the platform's order", () => {
  const need = needsDecision({
    proposals: [view("p-late", "proposed", 6 * HOUR), view("p-approved", "approved", 2 * HOUR), view("p-done", "executed", HOUR), view("p-gone", "proposed", -HOUR)],
    unresolved: [{ key: "u1", kind: "swap", at: "2026-11-06T11:00:00.000Z" }, { key: "u2", kind: "shield", at: "2026-11-06T10:00:00.000Z" }],
    daoRequests: [{ id: "c".repeat(64), kind: "consent", votingUntil: NOW + 7 * 24 * HOUR }, { id: "v".repeat(64), kind: "vote", proposal: "p".repeat(32), verdict: "approve", votingUntil: NOW + HOUR }],
    now: NOW,
  });
  assert.deepEqual(need.map(item => [item.kind, item.deadline === null ? null : item.deadline - NOW]), [
    ["dao-vote", HOUR], ["approved-proposal", 2 * HOUR], ["open-proposal", 6 * HOUR], ["dao-consent", 7 * 24 * HOUR], ["unresolved", null], ["unresolved", null]]);
  assert.deepEqual(need.filter(item => item.kind === "unresolved").map(item => item.key), ["unresolved-u1", "unresolved-u2"]);
  assert.equal(new Set(need.map(item => item.key)).size, need.length, "every item has its own key");
});

test("each item says what it is and where it leads", () => {
  const need = needsDecision({
    proposals: [view("p".repeat(32), "proposed", HOUR)], unresolved: [{ key: "u", kind: "swap", at: "2026-11-06T11:00:00.000Z" }],
    daoRequests: [{ id: "c".repeat(64), kind: "consent", votingUntil: NOW + 2 * HOUR }, { id: "v".repeat(64), kind: "vote", proposal: "q".repeat(32), verdict: "reject", votingUntil: NOW + 3 * HOUR }], now: NOW });
  const [open, consent, vote, unresolved] = need;
  assert.deepEqual(open!.target, { page: "proposal", id: "p".repeat(32) });
  assert.match(open!.text, /^Awaiting your decision: Swap 1 USDC for at least 0\.4995 wNEAR$/);
  assert.deepEqual(consent!.target, { page: "connection" });
  assert.match(consent!.text, /connect the agent/);
  assert.deepEqual(vote!.target, { page: "proposal", id: "q".repeat(32) });
  assert.match(vote!.text, /to reject a proposal/);
  assert.deepEqual(unresolved!.target, { page: "activity", key: "u" }, "the operation's entry on the Activity page");
  assert.equal(unresolved!.at, "2026-11-06T11:00:00.000Z");
  assert.match(unresolved!.text, /nothing new runs until it's resolved/);
});

test("nothing waiting gives an empty list; several legs read together", () => {
  assert.deepEqual(needsDecision({ proposals: [], unresolved: [], daoRequests: [], now: NOW }), []);
  const two = { ...(view("m".repeat(32), "proposed", HOUR) as object), legs: [leg, leg] } as never;
  assert.match(needsDecision({ proposals: [two], unresolved: [], daoRequests: [], now: NOW })[0]!.text, /; Swap 1 USDC/);
});

test("an operation's or request's equal deadlines keep the order they were given", () => {
  const same = { kind: "vote" as const, votingUntil: NOW + HOUR };
  const need = needsDecision({ proposals: [], unresolved: [], daoRequests: [{ ...same, id: "1".repeat(64), proposal: "a".repeat(32) }, { ...same, id: "2".repeat(64), proposal: "b".repeat(32) }], now: NOW });
  assert.deepEqual(need.map(item => item.key), [`dao-${"1".repeat(64)}`, `dao-${"2".repeat(64)}`]);
});

test("an owner action waiting for the DAO's vote is listed until it expires, with its deadline, and leads to where it is voted on", () => {
  const action = (type: string, expiresInMs: number, stage: "prepared" | "settled" = "prepared", signer: "dao" | "wallet" = "dao") => ({ correlationId: `c-${type}-${expiresInMs}-${stage}-${signer}`, type, stage, signer, expiresAt: new Date(NOW + expiresInMs).toISOString() });
  const need = needsDecision({ proposals: [view("p", "proposed", 3 * HOUR)], unresolved: [], daoRequests: [],
    ownerActions: [action("agent_freeze", HOUR), action("grant_issue", 2 * HOUR), action("agent_unfreeze", HOUR, "settled"), action("agent_freeze", -MIN), action("grant_revoke", 5 * HOUR),
      action("agent_freeze", HOUR, "prepared", "wallet")], now: NOW });
  assert.deepEqual(need.map(item => [item.kind, item.deadline === null ? null : item.deadline - NOW]), [["owner-action", HOUR], ["owner-action", 2 * HOUR], ["open-proposal", 3 * HOUR], ["owner-action", 5 * HOUR]],
    "not one that finished, lapsed, or was only prepared for a wallet to sign");
  assert.deepEqual(need.filter(item => item.kind === "owner-action").map(item => item.target), [
    { page: "owner-action", type: "agent_freeze" }, { page: "owner-action", type: "grant_issue" }, { page: "owner-action", type: "grant_revoke" }]);
  assert.match(need[0]!.text, /^Freeze is waiting for the DAO's vote$/);
  assert.match(need[3]!.text, /^Revoke a grant is waiting/);
  assert.deepEqual(needsDecision({ proposals: [], unresolved: [], daoRequests: [], now: NOW }), [], "the owner's actions are optional");
});

test("a proposal whose verdict waits for the DAO's vote is listed as the vote only, not twice", () => {
  const id = "p".repeat(32);
  const need = needsDecision({ proposals: [view(id, "proposed", HOUR), view("other", "proposed", 2 * HOUR)], unresolved: [],
    daoRequests: [{ id: "v".repeat(64), kind: "vote", proposal: id, verdict: "approve", votingUntil: NOW + HOUR }], now: NOW });
  assert.deepEqual(need.map(item => [item.kind, item.target]), [["dao-vote", { page: "proposal", id }], ["open-proposal", { page: "proposal", id: "other" }]]);
});

test("the home follows an owner action's phase before its older stage when listing a DAO vote", () => {
  const base = { type: "agent_freeze", signer: "dao" as const, expiresAt: new Date(NOW + HOUR).toISOString() };
  const need = needsDecision({ proposals: [], unresolved: [], daoRequests: [], now: NOW, ownerActions: [
    { ...base, correlationId: "voting", stage: "settled", phase: "open" },
    { ...base, correlationId: "finished", stage: "prepared", phase: "settled" },
  ] });
  assert.deepEqual(need.map(item => item.key), ["action-voting"]);
});
