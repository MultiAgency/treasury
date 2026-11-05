import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import { createDaoReader, runDaoReader, type ReadEvent } from "../src/dao-reader.ts";
import { createDaoRequests, type StoredDaoRequest } from "../src/dao-requests.ts";
import { createSettle } from "../src/dao-settle.ts";
import { daoTransaction, fakePlatform, proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const DAO = "agentic.sputnik-dao.near", ORG = "agentic--sputnik-dao--near";

/** A platform with one DAO-owned agent, its consent request filed, and votes on two of its proposals filed. */
async function world() {
  const fake = fakePlatform({ "dao-treasury": DAO }, { daos: ["dao-treasury"] });
  const daoRequests = await createDaoRequests(join(tempDir("treasury-dao-reader-"), "dao-requests.json"));
  const audited: AuditEntry[] = [];
  const store = async (filed: { ok: boolean; value?: { request: { id: string; description: string; votingUntil: number } } }, rest: Partial<StoredDaoRequest>) => {
    const { request } = (filed as { value: { request: { id: string; description: string; votingUntil: number } } }).value;
    const record = { organization: ORG, agent: "dao-treasury", id: request.id, description: request.description, votingUntil: request.votingUntil,
      filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, request.id), proposalAndVote: null } }, ...rest } as StoredDaoRequest;
    await daoRequests.add(record);
    return record;
  };
  const consentText = JSON.stringify({ type: "multiagency.app-consent", version: 1, host: "platform.test", deployment: "treasury", organization: ORG,
    owner: DAO, agent: "dao-treasury", agentId: "id-dao-treasury", scopes: ["read", "treasury"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const consent = await store(await fake.platform.daoConsents.file(consentText), { kind: "consent", agentId: "id-dao-treasury" });
  const votes = [];
  for (const id of ["1".repeat(32), "2".repeat(32)]) {
    fake.proposals.push({ ...proposal({ id, organization: ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" });
    votes.push(await store(await fake.platform.daoVotes.file({ organization: ORG, agent: "dao-treasury", proposal: id, verdict: "approve" }), { kind: "vote", proposal: id, verdict: "approve" }));
  }
  const settle = createSettle({ platform: fake.platform, daoRequests, audit: { append: async (entry: AuditEntry) => { audited.push(entry); } } });
  return { fake, daoRequests, audited, consent, votes, deps: { daoRequests, settle } };
}

/** Each request's result in a pass, by its ID. */
const resultOf = (events: ReadEvent[]) => Object.fromEntries(events.map(event => [event.request, "result" in event ? event.result : `failed: ${event.failed}`]));

test("one pass reads every open request once: a passed vote is relayed and a passed consent stored, both closed; the rest stay open", async () => {
  const { fake, daoRequests, audited, consent, votes, deps } = await world();
  fake.daoRequests[0]!.signed = true;
  fake.daoVotes[0]!.passed = true;
  fake.calls.length = 0;
  const events = await createDaoReader(deps, { limit: 10 }).pass();
  assert.deepEqual(resultOf(events), { [consent.id]: "stored", [votes[0]!.id]: "relayed", [votes[1]!.id]: "pending" });
  assert.equal(fake.calls.filter(made => made.includes(".state")).length, 3, "each read once");
  assert.deepEqual(daoRequests.open().map(open => open.id), [votes[1]!.id]);
  assert.equal(fake.proposals.find(item => item.id === "1".repeat(32))!.state, "approved");
  assert.deepEqual(audited.filter(entry => entry.action !== "revoke").map(entry => `${entry.who} ${entry.action}`).sort(), [`${DAO} dao-consent-stored`, `${DAO} dao-vote-relayed`]);
});

test("a request past its deadline is closed; a vote the platform can't relay for now stays for the next pass", async () => {
  const { fake, daoRequests, votes, deps } = await world();
  fake.daoVotes[0]!.ended = 410;
  fake.daoVotes[1]!.ended = 409;
  const events = await createDaoReader(deps, { limit: 10 }).pass();
  assert.deepEqual([resultOf(events)[votes[0]!.id], resultOf(events)[votes[1]!.id]], ["ended", "pending"]);
  assert.ok(!daoRequests.open().some(open => open.id === votes[0]!.id));
  assert.ok(daoRequests.open().some(open => open.id === votes[1]!.id));
});

test("a pass reads at most its limit, the requests soonest to expire first, so the reads stay within the shared quota", async () => {
  const { fake, consent, votes, deps } = await world();
  // The consent's vote may take the DAO's whole period; the second proposal's vote must pass first.
  const soonest = [votes[1]!, votes[0]!, consent].sort((a, b) => a.votingUntil - b.votingUntil);
  fake.calls.length = 0;
  const events = await createDaoReader(deps, { limit: 2 }).pass();
  assert.deepEqual(events.map(event => event.request), soonest.slice(0, 2).map(request => request.id));
  assert.equal(fake.calls.filter(made => made.includes(".state")).length, 2);
});

test("passes rotate: requests still waiting don't hold every slot, so each open request is read within a few passes", async () => {
  const { fake, deps } = await world();
  // Two more votes, so four requests are open, read two a pass.
  for (const id of ["3".repeat(32), "4".repeat(32)]) {
    fake.proposals.push({ ...proposal({ id, organization: ORG, agentId: "id-dao-treasury" }), agent: "dao-treasury" });
    const filed = await fake.platform.daoVotes.file({ organization: ORG, agent: "dao-treasury", proposal: id, verdict: "approve" });
    const { request } = (filed as { value: { request: { id: string; description: string; votingUntil: number } } }).value;
    await deps.daoRequests.add({ kind: "vote", proposal: id, verdict: "approve", organization: ORG, agent: "dao-treasury", id: request.id,
      description: "", votingUntil: request.votingUntil, filed: { dao: DAO, next: 0, transactions: { proposal: daoTransaction(DAO, request.id), proposalAndVote: null } } });
  }
  const reader = createDaoReader(deps, { limit: 2 });
  const first = (await reader.pass()).map(event => event.request), second = (await reader.pass()).map(event => event.request);
  assert.equal(new Set([...first, ...second]).size, 4, "two passes read all four, none twice");
});

test("a read that throws is reported and the pass goes on; the request stays open", async t => {
  const { fake, daoRequests, consent, deps } = await world();
  t.mock.method(fake.platform.daoConsents, "state", async () => { throw new Error("socket hang up"); });
  const events = await createDaoReader(deps, { limit: 10 }).pass();
  assert.deepEqual(events.find(event => event.request === consent.id), { request: consent.id, kind: "consent", agent: "dao-treasury", failed: "socket hang up" });
  assert.equal(events.length, 3, "the votes are still read");
  assert.ok(daoRequests.open().some(open => open.id === consent.id));
});

test("the reader passes on its interval until shutdown; a pass in flight finishes, and none starts after", async () => {
  const controller = new AbortController(), logged: ReadEvent[] = [], slept: number[] = [];
  let passes = 0;
  await runDaoReader({
    read: async () => { passes++; if (passes === 2) controller.abort(); return [{ request: `r${passes}`, kind: "vote", agent: "a", result: "pending" }]; },
    everyMs: 60_000, log: event => logged.push(event), sleep: async ms => { slept.push(ms); }, signal: controller.signal,
  });
  assert.equal(passes, 2);
  assert.deepEqual(logged.map(event => event.request), ["r1", "r2"], "the pass in flight at shutdown is logged");
  assert.deepEqual(slept, [60_000]);
});
