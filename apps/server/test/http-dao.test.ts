// DAO-owned agents (#20, PR 5): members gated by the DAO's roles, its consent and its votes filed for the DAO's vote and
// followed by state, recorded like a wallet owner's actions.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseConsentMessage, proposalText, type DaoPolicy, type ProposalView } from "@multiagency/sdk";
import { sha256, type AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { memoryDaoRequests, type PolicyRead } from "../src/dao.ts";
import { createServer, routes } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, proposal, wallet } from "./fakes.ts";

const DAO = "dao.sputnik-dao.near", ORG = "dao--sputnik-dao--near";
const voter = wallet("voter.near"), proposer = wallet("proposer.near"), reader = wallet("reader.near"), outsider = wallet("outsider.near"), owner = wallet("owner.near");
/**
 * The DAO's roles: a council that proposes, votes and changes the policy; proposers who only file; readers with no
 * rights. Everyone's role names no one, so it admits no one (`accessOf`), though its rights add to a member's.
 */
const policy: DaoPolicy = {
  proposal_bond: "100000000000000000000000", default_vote_policy: { threshold: [1, 2] },
  roles: [
    { name: "all", kind: "Everyone", permissions: ["config:AddProposal"], vote_policy: {} },
    { name: "council", kind: { Group: ["voter.near"] }, permissions: ["*:AddProposal", "*:VoteApprove"], vote_policy: {} },
    { name: "proposers", kind: { Group: ["proposer.near"] }, permissions: ["call:AddProposal"], vote_policy: {} },
    { name: "readers", kind: { Group: ["reader.near"] }, permissions: [], vote_policy: {} },
  ],
};
const fake = fakePlatform({ "dao-agent": DAO, portfolio: "owner.near" }, { daoOwned: ["dao-agent"] });
const chain: { policy: PolicyRead; reads: string[] } = { policy, reads: [] };
const audited: AuditEntry[] = [];
/** The server's DAO requests, replaced with an empty store for each test. */
let kept = memoryDaoRequests();
let server: Server, base: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup(Object.fromEntries([voter, proposer, reader, outsider, owner].map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audited.push(entry); } },
    consentsPerDay: 1_000, keyLookup: async () => "full",
    daoPolicy: async dao => { chain.reads.push(dao); return chain.policy; },
    daoRequests: { open: (...args) => kept.open(...args), add: request => kept.add(request), drop: request => kept.drop(request) },
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const write = { origin: ORIGIN, "content-type": "application/json" };
const call = (method: string, path: string, { body, cookie }: { body?: unknown; cookie?: string } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(method === "GET" ? {} : write), ...(cookie && { cookie }) }, ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }) });
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });
async function signIn(who: ReturnType<typeof wallet>) {
  const { body: issued } = await json(await call("POST", "/api/session/challenge"));
  const response = await call("POST", "/api/session", { body: who.sign(issued.value) });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
/** Starts from nothing: no consents, proposals, DAO requests or queued answers, no calls, no records, the policy readable. */
function clean() {
  fake.consents.length = 0; fake.proposals.length = 0; fake.calls.length = 0; fake.daoPassed.clear();
  for (const key of Object.keys(fake.daoAnswers)) delete fake.daoAnswers[key as keyof typeof fake.daoAnswers];
  audited.length = 0; chain.policy = policy; chain.reads.length = 0; kept = memoryDaoRequests();
}
const daoProposal = (change: Partial<ProposalView> = {}) => ({ ...proposal({ organization: ORG, agentId: "id-dao-agent", ...change }), agent: "dao-agent" });
const platformCalls = (prefix: string) => fake.calls.filter(line => line.startsWith(prefix));
const ID = "a".repeat(32);

test("a DAO's member reads its agent with what their roles allow; anyone else, the DAO's own account included, is not its owner", async () => {
  clean();
  const { status, body } = await json(await call("GET", "/api/agents/dao-agent", { cookie: await signIn(voter) }));
  assert.equal(status, 200);
  assert.deepEqual(contract.agent.parse(body.value), { agent: "dao-agent", owner: DAO, agentId: "id-dao-agent", host: "platform.test", signer: "dao",
    member: { canPropose: true, canVote: true, canExecute: true, canManage: true } });
  assert.deepEqual((await json(await call("GET", "/api/agents/dao-agent", { cookie: await signIn(proposer) }))).body.value.member,
    { canPropose: true, canVote: false, canExecute: false, canManage: false }, "the member's own roles' rights");
  for (const who of [outsider, owner])
    assert.deepEqual(await json(await call("GET", "/api/agents/dao-agent", { cookie: await signIn(who) })), { status: 403, body: { ok: false, kind: "not_owner" } }, who.accountId);
  assert.ok(chain.reads.every(dao => dao === DAO), "the policy read is the agent's owner's, from the platform's identity");
});

test("a DAO policy the chain didn't answer admits no one: unavailable, never a guess", async t => {
  t.mock.method(console, "error", () => {});
  clean();
  const cookie = await signIn(voter);
  chain.policy = "unavailable";
  assert.deepEqual(await json(await call("GET", "/api/agents/dao-agent", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } });
});

test("a DAO's member is refused every route for wallet owners as dao_owner, after only the ownership read", async () => {
  const cookie = await signIn(voter);
  const forWallets = routes.filter(route => (route.access === "owner" || route.access === "owner-fresh") && !route.member);
  assert.deepEqual(forWallets.map(route => route.path).sort(), ["/api/agents/:agent/consent", "/api/agents/:agent/consent/text",
    "/api/agents/:agent/proposals/:id/approve", "/api/agents/:agent/proposals/:id/reject"], "signing routes: a DAO signs only by its vote");
  for (const route of forWallets) {
    clean();
    const path = route.path.replace(":agent", "dao-agent").replace(":id", ID);
    assert.deepEqual(await json(await call(route.method, path, { cookie })), { status: 409, body: { ok: false, kind: "refused", code: "dao_owner" } }, path);
    assert.deepEqual(fake.calls, ["identity dao-agent (fresh)"], `${path}: nothing but the ownership read`);
  }
});

test("each member is gated by their DAO roles: a reader files nothing, a proposer can't execute or disconnect", async () => {
  const cases: [ReturnType<typeof wallet>, string, string][] = [
    [reader, "POST", "/api/agents/dao-agent/consent/dao"],
    [reader, "POST", `/api/agents/dao-agent/proposals/${ID}/vote`],
    [proposer, "POST", `/api/agents/dao-agent/proposals/${ID}/execute`],
    [proposer, "POST", "/api/agents/dao-agent/consent/revoke"],
  ];
  for (const [who, method, path] of cases) {
    clean();
    assert.deepEqual(await json(await call(method, path, { cookie: await signIn(who), body: { verdict: "approve" } })),
      { status: 403, body: { ok: false, kind: "refused", code: "not_permitted" } }, `${who.accountId} ${path}`);
    assert.deepEqual(fake.calls, ["identity dao-agent (fresh)"], "refused before any call that acts");
  }
  clean();
  const read = await json(await call("GET", "/api/agents/dao-agent/proposals", { cookie: await signIn(reader) }));
  assert.equal(read.status, 200, "every member reads");
});

test("a wallet owner's agent has no DAO routes: not_dao, with nothing filed", async () => {
  clean();
  const cookie = await signIn(owner);
  for (const [method, path] of [["GET", "/api/agents/portfolio/consent/dao"], ["POST", "/api/agents/portfolio/consent/dao"],
    ["GET", `/api/agents/portfolio/proposals/${ID}/vote`], ["POST", `/api/agents/portfolio/proposals/${ID}/vote`]] as const)
    assert.deepEqual(await json(await call(method, path, { cookie, body: { verdict: "approve" } })), { status: 409, body: { ok: false, kind: "refused", code: "not_dao" } }, `${method} ${path}`);
  assert.deepEqual(platformCalls("dao."), []);
});

test("a DAO's consent: the server's own text filed once for the DAO's vote, followed by state, stored once the vote passed, recorded with no signature", async () => {
  clean();
  const cookie = await signIn(voter), theirs = await signIn(proposer);
  const filed = await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie }));
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const pending = contract.daoConsent.parse(filed.body.value);
  assert.equal(pending.state, "pending");
  if (pending.state !== "pending") return;
  assert.equal(pending.request.checkUrl, `https://platform.test/confirm/dao/${pending.request.hash}`, "the platform's check page for the exact text");
  assert.ok(pending.request.description.includes(pending.request.checkUrl));
  assert.deepEqual([pending.request.votes, pending.request.transaction?.actions[0]?.params.methodName], [true, "add_proposal+act_proposal"], "a voter files and votes at once");
  const message = fake.daoFiled[0]!.kind === "consent" ? fake.daoFiled[0]!.message : "";
  const text = parseConsentMessage(message)!;
  assert.deepEqual([text.owner, text.organization, text.agent, text.agentId, text.scopes, text.host],
    [DAO, ORG, "dao-agent", "id-dao-agent", ["read", "treasury"], "platform.test"], "built here from the identity: read and treasury only, never treasury-execute");

  const again = await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie: theirs }));
  assert.equal(again.body.value.request.id, pending.request.id, "an open request is followed, never filed again");
  assert.deepEqual([again.body.value.request.votes, again.body.value.request.transaction.actions[0].params.methodName], [false, "add_proposal"],
    "a member whose role can't vote only files the proposal");
  assert.equal(platformCalls("dao.consents.file").length, 1);

  fake.daoPassed.add(pending.request.id);
  const signed = await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie }));
  assert.deepEqual(contract.daoConsent.parse(signed.body.value).state, "signed", "reading after the vote passed stores the consent");
  const live = await json(await call("GET", "/api/agents/dao-agent/consent", { cookie: theirs }));
  assert.equal(live.body.value.consent.id, signed.body.value.consent.id);
  assert.deepEqual((await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value, { state: "none" }, "a final request is forgotten");
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie })), { status: 409, body: { ok: false, kind: "refused", code: "already_connected" } });

  const at = { who: "voter.near", action: "consent", agent: "dao-agent", signer: "dao" };
  assert.deepEqual(audited, [
    { ...at, step: "file", signedTextSha256: sha256(message), stage: "attempt" },
    { ...at, step: "file", signedTextSha256: sha256(message), daoRequest: pending.request.id, daoHash: pending.request.hash, stage: "result", answer: { ok: true } },
    { ...at, step: "relay", daoRequest: pending.request.id, daoHash: pending.request.hash, stage: "result", subject: signed.body.value.consent.id, answer: { ok: true } },
  ]);
  assert.ok(!/signature/i.test(JSON.stringify(audited)));
});

