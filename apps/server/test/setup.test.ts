import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { parseSetupMessage } from "@multiagency/sdk";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { standInDaos, type DaoProposal, type Policy } from "../src/dao.ts";
import { setupConsents } from "../src/setup.ts";
import { daoTransaction, fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), other = wallet("other.near"), lapsed = wallet("lapsed.near");
const council = wallet("council.near"), proposer = wallet("proposer.near"), reader = wallet("reader.near");
const DAO = "agentic.sputnik-dao.near";
const fake = fakePlatform({ "dao-new": DAO }, { daos: ["dao-new"], unborn: ["dao-new"] });
const audited: AuditEntry[] = [];
const policies: Record<string, Policy> = {
  [DAO]: {
    proposal_bond: "100000000000000000000000", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
    roles: [
      { name: "council", kind: { Group: ["council.near"] }, permissions: ["call:AddProposal", "call:VoteApprove", "call:VoteReject"], vote_policy: {} },
      { name: "proposers", kind: { Group: ["proposer.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
      { name: "readers", kind: { Group: ["reader.near"] }, permissions: [], vote_policy: {} },
    ],
  },
};
const chainProposals: Record<string, DaoProposal[]> = { [DAO]: [] };
let server: Server, base: string, signIn: Awaited<ReturnType<typeof testServer>>["signIn"];

before(async () => {
  ({ server, base, signIn } = await testServer({ platform: fake.platform, wallets: [owner, other, lapsed, council, proposer, reader], audited,
    daos: standInDaos(policies, chainProposals) }));
});
after(() => server.close());

const write = { origin: ORIGIN, "content-type": "application/json" };
const call = (method: string, path: string, { body, cookie }: { body?: unknown; cookie?: string } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(method === "GET" ? {} : write), ...(cookie && { cookie }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });
/** The setup text the server gives `who`, signed by their wallet for the platform's host. */
async function signedSetup(who: ReturnType<typeof wallet>, cookie: string, message?: (text: string) => string) {
  const { status, body } = await json(await call("POST", "/api/setup/text", { cookie, body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  const text = contract.consentText.parse(body.value);
  const signed = who.sign(text, { message: message?.(text.message) ?? text.message });
  return { text, submission: { message: message?.(text.message) ?? text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature } };
}
const clean = () => { fake.calls.length = 0; audited.length = 0; };
const shape = (entries: AuditEntry[]) => entries.map(entry => [entry.action, entry.stage, entry.who, entry.agent, entry.subject]);

test("an owner sets up their Treasury: the server's text for the platform's host, signed by their wallet, relayed once and recorded; the agent is listed", async () => {
  clean();
  const cookie = await signIn(owner);
  assert.deepEqual((await json(await call("GET", "/api/setup", { cookie }))).body, { ok: true, value: { account: "owner.near", agents: [] } });
  fake.calls.length = 0;
  const { text, submission } = await signedSetup(owner, cookie);
  assert.equal(text.recipient, "platform.test");
  const setup = parseSetupMessage(text.message)!;
  assert.deepEqual([setup.host, setup.deployment, setup.organization, setup.owner, setup.area], ["platform.test", "treasury", "owner--near", "owner.near", "treasury"]);
  assert.ok(Date.parse(setup.expiresAt) <= Date.now() + 60 * 60_000);
  const { status, body } = await json(await call("POST", "/api/setup", { cookie, body: submission }));
  assert.deepEqual([status, body], [200, { ok: true, value: { agent: "treasury-1" } }]);
  assert.deepEqual(fake.calls, ["setup"]);
  assert.deepEqual(shape(audited), [["setup", "attempt", "owner.near", undefined, undefined], ["setup", "result", "owner.near", "treasury-1", fake.consents.at(-1)!.id]]);
  assert.ok(audited[0]!.signedTextSha256);
  assert.deepEqual((await json(await call("GET", "/api/setup", { cookie }))).body, { ok: true, value: { account: "owner.near", agents: ["treasury-1"] } });
  // Another account's list doesn't show it.
  assert.deepEqual((await json(await call("GET", "/api/setup", { cookie: await signIn(other) }))).body, { ok: true, value: { account: "other.near", agents: [] } });
});

test("a setup that lapsed before its agent was created isn't listed, so the owner sets it up again; a created agent stays listed once its consents end", async t => {
  const cookie = await signIn(lapsed);
  const listed = async () => (await json(await call("GET", "/api/setup", { cookie }))).body.value.agents;
  const lapse = (agent: string) => { for (const consent of fake.consents.filter(consent => consent.agent === agent)) consent.expiresAt = Date.now() - 1; };
  await call("POST", "/api/setup", { cookie, body: (await signedSetup(lapsed, cookie)).submission });
  const agent = fake.reservations["lapsed.near"]!;
  assert.deepEqual(await listed(), [agent], "set up, within its hour");
  lapse(agent);
  assert.deepEqual(await listed(), [], "the setup lapsed and nothing was created");
  // Whether it was created can't be read just now: unavailable, never a guess either way.
  const unread = t.mock.method(fake.platform, "identity", async () => ({ answer: { ok: false, kind: "unavailable" }, cached: false }));
  t.mock.method(console, "error", () => {});
  const failed = await json(await call("GET", "/api/setup", { cookie }));
  assert.deepEqual([failed.status, failed.body], [503, { ok: false, kind: "unavailable" }]);
  unread.mock.restore();
  const again = await json(await call("POST", "/api/setup", { cookie, body: (await signedSetup(lapsed, cookie)).submission }));
  assert.deepEqual(again.body, { ok: true, value: { agent } }, "the platform finds the same reservation");
  assert.deepEqual(await listed(), [agent]);
  // Created, then its setup lapsed before the owner connected it: listed, to connect, never set up anew.
  fake.create(agent);
  lapse(agent);
  assert.deepEqual(await listed(), [agent]);
  // Connected, then the connection was revoked: listed, to connect again, without reading its identity.
  const connection = { ...fake.consents.find(consent => consent.agent === agent)!, id: "r".padEnd(64, "0"), agentId: `id-${agent}`, scopes: ["read" as const, "treasury" as const],
    expiresAt: Date.now() + 86_400_000, revoked: true, revokedAt: Date.now() };
  fake.consents.push(connection);
  fake.calls.length = 0;
  assert.deepEqual(await listed(), [agent]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("identity")), []);
});

test("a setup text other than the one the server asks for is refused before the platform sees it", async () => {
  const cookie = await signIn(other);
  const changes: Record<string, (message: string) => string> = {
    "another owner": message => message.replace('"owner":"other.near"', '"owner":"owner.near"'),
    "another area": message => message.replace('"area":"treasury"', '"area":"payables"'),
    "another host": message => message.replace('"host":"platform.test"', '"host":"elsewhere.test"'),
    "another deployment": message => message.replace('"deployment":"treasury"', '"deployment":"other"'),
    "a longer life": message => message.replace(/"expiresAt":"[^"]+"/, `"expiresAt":"${new Date(Date.now() + 2 * 60 * 60_000).toISOString()}"`),
  };
  for (const [name, change] of Object.entries(changes)) {
    clean();
    const { submission } = await signedSetup(other, cookie, change);
    assert.notEqual(submission.message, (await signedSetup(other, cookie)).submission.message, name);
    const { status, body } = await json(await call("POST", "/api/setup", { cookie, body: submission }));
    assert.deepEqual([status, body], [400, { ok: false, kind: "refused", code: "not_this_setup" }], name);
    assert.deepEqual(fake.calls, [], name);
  }
});

test("the platform's answers to a setup: already set up, unavailable on this host, refused; a lost answer is sent once more as is", async () => {
  const cookie = await signIn(other);
  const cases = [
    [[{ ok: false, kind: "refused", status: 409, error: "exists" }], 409, "already_set_up", 1],
    [[{ ok: false, kind: "forbidden", status: 403, error: "Agent setup isn't available on this host" }], 403, "setup_unavailable", 1],
    [[{ ok: false, kind: "refused", status: 400, error: "bad signature" }], 400, "setup_refused", 1],
    [[{ ok: false, kind: "unavailable" }, { ok: false, kind: "unavailable" }], 503, undefined, 2],
  ] as const;
  for (const [answers, status, code, calls] of cases) {
    clean();
    fake.setupAnswers.push(...(answers as unknown as never[]));
    const { submission } = await signedSetup(other, cookie);
    const reply = await json(await call("POST", "/api/setup", { cookie, body: submission }));
    assert.deepEqual([reply.status, reply.body], [status, code ? { ok: false, kind: "refused", code } : { ok: false, kind: "unavailable" }]);
    assert.equal(fake.calls.length, calls);
    assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["setup", "attempt"], ["setup", "result"]]);
  }
  // A lost answer, then the platform's: the same body went twice, and the agent is set up.
  clean();
  fake.setupAnswers.push({ ok: false, kind: "unavailable" });
  const { submission } = await signedSetup(other, cookie);
  const reply = await json(await call("POST", "/api/setup", { cookie, body: submission }));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.deepEqual(fake.calls, ["setup", "setup"]);
});

test("a thrown setup call is recorded and answers unavailable", async t => {
  clean();
  const cookie = await signIn(other);
  t.mock.method(fake.platform, "setup", async () => { throw new Error("socket hang up"); });
  const { submission } = await signedSetup(other, cookie);
  const reply = await json(await call("POST", "/api/setup", { cookie, body: submission }));
  assert.deepEqual([reply.status, reply.body], [503, { ok: false, kind: "unavailable" }]);
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["setup", "attempt"], ["setup", "result"]]);
});

test("creating the agent: under its setup consent, with the key that signed it, on the platform's confirm page; followed by its status until it's created", async () => {
  clean();
  const cookie = await signIn(owner);
  const agent = (await json(await call("GET", "/api/setup", { cookie }))).body.value.agents[0];
  const { status, body } = await json(await call("POST", `/api/agents/${agent}/creation`, { cookie, body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  const created = contract.creation.parse(body.value);
  assert.equal(created.confirm?.url, `https://platform.test/confirm/${created.correlationId}`);
  assert.equal(created.dao, undefined);
  assert.equal(fake.creations.at(-1)!.publicKey, owner.publicKey, "the key that signed the setup");
  assert.deepEqual(fake.calls.filter(made => made.startsWith("creation")), [`creation.prepare ${agent} wallet`]);
  assert.deepEqual(shape(audited), [["create", "attempt", "owner.near", agent, undefined], ["create", "result", "owner.near", agent, created.correlationId]]);
  const read = async () => json(await call("GET", `/api/agents/${agent}/creation/${created.correlationId}`, { cookie }));
  assert.deepEqual((await read()).body, { ok: true, value: { stage: "voting" } });
  fake.creations.at(-1)!.stage = "submitted";
  fake.create(agent);
  assert.deepEqual((await read()).body, { ok: true, value: { stage: "submitted" } });
  const again = await json(await call("POST", `/api/agents/${agent}/creation`, { cookie, body: {} }));
  assert.deepEqual([again.status, again.body], [409, { ok: false, kind: "refused", code: "already_created" }]);
  assert.deepEqual((await json(await call("GET", `/api/agents/${agent}/creation/unknown`, { cookie }))).status, 404);
});

test("creation without a live setup consent asks for the setup again; the platform's refusals and a thrown call are recorded", async t => {
  clean();
  const cookie = await signIn(other);
  const agent = fake.reservations["other.near"]!;
  for (const consent of fake.consents.filter(consent => consent.agent === agent)) consent.revoked = true;
  const refused = await json(await call("POST", `/api/agents/${agent}/creation`, { cookie, body: {} }));
  assert.deepEqual([refused.status, refused.body], [409, { ok: false, kind: "refused", code: "not_set_up" }]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("creation")), []);
  await call("POST", "/api/setup", { cookie, body: (await signedSetup(other, cookie)).submission });
  for (const [answer, status, body] of [
    [{ ok: false, kind: "forbidden", status: 403, error: "Create the agent with the key that signed the setup" }, 409, { ok: false, kind: "refused", code: "not_set_up" }],
    [new Error("socket hang up"), 503, { ok: false, kind: "unavailable" }],
  ] as const) {
    audited.length = 0;
    fake.creationAnswers.push(answer as never);
    const reply = await json(await call("POST", `/api/agents/${agent}/creation`, { cookie, body: {} }));
    assert.deepEqual([reply.status, reply.body], [status, body]);
    assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["create", "attempt"], ["create", "result"]]);
  }
  t.mock.method(console, "error", () => {});
});

test("a DAO's creation is its vote: a member who may file gets the proposal to file, with a vote if their role votes; one who may only read is refused", async () => {
  clean();
  for (const [who, voteOn] of [[council, 0], [proposer, undefined]] as const) {
    const { status, body } = await json(await call("POST", "/api/agents/dao-new/creation", { cookie: await signIn(who), body: {} }));
    assert.equal(status, 200, JSON.stringify(body));
    const created = contract.creation.parse(body.value);
    assert.equal(created.confirm, undefined);
    assert.deepEqual(created.dao, { transaction: daoTransaction(DAO, created.correlationId.padStart(64, "c"), voteOn) }, who.accountId);
  }
  const refused = await json(await call("POST", "/api/agents/dao-new/creation", { cookie: await signIn(reader), body: {} }));
  assert.deepEqual([refused.status, refused.body], [403, { ok: false, kind: "refused", code: "not_permitted" }]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("creation")), ["creation.prepare dao-new dao", "creation.prepare dao-new dao"]);
});

