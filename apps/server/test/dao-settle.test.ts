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