test("a DAO consent whose vote didn't pass in time, or that the DAO's stop ended, is forgotten and may be filed again", async () => {
  for (const [status, state] of [[410, "expired"], [409, "ended"], [404, "gone"]] as const) {
    clean();
    const cookie = await signIn(voter);
    const first = (await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value.request.id;
    fake.daoAnswers.consentState = [{ ok: false, kind: "refused", status, error: "x" }];
    assert.deepEqual((await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value, { state }, String(status));
    assert.equal(audited.at(-1)!.step, "relay", "the end is recorded");
    const second = (await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value.request.id;
    assert.notEqual(second, first, "filed anew, for a new vote");
  }
});

test("a lost filing keeps nothing; a lost state read keeps the request, which is read again and never filed again", async t => {
  t.mock.method(console, "error", () => {});
  clean();
  const cookie = await signIn(voter);
  fake.daoAnswers.consentFile = [{ ok: false, kind: "unavailable" }];
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } });
  assert.deepEqual(audited.map(entry => [entry.stage, entry.stage === "result" && entry.answer.ok]), [["attempt", false], ["result", false]], "recorded either way");
  assert.deepEqual((await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value, { state: "none" });
  const filed = (await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value.request.id;
  fake.daoAnswers.consentState = [new Error("socket hang up")];
  assert.deepEqual(await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } });
  fake.daoAnswers.consentState = [{ ok: false, kind: "unavailable" }];
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie })), { status: 503, body: { ok: false, kind: "unavailable" } },
    "asking to file while the open request's state is unanswered files nothing");
  const read = await json(await call("GET", "/api/agents/dao-agent/consent/dao", { cookie }));
  assert.equal(read.body.value.request.id, filed, "the same request, still followed");
  assert.equal(platformCalls("dao.consents.file").length, 2, "the lost one and the one followed: never a third");
});

