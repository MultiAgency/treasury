import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaoPolicy } from "@multiagency/sdk";
import { cachedPolicyReader, chainPolicyReader, checkUrlOf, createDaoRequests, memberAccess, type DaoRequest, type PolicyRead } from "../src/dao.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const policy: DaoPolicy = {
  proposal_bond: "1", default_vote_policy: { threshold: [1, 2] },
  roles: [
    { name: "all", kind: "Everyone", permissions: ["call:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: ["voter.near"] }, permissions: ["call:VoteApprove", "policy:*"], vote_policy: { call: { threshold: [1, 2] } } },
    { name: "holders", kind: { Member: "1" }, permissions: ["*:*"], vote_policy: {} },
  ],
};

test("a member's access is the SDK's reading of the DAO's roles; anyone outside its Groups is no member, whatever Everyone may do", () => {
  assert.deepEqual(memberAccess("voter.near", "dao.near", policy), { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: true });
  assert.equal(memberAccess("passer-by.near", "dao.near", policy), null, "Everyone's rights admit no one");
  assert.equal(memberAccess("dao.near", "dao.near", policy), null, "the DAO's own account isn't its member");
});

test("the policy is read with get_policy from the DAO's account; an unreadable, odd or slow answer is unavailable, never an empty policy", async () => {
  const asked: unknown[] = [];
  assert.deepEqual(await chainPolicyReader({ rpcUrl: "https://rpc.test", apiKey: undefined, timeoutMs: 50, view: async (...args) => { asked.push(args); return policy; } })("dao.near"), policy);
  assert.deepEqual(asked, [["dao.near", "get_policy", {}]]);
  for (const [label, view] of [
    ["thrown", async () => { throw new Error("no such account"); }],
    ["not a policy", async () => ({ roles: "everyone" })],
    ["nothing", async () => undefined],
    ["too slow", () => new Promise(resolve => setTimeout(() => resolve(policy), 200))],
  ] as const) assert.equal(await chainPolicyReader({ rpcUrl: "https://rpc.test", apiKey: undefined, timeoutMs: 50, view })("dao.near"), "unavailable", label);
});

test("a policy is reused for a minute per DAO, and an unavailable read never is", async () => {
  const clock = { now: 0 }, reads: string[] = [];
  let answer: PolicyRead = "unavailable";
  const read = cachedPolicyReader(async dao => { reads.push(dao); return answer; }, { now: () => clock.now });
  assert.equal(await read("dao.near"), "unavailable");
  answer = policy;
  assert.deepEqual(await read("dao.near"), policy, "a failure isn't kept");
  clock.now += 59_999;
  await read("dao.near");
  await read("other.near");
  assert.deepEqual(reads, ["dao.near", "dao.near", "other.near"], "within the minute, the DAO's policy isn't read again");
  clock.now += 1;
  await read("dao.near");
  assert.equal(reads.length, 4, "after the minute, it is");
});

const request = (change: Partial<DaoRequest> = {}): DaoRequest => ({
  kind: "vote", organization: "dao--near", agent: "portfolio", proposal: "a".repeat(32), verdict: "approve", id: "r1", hash: "h1",
  description: "d", votingUntil: 1, transactions: { proposal: { receiverId: "dao.near", actions: [{ type: "FunctionCall", params: { methodName: "add_proposal" } }] }, proposalAndVote: null },
  ...change,
});

test("DAO requests kept in a file survive a restart, are found by agent and proposal, and are forgotten once final", async () => {
  const file = join(tempDir("dao-requests-"), "dao-requests.json");
  const kept = await createDaoRequests(file);
  assert.equal(await kept.add(request()), true);
  assert.equal(await kept.add(request({ id: "r2", kind: "consent", proposal: null, verdict: null })), true);
  const again = await createDaoRequests(file);
  assert.equal(again.open("vote", "dao--near", "portfolio", "a".repeat(32))?.id, "r1");
  assert.equal(again.open("vote", "dao--near", "portfolio", "b".repeat(32)), undefined, "another proposal's vote isn't this one's");
  assert.equal(again.open("consent", "dao--near", "portfolio")?.id, "r2");
  await again.drop(request());
  assert.equal((await createDaoRequests(file)).open("vote", "dao--near", "portfolio", "a".repeat(32)), undefined);
});

test("DAO requests are bounded, and a file others can read, or one that isn't theirs, is refused at startup", async () => {
  const bounded = await createDaoRequests(undefined, { max: 1 });
  assert.equal(await bounded.add(request()), true);
  assert.equal(await bounded.add(request({ id: "r2" })), false, "the platform files at most 256 a day; this keeps no more than max");
  const dir = tempDir("dao-requests-");
  writeFileSync(join(dir, "open"), JSON.stringify({ version: 1, requests: [] }));
  chmodSync(join(dir, "open"), 0o644);
  await assert.rejects(createDaoRequests(join(dir, "open")), /0600/);
  writeFileSync(join(dir, "other"), "{}", { mode: 0o600 });
  await assert.rejects(createDaoRequests(join(dir, "other")), /DAO requests/);
});

test("the voter check link is the platform's own page for the request's hash", () => {
  assert.equal(checkUrlOf("platform.test", "abc/def"), "https://platform.test/confirm/dao/abc%2Fdef");
});
