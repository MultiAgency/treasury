import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createDaoRequests, type StoredDaoRequest } from "../src/dao-requests.ts";
import { daoTransaction } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const scratch = () => join(tempDir("treasury-dao-requests-"), "dao-requests.json");
const DAO = "agentic.sputnik-dao.near";
const request = (agent: string, id = "ab".repeat(32)): StoredDaoRequest => ({
  kind: "consent", organization: "agentic--sputnik-dao--near", agent, agentId: `id-${agent}`, id, description: "* Signs", votingUntil: 1,
  filed: { dao: DAO, next: 59, transactions: { proposal: daoTransaction(DAO, id), proposalAndVote: daoTransaction(DAO, id, 59) } },
});

test("a request is on disk before add returns, transactions and all, and read back as stored", async () => {
  const file = scratch(), requests = await createDaoRequests(file);
  assert.equal(await requests.add(request("dao-treasury")), true);
  const reloaded = await createDaoRequests(file);
  assert.deepEqual(reloaded.consent("agentic--sputnik-dao--near", "dao-treasury"), request("dao-treasury"));
  assert.deepEqual(reloaded.open(), [request("dao-treasury")]);
});

test("one consent request is open per agent: a second for the same agent stores nothing", async () => {
  const requests = await createDaoRequests(scratch());
  assert.equal(await requests.add(request("dao-treasury")), true);
  assert.equal(await requests.add(request("dao-treasury", "cd".repeat(32))), false);
  assert.equal(await requests.add(request("other", "cd".repeat(32))), true);
  assert.equal(requests.open().length, 2);
});

const vote = (proposal: string, id: string, verdict: "approve" | "reject" = "approve"): StoredDaoRequest => {
  const { agentId: _agentId, ...common } = request("dao-treasury", id) as Extract<StoredDaoRequest, { kind: "consent" }>;
  return { ...common, kind: "vote", proposal, verdict };
};

test("one vote is open per proposal, whatever its verdict, beside the agent's consent request", async () => {
  const file = scratch(), requests = await createDaoRequests(file);
  assert.equal(await requests.add(request("dao-treasury")), true);
  assert.equal(await requests.add(vote("1".repeat(32), "cd".repeat(32))), true, "a vote beside the open consent request");
  assert.equal(await requests.add(vote("1".repeat(32), "ef".repeat(32), "reject")), false, "an opposite vote on the same proposal would race it");
  assert.equal(await requests.add(vote("2".repeat(32), "ef".repeat(32))), true);
  const reloaded = await createDaoRequests(file);
  assert.equal(reloaded.vote("agentic--sputnik-dao--near", "dao-treasury", "1".repeat(32))?.id, "cd".repeat(32));
  assert.equal(reloaded.vote("agentic--sputnik-dao--near", "dao-treasury", "3".repeat(32)), undefined);
  assert.equal(reloaded.consent("agentic--sputnik-dao--near", "dao-treasury")?.id, "ab".repeat(32));
});

test("closing forgets the request, on disk too, and frees the agent for a new one", async () => {
  const file = scratch(), requests = await createDaoRequests(file);
  await requests.add(request("dao-treasury"));
  await requests.close("ab".repeat(32));
  assert.equal((await createDaoRequests(file)).consent("agentic--sputnik-dao--near", "dao-treasury"), undefined);
  assert.equal(await requests.add(request("dao-treasury", "cd".repeat(32))), true);
});

test("at most max are kept", async () => {
  const requests = await createDaoRequests(scratch(), { max: 1 });
  assert.equal(await requests.add(request("a")), true);
  assert.equal(await requests.add(request("b", "cd".repeat(32))), false);
});

test("a file others can read, or one that isn't these records, is refused at startup", async () => {
  const open = scratch();
  await writeFile(open, JSON.stringify({ version: 1, requests: [] }));
  await chmod(open, 0o644);
  await assert.rejects(createDaoRequests(open), /readable by others/);
  const wrong = scratch();
  // A vote without the proposal it's on.
  await writeFile(wrong, JSON.stringify({ version: 1, requests: [{ ...request("a"), kind: "vote" }] }), { mode: 0o600 });
  await assert.rejects(createDaoRequests(wrong), /doesn't hold the DAO requests/);
});

test("one setup is open per Organization, beside its agents' consent requests and votes", async () => {
  const file = scratch(), requests = await createDaoRequests(file);
  const setup = (id: string, organization = "agentic--sputnik-dao--near") => {
    const { agent: _agent, agentId: _agentId, kind: _kind, ...base } = request("dao-treasury", id) as Extract<StoredDaoRequest, { kind: "consent" }>;
    return { ...base, organization, kind: "setup" as const };
  };
  assert.equal(await requests.add(request("dao-treasury")), true);
  assert.equal(await requests.add(setup("12".repeat(32))), true, "a setup beside a consent request");
  assert.equal(await requests.add(setup("34".repeat(32))), false, "a second setup for the same Organization");
  assert.equal(await requests.add(setup("56".repeat(32), "other--sputnik-dao--near")), true, "another Organization's");
  const reloaded = await createDaoRequests(file);
  assert.equal(reloaded.setup("agentic--sputnik-dao--near")?.id, "12".repeat(32));
  await reloaded.close("12".repeat(32), "expired");
  assert.equal(reloaded.setupEnded("agentic--sputnik-dao--near"), "expired");
  assert.equal(reloaded.ended("agentic--sputnik-dao--near", "dao-treasury"), undefined, "a setup's ending isn't an agent's");
});