test("only a setup consent's key creates the agent: never a consent for a created agent of the same name, a revoked or an expired one", () => {
  const consent = (id: string, change: Record<string, unknown>) => ({ id, deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near",
    agent: "treasury-1", agentId: "unborn", scopes: ["owner" as const], expiresAt: Date.now() + 60_000, createdAt: 0, publicKey: `key-${id}`, revoked: false, revokedAt: null, ...change });
  const consents = [
    consent("earlier-agent", { agentId: "id-before", scopes: ["read", "treasury"], expiresAt: Date.now() + 86_400_000 }),
    consent("revoked", { revoked: true, expiresAt: Date.now() + 3_600_000 }),
    consent("expired", { expiresAt: Date.now() - 1 }),
    consent("another-owner", { owner: "other.near" }),
    consent("setup", {}),
  ];
  assert.deepEqual(setupConsents(consents, "owner.near", "treasury-1").map(found => found.publicKey), ["key-setup"]);
});

/** A DAO with the same members as `DAO` and no agent yet, for a setup test. */
function freshDao(dao: string) {
  policies[dao] = policies[DAO]!;
  chainProposals[dao] = [];
  return { dao, organization: dao.replaceAll(".", "--") };
}

test("a DAO's member who may file asks for its Treasury setup: filed once for the DAO's vote, stored and recorded; others see it by their own roles", async () => {
  clean();
  const { dao, organization } = freshDao("second.sputnik-dao.near");
  const path = `/api/setup/dao/${dao}`;
  const { status, body } = await json(await call("POST", path, { cookie: await signIn(council), body: {} }));
  assert.equal(status, 200, JSON.stringify(body));
  const { request } = contract.daoFiled.parse(body.value);
  const filed = fake.daoSetups.at(-1)!;
  assert.equal(request.id, filed.id);
  assert.equal(request.check, `https://platform.test/confirm/dao/${filed.id}`);
  assert.deepEqual(request.offer, { state: "file", transaction: daoTransaction(dao, filed.id, 0) });
  assert.equal(filed.organization, organization);
  assert.ok(filed.expiresAt > Date.now() + 6 * 86_400_000 && filed.expiresAt <= Date.now() + 7 * 86_400_000, "good for the DAO's voting period");
  assert.deepEqual(shape(audited), [["dao-setup", "attempt", "council.near", undefined, undefined], ["dao-setup", "result", "council.near", undefined, undefined]]);
  assert.equal(audited[1]!.request, filed.id);
  assert.ok(audited[0]!.signedTextSha256);
  // Another member's click answers the open setup; one who may only file is offered it without a vote.
  const second = await json(await call("POST", path, { cookie: await signIn(proposer), body: {} }));
  assert.deepEqual(second.body.value.request.offer, { state: "file", transaction: daoTransaction(dao, filed.id) });
  assert.deepEqual(fake.calls.filter(made => made === "daoSetups.file"), ["daoSetups.file"]);
  // One who may only read sees it, and may not file it.
  const readerCookie = await signIn(reader);
  assert.deepEqual((await json(await call("POST", path, { cookie: readerCookie, body: {} }))).body, { ok: false, kind: "refused", code: "not_permitted" });
  const seen = await json(await call("GET", path, { cookie: readerCookie }));
  assert.deepEqual([seen.body.value.agents, seen.body.value.request.id, seen.body.value.request.offer], [[], filed.id, { state: "file", transaction: null }]);
  assert.deepEqual([seen.body.value.account, seen.body.value.access.canPropose], ["reader.near", false]);
  // Someone the DAO's policy names in no role gets the same answer as for an agent that isn't theirs.
  assert.deepEqual((await json(await call("GET", path, { cookie: await signIn(owner) }))).body, { ok: false, kind: "not_owner" });
});