test("a DAO's vote: filed for an open proposal of this app, followed until relayed, then executed once by a member who may execute", async () => {
  clean();
  const view = daoProposal();
  fake.proposals.push(view);
  const { agent: _agent, ...asShown } = view;
  const text = sha256(proposalText(asShown, "approve"));
  const theirs = await signIn(proposer), cookie = await signIn(voter);
  const filed = await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie: theirs, body: { verdict: "approve" } }));
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const pending = contract.daoVote.parse(filed.body.value);
  assert.ok(pending.state === "pending" && pending.verdict === "approve" && pending.request.transaction !== null && !pending.request.votes);
  assert.deepEqual(platformCalls("dao.votes.file"), [`dao.votes.file ${ORG} dao-agent ${ID} approve`], "under the DAO's own Organization");
  assert.equal((await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie, body: { verdict: "approve" } }))).body.value.request.id,
    filed.body.value.request.id, "an open vote is followed, never filed again");
  assert.deepEqual(await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie, body: { verdict: "reject" } })),
    { status: 409, body: { ok: false, kind: "refused", code: "vote_open" } }, "not the other verdict while one is open");
  assert.equal(platformCalls("dao.votes.file").length, 1);

  assert.equal((await json(await call("GET", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie }))).body.value.state, "pending");
  fake.daoPassed.add(filed.body.value.request.id);
  assert.deepEqual((await json(await call("GET", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie }))).body.value,
    { state: "relayed", verdict: "approve", proposalState: "approved" }, "reading after the vote passed relays it");
  assert.equal((await json(await call("GET", `/api/agents/dao-agent/proposals/${ID}`, { cookie: theirs }))).body.value.proposal.state, "approved");

  assert.deepEqual((await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/execute`, { cookie: theirs }))).body,
    { ok: false, kind: "refused", code: "not_permitted" }, "a proposer can't execute");
  const ran = await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/execute`, { cookie }));
  assert.deepEqual([ran.body.value.result, ran.body.value.proposal.state], ["final", "executed"]);
  assert.deepEqual(platformCalls("proposals.execute"), [`proposals.execute ${ORG} dao-agent ${ID}`]);

  const request = filed.body.value.request;
  assert.deepEqual(audited.map(({ who, action, step, stage, signedTextSha256, daoRequest }) => [who, action, step, stage, signedTextSha256, daoRequest]), [
    ["proposer.near", "approve", "file", "attempt", text, undefined],
    ["proposer.near", "approve", "file", "result", text, request.id],
    ["voter.near", "approve", "relay", "result", undefined, request.id],
    ["voter.near", "execute", undefined, "attempt", undefined, undefined],
    ["voter.near", "execute", undefined, "result", undefined, undefined],
  ], "the text the DAO's vote signs is recorded by its hash; the member is who");
});

