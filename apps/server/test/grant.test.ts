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

test("nothing is prepared for a changed strategy, with autopilot on, without owner actions allowed, or while a grant waits", async () => {
  reset();
  assert.deepEqual((await call("POST", "grant", { expectedDigest: `sha256:${"b".repeat(64)}` })).body, { ok: false, kind: "refused", code: "strategy_changed" });
  fake.schedules.portfolio = { on: true, unbound: true };
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "autopilot_on" });
  reset(["read", "treasury"]);
  assert.deepEqual((await call("POST", "grant", { expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "owner_not_allowed" });
  assert.deepEqual(prepares(), []);
  reset();
  assert.equal((await call("POST", "grant", { expectedDigest: DIGEST })).status, 200);
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
  assert.deepEqual((await call("POST", `grant/${grant.correlationId}/submit`, { signedData: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "n" }, public_key: "k", signature: "s" } }, council, "daoagent")).body,
    { ok: false, kind: "refused", code: "not_permitted" });
});
