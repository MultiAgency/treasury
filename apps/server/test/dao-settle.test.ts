import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { createSettle } from "../src/dao-settle.ts";
import { daoTransaction, fakePlatform, proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const DAO = "agentic.sputnik-dao.near", ORG = "agentic--sputnik-dao--near";

test("reads of the same request at once share one: the vote is relayed and recorded once, whoever asked", async () => {
  const fake = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const daoRequests = await createDaoRequests(join(tempDir("treasury-dao-settle-"), "dao-requests.json"));
  const audited: AuditEntry[] = [];
  fake.proposals.push({ ...proposal({ id: "1".repeat(32), organization: ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" });
  const filed = await fake.platform.daoVotes.file({ organization: ORG, agent: "dao-treasury", proposal: "1".repeat(32), verdict: "approve" });
  assert.ok(filed.ok);
  const open = { kind: "vote" as const, organization: ORG, agent: "dao-treasury", id: filed.value.request.id, description: "", votingUntil: Date.now() + 60_000,
    proposal: "1".repeat(32), verdict: "approve" as const, filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, filed.value.request.id), proposalAndVote: null } } };
  await daoRequests.add(open);
  fake.daoVotes[0]!.passed = true;
  const settle = createSettle({ platform: fake.platform, daoRequests, audit: { append: async entry => { audited.push(entry); } } });
  const [first, second, third] = await Promise.all([settle(open), settle(open), settle(open)]);
  assert.deepEqual([first, second, third].map(read => read.result), ["relayed", "relayed", "relayed"]);
  assert.equal(fake.calls.filter(made => made.startsWith("daoVotes.state")).length, 1, "one platform read");
  assert.equal(audited.filter(entry => entry.action === "dao-vote-relayed").length, 1, "recorded once");
  // Once it's finished, a new read is a new read.
  await settle(open);
  assert.equal(fake.calls.filter(made => made.startsWith("daoVotes.state")).length, 2);
});

test("a consent request's 409 is a stop only while the agent is still the DAO's with the identity it named; otherwise the agent changed; unread, it stays open", async () => {
  const owners: Record<string, string> = { "dao-treasury": DAO };
  const failing: Record<string, { ok: false; kind: "unavailable" }> = {};
  const fake = fakePlatform(owners, { daos: ["dao-treasury"], failing });
  const daoRequests = await createDaoRequests(join(tempDir("treasury-dao-settle-"), "dao-requests.json"));
  const settle = createSettle({ platform: fake.platform, daoRequests, audit: { append: async () => {} } });
  const consentText = JSON.stringify({ type: "multiagency.app-consent", version: 1, host: "platform.test", deployment: "treasury", organization: ORG,
    owner: DAO, agent: "dao-treasury", agentId: "id-dao-treasury", scopes: ["read", "treasury"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const open = async (agentId = "id-dao-treasury") => {
    const filed = await fake.platform.daoConsents.file(consentText);
    assert.ok(filed.ok);
    fake.daoRequests.at(-1)!.ended = 409;
    const request = { kind: "consent" as const, organization: ORG, agent: "dao-treasury", agentId, id: filed.value.request.id, description: "", votingUntil: Date.now() + 60_000,
      filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, filed.value.request.id), proposalAndVote: null } } };
    await daoRequests.add(request);
    return request;
  };
  const cases: [string, () => void, string, Awaited<ReturnType<typeof settle>>][] = [
    ["the same DAO and identity", () => {}, "id-dao-treasury", { result: "ended", why: "stopped" }],
    ["created again with another identity", () => {}, "id-before", { result: "ended", why: "changed" }],
    ["owned by someone else now", () => { owners["dao-treasury"] = "someone.near"; }, "id-dao-treasury", { result: "ended", why: "changed" }],
    ["gone", () => { delete owners["dao-treasury"]; }, "id-dao-treasury", { result: "ended", why: "changed" }],
  ];
  for (const [name, change, agentId, expected] of cases) {
    owners["dao-treasury"] = DAO;
    const request = await open(agentId);
    change();
    assert.deepEqual(await settle(request), expected, name);
    assert.equal(daoRequests.consent(ORG, "dao-treasury"), undefined, name);
    assert.equal(daoRequests.ended(ORG, "dao-treasury"), expected.result === "ended" ? expected.why : undefined, name);
  }
  // The agent can't be read now: nothing tells the two apart, so the request stays open and is read again.
  owners["dao-treasury"] = DAO;
  failing["dao-treasury"] = { ok: false, kind: "unavailable" };
  const unread = await open();
  assert.deepEqual(await settle(unread), { result: "pending" });
  assert.equal(daoRequests.consent(ORG, "dao-treasury")?.id, unread.id);
});

test("a passed vote ends once the platform says its proposal isn't open; refused for now, it stays open and is read again", async () => {
  const fake = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const daoRequests = await createDaoRequests(join(tempDir("treasury-dao-settle-"), "dao-requests.json"));
  const audited: AuditEntry[] = [];
  const settle = createSettle({ platform: fake.platform, daoRequests, audit: { append: async entry => { audited.push(entry); } } });
  const open = async (id: string, state: string) => {
    const made = { ...proposal({ id, organization: ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" };
    fake.proposals.push(made);
    const filed = await fake.platform.daoVotes.file({ organization: ORG, agent: "dao-treasury", proposal: id, verdict: "approve" });
    assert.ok(filed.ok);
    made.state = state as typeof made.state;
    const request = { kind: "vote" as const, organization: ORG, agent: "dao-treasury", id: filed.value.request.id, description: "", votingUntil: Date.now() + 60_000,
      proposal: id, verdict: "approve" as const, filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, filed.value.request.id), proposalAndVote: null } } };
    await daoRequests.add(request);
    fake.daoVotes.at(-1)!.passed = true;
    return request;
  };

  // Invalidated while the DAO voted (the owner's strategy changed): the agent will never take it.
  const invalidated = await open("2".repeat(32), "invalidated");
  assert.deepEqual(await settle(invalidated), { result: "ended", why: "closed" });
  assert.equal(daoRequests.vote(ORG, "dao-treasury", invalidated.proposal), undefined, "closed");
  assert.equal(audited.filter(entry => entry.action === "dao-vote-relayed").length, 0, "nothing was relayed");

  // The agent refuses for now (`agent_refused`): read again.
  const refusedForNow = await open("3".repeat(32), "proposed");
  fake.daoVotes.at(-1)!.ended = 409;
  assert.deepEqual(await settle(refusedForNow), { result: "pending" });
  assert.equal(daoRequests.vote(ORG, "dao-treasury", refusedForNow.proposal)?.id, refusedForNow.id);
});