test("a vote on a proposal no longer open, or past its time, is refused before anything is filed", async () => {
  const cookie = await signIn(voter);
  for (const [change, code] of [[{ state: "approved" }, "not_open"], [{ expiresAt: new Date(Date.now() - 1).toISOString() }, "expired"]] as const) {
    clean();
    fake.proposals.push(daoProposal(change));
    assert.deepEqual(await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie, body: { verdict: "approve" } })),
      { status: 409, body: { ok: false, kind: "refused", code } }, code);
    assert.deepEqual([platformCalls("dao."), audited], [[], []]);
  }
  clean();
  assert.deepEqual((await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie, body: { verdict: "maybe" } }))).body.code, "bad_request");
});

test("the platform's refusals of a DAO filing reach the browser as codes, never its text, and are recorded", async t => {
  t.mock.method(console, "error", () => {});
  const cookie = await signIn(voter);
  const vote: [unknown, number, string][] = [
    [{ ok: false, kind: "forbidden", status: 403, error: "No live DAO consent" }, 409, "not_connected"],
    [{ ok: false, kind: "refused", status: 409, error: "Not open" }, 409, "not_open"],
    [{ ok: false, kind: "refused", status: 429, error: "256 a day" }, 429, "too_many_requests"],
    [{ ok: false, kind: "refused", status: 400, error: "Bad" }, 400, "dao_refused"],
  ];
  for (const [answer, status, code] of vote) {
    clean();
    fake.proposals.push(daoProposal());
    fake.daoAnswers.voteFile = [answer];
    assert.deepEqual(await json(await call("POST", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie, body: { verdict: "reject" } })),
      { status, body: { ok: false, kind: "refused", code } }, code);
    const last = audited.at(-1)!;
    assert.deepEqual(last.stage === "result" && last.answer, { ok: false, kind: (answer as { kind: string }).kind, status: (answer as { status: number }).status, code });
    assert.deepEqual((await json(await call("GET", `/api/agents/dao-agent/proposals/${ID}/vote`, { cookie }))).body.value, { state: "none" }, "nothing kept");
  }
  clean();
  fake.daoAnswers.consentFile = [{ ok: false, kind: "forbidden", status: 403, error: "This DAO doesn't own the agent" }];
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie })), { status: 403, body: { ok: false, kind: "not_owner" } });
});

test("a member who may disconnect revokes the DAO's live consents for the agent, recorded as theirs", async () => {
  clean();
  const cookie = await signIn(voter);
  const { request } = (await json(await call("POST", "/api/agents/dao-agent/consent/dao", { cookie }))).body.value;
  fake.daoPassed.add(request.id);
  await call("GET", "/api/agents/dao-agent/consent/dao", { cookie });
  audited.length = 0;
  assert.deepEqual(await json(await call("POST", "/api/agents/dao-agent/consent/revoke", { cookie })), { status: 200, body: { ok: true, value: { revoked: 1 } } });
  assert.deepEqual(audited.map(entry => [entry.who, entry.action, entry.stage]), [["voter.near", "revoke", "attempt"], ["voter.near", "revoke", "result"]]);
  assert.deepEqual((await json(await call("GET", "/api/agents/dao-agent/consent", { cookie }))).body.value, { consent: null });
});
