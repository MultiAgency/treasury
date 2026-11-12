import { test } from "node:test";
import assert from "node:assert/strict";
import { chainDaos, memberAccess, type ChainView, type Policy } from "../src/dao.ts";

const DAO = "agentic.sputnik-dao.near";
const policy = (members: string[]): Policy => ({
  proposal_bond: "1", proposal_period: "604800000000000", default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "council", kind: { Group: members }, permissions: ["call:AddProposal", "call:VoteApprove"], vote_policy: {} }],
});
const proposal = (id: number) => ({ id, proposer: "a.near", description: "", kind: { FunctionCall: {} }, status: "InProgress", submission_time: "1", vote_counts: {}, votes: {} });

/** A chain whose answers are queued per method: a value, an Error to throw, or "hang" to never answer. */
function chain(answers: Record<string, (unknown | Error | "hang")[]>) {
  const asked: string[] = [];
  const view: ChainView = {
    async view(contractId, methodName, args, options) {
      asked.push(`${contractId} ${methodName} ${JSON.stringify(args)} ${options.finality}`);
      const answer = answers[methodName]?.shift();
      if (answer === "hang") return new Promise(() => {});
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { view, asked };
}
const daos = (view: ChainView, options: { now?: () => number; timeoutMs?: number } = {}) =>
  chainDaos({ rpcUrl: "http://chain.test", apiKey: undefined, timeoutMs: options.timeoutMs ?? 1_000, view, ...(options.now && { now: options.now }) });

test("the policy is the DAO's get_policy view at final finality, reused for a minute, then read again", async () => {
  const clock = { now: 0 }, { view, asked } = chain({ get_policy: [policy(["a.near"]), policy(["b.near"])] });
  const read = daos(view, { now: () => clock.now });
  const group = async () => ((await read.policy(DAO)) as Policy).roles[0]!.kind;
  assert.deepEqual(await group(), { Group: ["a.near"] });
  clock.now = 59_999;
  assert.deepEqual(await group(), { Group: ["a.near"] }, "reused within the minute");
  clock.now = 60_000;
  assert.deepEqual(await group(), { Group: ["b.near"] }, "a removed member is gone after it");
  assert.deepEqual(asked, [`${DAO} get_policy {} final`, `${DAO} get_policy {} final`]);
});

test("a failed read is unavailable and never reused: the next read asks the chain again", async () => {
  const { view, asked } = chain({ get_policy: [new Error("network"), policy(["a.near"])] });
  const read = daos(view);
  assert.equal(await read.policy(DAO), "unavailable");
  assert.notEqual(await read.policy(DAO), "unavailable");
  assert.equal(asked.length, 2);
});

test("an answer that isn't a policy is unavailable, never an admission", async () => {
  const { proposal_period: _period, ...noPeriod } = policy(["a.near"]);
  for (const answer of [undefined, null, "policy", { roles: "everyone" }, noPeriod,
    { ...policy(["a.near"]), roles: [{ name: "x", kind: { Group: "a.near" }, permissions: [], vote_policy: {} }] }]) {
    assert.equal(await daos(chain({ get_policy: [answer] }).view).policy(DAO), "unavailable", JSON.stringify(answer));
  }
});

test("a chain that doesn't answer in time is unavailable", async () => {
  assert.equal(await daos(chain({ get_policy: ["hang"] }).view, { timeoutMs: 10 }).policy(DAO), "unavailable");
});

test("reads that miss together share one call", async () => {
  const { view, asked } = chain({ get_policy: [policy(["a.near"])] });
  const read = daos(view);
  const [first, second] = await Promise.all([read.policy(DAO), read.policy(DAO)]);
  assert.deepEqual(first, second);
  assert.equal(asked.length, 1);
});

test("proposals are read from a number up to the DAO's next one, at most 100, and reused for a few seconds", async () => {
  const clock = { now: 0 };
  const { view, asked } = chain({ get_last_proposal_id: [62, 63], get_proposals: [[proposal(59), proposal(60), proposal(61)], [proposal(59)]] });
  const read = daos(view, { now: () => clock.now });
  assert.deepEqual(await read.proposals(DAO, 59), { next: 62, proposals: [proposal(59), proposal(60), proposal(61)] });
  clock.now = 4_999;
  assert.equal(((await read.proposals(DAO, 59)) as { next: number }).next, 62, "reused");
  clock.now = 5_000;
  assert.equal(((await read.proposals(DAO, 59)) as { next: number }).next, 63, "read again");
  assert.deepEqual(asked, [`${DAO} get_last_proposal_id {} final`, `${DAO} get_proposals {"from_index":59,"limit":3} final`,
    `${DAO} get_last_proposal_id {} final`, `${DAO} get_proposals {"from_index":59,"limit":4} final`]);
});

test("from the DAO's next number there's nothing to read; more than 100 since are read a page of 100 at a time", async () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => proposal(from + i));
  const { view, asked } = chain({ get_last_proposal_id: [62, 260], get_proposals: [page(10, 100), page(110, 100), page(210, 50)] });
  const read = daos(view);
  assert.deepEqual(await read.proposals(DAO, 62), { next: 62, proposals: [] });
  const busy = await read.proposals(DAO, 10);
  assert.deepEqual(busy !== "unavailable" && [busy.next, busy.proposals.length, busy.proposals.at(-1)!.id], [260, 250, 259], "a proposal filed 120 after is found");
  assert.deepEqual(asked.slice(2), [`${DAO} get_proposals {"from_index":10,"limit":100} final`, `${DAO} get_proposals {"from_index":110,"limit":100} final`,
    `${DAO} get_proposals {"from_index":210,"limit":50} final`]);
});