test("a DAO's setup whose vote passed reserves its agent on the next read, recorded once; the DAO then votes on its creation, and isn't set up again", async () => {
  clean();
  const { dao } = freshDao("second.sputnik-dao.near");
  const path = `/api/setup/dao/${dao}`, cookie = await signIn(council);
  const filed = fake.daoSetups.find(setup => setup.dao === dao)!;
  filed.signed = true;
  const { body } = await json(await call("GET", path, { cookie }));
  const agent = fake.reservations[dao]!;
  const { account: _account, access: _access, ...seen } = contract.daoSetup.parse(body.value);
  assert.deepEqual(seen, { agents: [agent], request: null });
  assert.deepEqual(shape(audited), [["dao-setup-reserved", "result", dao, agent, fake.consents.at(-1)!.id]]);
  fake.calls.length = 0;
  assert.deepEqual(contract.daoSetup.parse((await json(await call("GET", path, { cookie }))).body.value).agents, [agent]);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("daoSetups")), [], "closed: not read again");
  const created = await json(await call("POST", `/api/agents/${agent}/creation`, { cookie, body: {} }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(contract.creation.parse(created.body.value).dao);
  const again = await json(await call("POST", path, { cookie, body: {} }));
  assert.deepEqual([again.status, again.body], [409, { ok: false, kind: "refused", code: "already_set_up" }]);
});

