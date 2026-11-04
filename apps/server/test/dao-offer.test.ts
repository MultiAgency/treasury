import { test } from "node:test";
import assert from "node:assert/strict";
import { offerFor, voteLink, type Filed } from "../src/dao-offer.ts";
import type { DaoProposal, Policy } from "../src/dao.ts";
import { daoKind, daoTransaction } from "./fakes.ts";

const DAO = "agentic.sputnik-dao.near", HASH = "ab".repeat(32), NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY_NS = 86_400n * 1_000_000_000n;
const policy = { proposal_bond: "0", proposal_period: String(7n * DAY_NS), roles: [], default_vote_policy: { threshold: [1, 2] } } as Policy;
const filed: Filed = { dao: DAO, next: 59, transactions: { proposal: daoTransaction(DAO, HASH), proposalAndVote: daoTransaction(DAO, HASH, 59) } };
const both = { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: false };
const requestor = { ...both, canVote: false, canExecute: false }, approver = { ...both, canPropose: false, canExecute: false };
/** A proposal on chain, submitted `ageDays` before NOW. */
const onChain = (id: number, status: DaoProposal["status"], { kind = daoKind(HASH) as unknown, ageDays = 1 } = {}): DaoProposal =>
  ({ id, kind, status, submission_time: String(BigInt(NOW) * 1_000_000n - BigInt(ageDays) * DAY_NS) });

test("nothing filed yet: a member who may vote too gets the stored file-and-vote while the DAO's next number hasn't moved", () => {
  assert.deepEqual(offerFor(filed, { next: 59, proposals: [] }, policy, both, NOW), { state: "file", transaction: filed.transactions.proposalAndVote });
});

test("once another proposal took the number, the stored vote would be refused whole: the member gets the plain filing", () => {
  const read = { next: 60, proposals: [onChain(59, "InProgress", { kind: { Transfer: {} } })] };
  assert.deepEqual(offerFor(filed, read, policy, both, NOW), { state: "file", transaction: filed.transactions.proposal });
});

test("a member who may file but not vote (Trezu's Requestor) gets the plain filing; one who may not file gets none", () => {
  const read = { next: 59, proposals: [] };
  assert.deepEqual(offerFor(filed, read, policy, requestor, NOW), { state: "file", transaction: filed.transactions.proposal });
  assert.deepEqual(offerFor(filed, read, policy, approver, NOW), { state: "file", transaction: null });
  assert.deepEqual(offerFor({ ...filed, transactions: { ...filed.transactions, proposalAndVote: null } }, read, policy, both, NOW),
    { state: "file", transaction: filed.transactions.proposal }, "no stored vote when the platform couldn't read the number");
});

test("an open proposal of exactly the filed kind: vote on it in Trezu, and file nothing, whoever asks", () => {
  const read = { next: 61, proposals: [onChain(59, "InProgress", { kind: { Transfer: {} } }), onChain(60, "InProgress")] };
  for (const access of [both, requestor, approver]) {
    assert.deepEqual(offerFor(filed, read, policy, access, NOW), { state: "filed", proposal: 60, vote: voteLink(DAO, 60) });
  }
  assert.equal(voteLink(DAO, 60), "https://trezu.app/agentic.sputnik-dao.near/requests/60");
});

test("a proposal is matched by its kind, never its description: one quoting the hash with another action doesn't count", () => {
  const other = { FunctionCall: { receiver_id: "v1.signer", actions: [{ method_name: "sign", args: Buffer.from(JSON.stringify({ request: { path: "agent-owner", payload_v2: { Eddsa: "cd".repeat(32) }, domain_id: 1 } })).toString("base64"), deposit: "1", gas: "50000000000000" }] } };
  const read = { next: 61, proposals: [{ ...onChain(59, "InProgress", { kind: other }), description: `* Signs: NEP-413 hash ${HASH}` }, onChain(60, "InProgress", { kind: { Transfer: { receiver_id: "x.near" } } })] };
  assert.deepEqual(offerFor(filed, read, policy, both, NOW), { state: "file", transaction: filed.transactions.proposal });
});

test("the same kind under keys in another order still matches: kinds compare as canonical JSON", () => {
  const { FunctionCall: { receiver_id, actions } } = daoKind(HASH);
  const read = { next: 60, proposals: [onChain(59, "InProgress", { kind: { FunctionCall: { actions, receiver_id } } })] };
  assert.equal(offerFor(filed, read, policy, both, NOW).state, "filed");
});

test("a proposal numbered before the filing isn't this request's, even with the same kind", () => {
  const read = { next: 60, proposals: [onChain(58, "InProgress"), onChain(59, "InProgress", { kind: { Transfer: {} } })] };
  assert.equal(offerFor(filed, read, policy, both, NOW).state, "file");
});

test("approved: waiting for the server's read; failed: finalize again in Trezu", () => {
  assert.deepEqual(offerFor(filed, { next: 60, proposals: [onChain(59, "Approved")] }, policy, both, NOW), { state: "approved", proposal: 59, vote: voteLink(DAO, 59) });
  assert.deepEqual(offerFor(filed, { next: 60, proposals: [onChain(59, "Failed")] }, policy, both, NOW), { state: "failed", proposal: 59, vote: voteLink(DAO, 59) });
});

test("rejected, expired, or open past its period: the DAO's answer, and nothing filed again unasked", () => {
  for (const [status, ageDays, outcome] of [["Rejected", 1, "Rejected"], ["Expired", 8, "Expired"], ["InProgress", 8, "Expired"], ["Moved", 1, "Moved"]] as const) {
    assert.deepEqual(offerFor(filed, { next: 60, proposals: [onChain(59, status, { ageDays })] }, policy, both, NOW),
      { state: "ended", proposal: 59, vote: voteLink(DAO, 59), outcome }, `${status} after ${ageDays} days`);
  }
});

test("of several matches, the one that can still complete the request decides: open, then approved, then failed, then the latest ended", () => {
  const offer = (...proposals: DaoProposal[]) => offerFor(filed, { next: 70, proposals }, policy, both, NOW);
  assert.equal((offer(onChain(59, "Rejected"), onChain(60, "InProgress")) as { proposal: number }).proposal, 60);
  assert.equal(offer(onChain(59, "Failed"), onChain(60, "Approved")).state, "approved");
  assert.equal(offer(onChain(59, "Rejected"), onChain(60, "Failed")).state, "failed");
  assert.deepEqual(offer(onChain(59, "Rejected"), onChain(60, "Expired", { ageDays: 9 })), { state: "ended", proposal: 60, vote: voteLink(DAO, 60), outcome: "Expired" });
});

test("the stored vote fits only while the DAO's next number is the one the platform wrote into it, whatever the server read before filing", () => {
  // The platform read the DAO's next number after the server did: a proposal landed in between, so its vote names 60.
  const later: Filed = { ...filed, transactions: { ...filed.transactions, proposalAndVote: daoTransaction(DAO, HASH, 60) } };
  assert.deepEqual(offerFor(later, { next: 60, proposals: [onChain(59, "InProgress", { kind: { Transfer: {} } })] }, policy, both, NOW),
    { state: "file", transaction: later.transactions.proposalAndVote }, "it still fits: 60 is next");
  // The platform's read was behind the server's: its vote names 58, which is already taken, so it would revert every time.
  const behind: Filed = { ...filed, transactions: { ...filed.transactions, proposalAndVote: daoTransaction(DAO, HASH, 58) } };
  assert.deepEqual(offerFor(behind, { next: 59, proposals: [] }, policy, both, NOW), { state: "file", transaction: behind.transactions.proposal });
});
