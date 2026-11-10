import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { standInDaos, type Policy } from "../src/dao.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const DAO = "agentic.sputnik-dao.near", DIGEST = `sha256:${"a".repeat(64)}`;
const owner = wallet("owner.near"), council = wallet("council.near");
const fake = fakePlatform({ portfolio: "owner.near", daoagent: DAO }, { daos: ["daoagent"] });
const policy: Policy = {
  proposal_bond: "100000000000000000000000", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
    { name: "council", kind: { Group: ["council.near"] }, permissions: ["call:AddProposal", "call:VoteApprove", "call:VoteReject"], vote_policy: {} }],
};
const audit: AuditEntry[] = [];
const cookies: Record<string, string> = {};
let server: Server, base: string;

before(async () => {
  const started = await testServer({ platform: fake.platform, wallets: [owner, council], audited: audit, daos: standInDaos({ [DAO]: policy }, { [DAO]: [] }) });
  ({ server, base } = started);
  for (const who of [owner, council]) cookies[who.accountId] = await started.signIn(who);
});
after(() => server.close());

const call = async (method: "GET" | "POST", path: string, body: unknown = {}, as = owner, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/${path}`, { method, headers: { cookie: cookies[as.accountId]!, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const consent = (scopes: ("read" | "treasury" | "owner")[]) => ({ id: "c".padEnd(64, "0"), deployment: "treasury", host: "platform.test", organization: "owner--near",
  owner: "owner.near", agent: "portfolio", agentId: "id-portfolio", scopes, expiresAt: Date.now() + 86_400_000, createdAt: 0, publicKey: "k", revoked: false, revokedAt: null });
const reset = (scopes: ("read" | "treasury" | "owner")[] = ["owner", "read", "treasury"]) => {
  fake.calls.length = 0; audit.length = 0; fake.grants.length = 0;
  fake.schedules.portfolio = { on: false, unbound: true };
  fake.consents.length = 0; fake.consents.push(consent(scopes));
};
const prepares = () => fake.calls.filter(made => made.startsWith("grant.prepare"));
const signedFor = (intent: { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } }) => ({ signedData: { ...intent, public_key: owner.publicKey, signature: "ed25519:sig" } });

test("a wallet owner whose connection allows owner actions signs the grant's intent; submitted once, it binds the strategy", async () => {
  reset();
  const prepared = await call("POST", "grant", { expectedDigest: DIGEST });
  assert.equal(prepared.status, 200, prepared.text);
  const grant = contract.grantPrepared.parse(prepared.body.value);
  assert.ok(grant.intent && !grant.dao && !grant.confirm, "an intent to sign here");
  assert.deepEqual(prepares(), [`grant.prepare owner--near portfolio wallet ${DIGEST}`], "bound to the digest the owner saw");
  const submitted = await call("POST", `grant/${grant.correlationId}/submit`, signedFor(grant.intent!));
  assert.deepEqual(submitted.body, { ok: true, value: { status: "SUCCESS", failureCode: null } });
  assert.deepEqual(contract.ownerActionStatus.parse((await call("GET", `grant/${grant.correlationId}`)).body.value), { stage: "submitted" });
  assert.equal(contract.strategyRead.parse((await call("GET", "strategy")).body.value).grantMatches, true);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage]), [["grant", "attempt"], ["grant", "result"], ["grant-submit", "attempt"], ["grant-submit", "result"]]);
});

test("grant status retains phase and a failed provider outcome while legacy status responses stay unchanged", async t => {
  reset();
  const answers = [
    { stage: "submitted", phase: "settled", status: "SUCCESS", failureCode: null },
    { stage: "submitted", phase: "settled", status: "FAILED", failureCode: "grant_denied" },
    { stage: "submitting", phase: "submitted", status: "UNKNOWN" },
    { stage: "voting" },
  ] as const;
  let index = 0;
  t.mock.method(fake.platform.owner, "status", async () => ({ ok: true as const, value: { ...answers[index++]!, error: "private provider detail" } }));
  for (const expected of answers) {
    const read = await call("GET", "grant/status-fixture");
    assert.deepEqual([read.status, read.body], [200, { ok: true, value: expected }]);
    assert.deepEqual(contract.ownerActionStatus.parse(read.body.value), expected);
  }
});

test("grant guards follow phase: submitted past expiry stays held, while a settled failure permits a new authorization", async t => {
  const expired = new Date(Date.now() - 60_000).toISOString();
  for (const phase of ["submitted", "settled"] as const) {
    reset();
    const actions = t.mock.method(fake.platform.grant, "actions", async () => ({ ok: true as const, value: [{ correlationId: "earlier-grant", type: "grant_issue",
      expiresAt: expired, signer: "wallet" as const, stage: phase === "submitted" ? "expired" as const : "submitted" as const, phase,
      ownerSucceeded: false, status: phase === "submitted" ? "PROCESSING" : "FAILED", failureCode: null, payment: null }] }));
    const prepared = await call("POST", "grant", { expectedDigest: DIGEST });
    if (phase === "submitted") assert.deepEqual(prepared.body, { ok: false, kind: "refused", code: "grant_pending" });
    else assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepares().length, phase === "submitted" ? 0 : 1);
    actions.mock.restore();
  }
});

test("nothing is prepared for a changed strategy, with autopilot on, without owner actions allowed, or while a grant waits", async () => {
  reset();
  assert.deepEqual((await call("POST", "grant", { expectedDigest: `sha256:${"b".repeat(64)}` })).body, { ok: false, kind: "refused", code: "strategy_changed" });
  fake.schedules.portfolio = { on: true, unbound: true };
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "autopilot_on" });
  reset(["read", "treasury"]);
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "owner_not_allowed" });
  assert.deepEqual(prepares(), []);
  reset();
  // A wallet's grant takes effect only by its submit here, so one only prepared holds nothing (the refused signature
  // below). One submitted is followed, never signed twice.
  const first = contract.grantPrepared.parse((await call("POST", "grant", { expectedDigest: DIGEST })).body.value);
  await call("POST", `grant/${first.correlationId}/submit`, signedFor(first.intent!));
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "grant_pending" }, "followed, never signed twice");
  assert.equal(prepares().length, 1);
});

test("a malformed signature is refused unasked; a lost submit is unavailable and recorded; the platform's refusal is grant_refused", async () => {
  reset();
  const grant = contract.grantPrepared.parse((await call("POST", "grant", { expectedDigest: DIGEST })).body.value);
  assert.deepEqual((await call("POST", `grant/${grant.correlationId}/submit`, { signedData: { standard: "nep413" } })).body, { ok: false, kind: "refused", code: "bad_request" });
  fake.grantAnswers.submit = [new Error("socket hang up"), { ok: false, kind: "refused", status: 400, error: "signature invalid: detail" }, { ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }];
  assert.equal((await call("POST", `grant/${grant.correlationId}/submit`, signedFor(grant.intent!))).status, 503);
  const refused = await call("POST", `grant/${grant.correlationId}/submit`, signedFor(grant.intent!));
  assert.deepEqual(refused.body, { ok: false, kind: "refused", code: "grant_refused" });
  assert.ok(!refused.text.includes("detail"));
  const limited = await call("POST", `grant/${grant.correlationId}/submit`, signedFor(grant.intent!));
  assert.deepEqual([limited.status, limited.body], [429, { ok: false, kind: "refused", code: "platform_rate_limited" }]);
  assert.deepEqual(audit.filter(entry => entry.action === "grant-submit" && entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "unavailable" }, { ok: false, kind: "refused", status: 400, code: "grant_refused" },
      { ok: false, kind: "rate_limited", status: 429, code: "platform_rate_limited" }]);
});

test("the platform's limit on the deployment's calls: the grant isn't prepared, so asking again is offered at once", async () => {
  reset();
  fake.grantAnswers.prepare = [{ ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }];
  const limited = await call("POST", "grant", { expectedDigest: DIGEST });
  assert.deepEqual([limited.status, limited.body], [429, { ok: false, kind: "refused", code: "platform_rate_limited" }]);
  assert.deepEqual(audit.filter(entry => entry.action === "grant" && entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "rate_limited", status: 429, code: "platform_rate_limited" }]);
  assert.equal((await call("POST", "grant", { expectedDigest: DIGEST })).status, 200, "nothing waits on a grant that was never prepared");
});

test("a DAO's member asks for the grant: prepared for the DAO's vote as the transaction they file; no member submits a signature", async () => {
  reset();
  fake.schedules.daoagent = { on: false, unbound: true };
  const prepared = await call("POST", "grant", { expectedDigest: DIGEST }, council, "daoagent");
  assert.equal(prepared.status, 200, prepared.text);
  const grant = contract.grantPrepared.parse(prepared.body.value);
  assert.ok(grant.dao && !grant.intent, "a transaction to file, not an intent to sign");
  assert.deepEqual(prepares(), [`grant.prepare ${DAO.replaceAll(".", "--")} daoagent dao ${DIGEST}`]);
  assert.deepEqual(contract.ownerActionStatus.parse((await call("GET", `grant/${grant.correlationId}`, {}, council, "daoagent")).body.value), { stage: "voting" });
  // The DAO's vote can still pass it without this server: a second is refused while it waits.
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST }, council, "daoagent")).body, { ok: false, kind: "refused", code: "grant_pending" });
  assert.deepEqual((await call("POST", `grant/${grant.correlationId}/submit`, { signedData: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "n" }, public_key: "k", signature: "s" } }, council, "daoagent")).body,
    { ok: false, kind: "refused", code: "not_permitted" });
});

test("a grant whose signature the owner's wallet refused can be authorized again: nothing was signed, so nothing holds", async () => {
  reset();
  const first = await call("POST", "grant", { expectedDigest: DIGEST });
  assert.equal(first.status, 200, first.text);
  assert.ok(contract.grantPrepared.parse(first.body.value).intent, "an intent for the wallet to sign");
  // The wallet refuses the signature: nothing is submitted, and the page offers the authorization again.
  const again = await call("POST", "grant", { expectedDigest: DIGEST });
  assert.equal(again.status, 200, `a refused signature holds the next grant: ${again.text}`);
  assert.equal(prepares().length, 2);
});