test("a DAO's setup whose vote didn't pass in time, or that the platform refused after the vote, ends and says why; a new one may be filed", async () => {
  const { dao } = freshDao("third.sputnik-dao.near");
  const path = `/api/setup/dao/${dao}`, cookie = await signIn(council);
  for (const [code, ended] of [[410, "expired"], [409, "refused"]] as const) {
    await call("POST", path, { cookie, body: {} });
    fake.daoSetups.at(-1)!.ended = code;
    const { agents, request, ended: why } = (await json(await call("GET", path, { cookie }))).body.value;
    assert.deepEqual({ agents, request, ended: why }, { agents: [], request: null, ended });
  }
  assert.equal(fake.daoSetups.filter(setup => setup.dao === dao).length, 2, "each was filed anew");
});

test("a DAO's setup that lapsed before its agent was created isn't listed, and the DAO may file its setup again", async () => {
  clean();
  const { dao } = freshDao("fifth.sputnik-dao.near");
  const path = `/api/setup/dao/${dao}`, cookie = await signIn(council);
  await call("POST", path, { cookie, body: {} });
  fake.daoSetups.at(-1)!.signed = true;
  const agent = (await json(await call("GET", path, { cookie }))).body.value.agents[0];
  assert.equal(agent, fake.reservations[dao]);
  for (const consent of fake.consents.filter(consent => consent.agent === agent)) consent.expiresAt = Date.now() - 1;
  assert.deepEqual((await json(await call("GET", path, { cookie }))).body.value.agents, []);
  const again = await json(await call("POST", path, { cookie, body: {} }));
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("a thrown DAO setup filing is recorded and answers unavailable, storing nothing", async t => {
  clean();
  const { dao, organization } = freshDao("fourth.sputnik-dao.near");
  t.mock.method(fake.platform.daoSetups, "file", async () => { throw new Error("socket hang up"); });
  const reply = await json(await call("POST", `/api/setup/dao/${dao}`, { cookie: await signIn(council), body: {} }));
  assert.deepEqual([reply.status, reply.body], [503, { ok: false, kind: "unavailable" }]);
  assert.deepEqual(audited.map(entry => [entry.action, entry.stage]), [["dao-setup", "attempt"], ["dao-setup", "result"]]);
  const { agents, request } = (await json(await call("GET", `/api/setup/dao/${dao}`, { cookie: await signIn(council) }))).body.value;
  assert.deepEqual({ agents, request }, { agents: [], request: null });
  assert.equal(organization, "fourth--sputnik-dao--near");
});

test("the setup routes count against the account's requests a minute, as the owner routes do", async () => {
  const routes = [["GET", "/api/setup"], ["POST", "/api/setup"], ["GET", `/api/setup/dao/${DAO}`], ["POST", `/api/setup/dao/${DAO}`]] as const;
  const accounts = routes.map((_, i) => wallet(`limited-${i}.near`));
  const limited = await testServer({ platform: fake.platform, wallets: accounts, ownerRequestsPerMinute: 2, daos: standInDaos(policies, chainProposals) });
  try {
    const send = (method: string, path: string, { cookie, body = {} }: { cookie?: string; body?: unknown } = {}) =>
      fetch(`${limited.base}${path}`, { method, headers: { ...(method === "GET" ? {} : write), ...(cookie && { cookie }) }, ...(method !== "GET" && { body: JSON.stringify(body) }) });
    for (const [i, [method, path]] of routes.entries()) {
      const cookie = await limited.signIn(accounts[i]!);
      const statuses = [];
      for (let n = 0; n < 3; n++) statuses.push((await send(method, path, { cookie })).status);
      assert.notEqual(statuses[1], 429, `${method} ${path}: ${statuses}`);
      assert.equal(statuses[2], 429, `${method} ${path}: ${statuses}`);
    }
  } finally { limited.server.close(); }
});