test("at most 1,000 proposals are read from a number, so one DAO can't make a read unbounded", async () => {
  const { view, asked } = chain({ get_last_proposal_id: [5_000], get_proposals: Array.from({ length: 10 }, () => [proposal(0)]) });
  await daos(view).proposals(DAO, 0);
  assert.equal(asked.filter(line => line.includes("get_proposals")).length, 10);
});

test("proposals that can't be read, or aren't Sputnik's, are unavailable", async () => {
  for (const answers of [{ get_last_proposal_id: [new Error("network")] } as Record<string, unknown[]>, { get_last_proposal_id: ["62"] },
    { get_last_proposal_id: [62], get_proposals: [[{ ...proposal(60), status: "Pending" }]] }, { get_last_proposal_id: [62], get_proposals: [new Error("network")] }]) {
    assert.equal(await daos(chain(answers).view).proposals(DAO, 60), "unavailable", JSON.stringify(answers));
  }
});

test("a member's access is the platform's reading of the DAO's roles; an account no Group names has none", () => {
  const read = policy(["a.near"]);
  assert.deepEqual(memberAccess("a.near", DAO, read), { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: false });
  assert.equal(memberAccess("b.near", DAO, read), null);
  assert.equal(memberAccess(DAO, DAO, read), null, "the DAO's own account isn't a member");
});

test("Sputnik votes survive parsing; a malformed votes record makes the read unavailable", async () => {
  const votes = { "b.near": "Reject", "a.near": "Approve", "c.near": "Remove" };
  const parsed = await daos(chain({ get_last_proposal_id: [1], get_proposals: [[{ ...proposal(0), votes }]] }).view).proposals(DAO, 0);
  assert.notEqual(parsed, "unavailable");
  if (parsed !== "unavailable") assert.deepEqual(parsed.proposals[0]!.votes, votes);
  for (const votes of [null, [], { "a.near": 1 }]) {
    assert.equal(await daos(chain({ get_last_proposal_id: [1], get_proposals: [[{ ...proposal(0), votes }]] }).view).proposals(DAO, 0), "unavailable");
  }
});
