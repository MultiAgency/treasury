import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos, type Policy } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const DAO = "agentic.sputnik-dao.near", DIGEST = `sha256:${"a".repeat(64)}`;
const owner = wallet("owner.near"), council = wallet("council.near"), voter = wallet("voter.near");
const fake = fakePlatform({ portfolio: "owner.near", daoagent: DAO }, { daos: ["daoagent"] });
const policy: Policy = {
  proposal_bond: "100000000000000000000000", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
    { name: "council", kind: { Group: ["council.near"] }, permissions: ["call:AddProposal", "call:VoteApprove", "call:VoteReject"], vote_policy: {} },
    { name: "voters", kind: { Group: ["voter.near"] }, permissions: ["call:VoteApprove"], vote_policy: {} }],
};
const audit: AuditEntry[] = [];
const cookies: Record<string, string> = {};
let server: Server, base: string;

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup(Object.fromEntries([owner, council, voter].map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({ [DAO]: policy }, { [DAO]: [] }), daoRequests: await createDaoRequests(join(tempDir("treasury-owner-actions-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const who of [owner, council, voter]) {
    const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
    cookies[who.accountId] = (await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(who.sign(issued.value)) }))
      .headers.get("set-cookie")!.split(";")[0]!;
  }
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
const prepares = () => fake.calls.filter(made => made.startsWith("owner.prepare"));
const signedFor = (intent: { standard: "nep413"; payload: { message: string; recipient: string; nonce: string } }) => ({ signedData: { ...intent, public_key: owner.publicKey, signature: "ed25519:sig" } });
const ownerSubmits = () => fake.calls.filter(made => made.startsWith("owner.submit"));
const confirmAnswer = { ok: true, value: { correlationId: "freeze-confirm", expiresAt: new Date(Date.now() + 600_000).toISOString(), digest: null, preview: { summary: "Freeze the agent" },
  confirm: { url: "https://platform.test/confirm/abc", expiresAt: new Date(Date.now() + 600_000).toISOString(), token: "secret-token" } } };

test("a wallet owner freezes: the intent to sign here, submitted once, followed by its status; then unfreezes the same way", async () => {
  reset();
  for (const [action, type] of [["freeze", "agent_freeze"], ["unfreeze", "agent_unfreeze"]] as const) {
    audit.length = 0; fake.calls.length = 0; fake.grants.length = 0;
    const prepared = await call("POST", action);
    assert.equal(prepared.status, 200, prepared.text);
    const made = contract.ownerActionPrepared.parse(prepared.body.value);
    assert.ok(made.intent && !made.dao && !made.confirm, "an intent to sign here");
    assert.deepEqual(prepares(), [`owner.prepare owner--near portfolio wallet ${type}`]);
    const submitted = await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!));
    assert.deepEqual(submitted.body, { ok: true, value: { status: "SUCCESS", failureCode: null } });
    assert.equal(ownerSubmits().length, 1, "relayed once");
    assert.deepEqual(contract.ownerActionStatus.parse((await call("GET", `owner/actions/${made.correlationId}`)).body.value), { stage: "submitted" });
    assert.deepEqual(audit.map(entry => [entry.action, entry.stage, entry.subject]),
      [[action, "attempt", undefined], [action, "result", made.correlationId], ["owner-submit", "attempt", made.correlationId], ["owner-submit", "result", made.correlationId]], "recorded before and after");
  }
});

test("owner action status retains the platform's phase and outcome without forwarding private details; older responses keep their shape", async t => {
  reset();
  const answers = [
    { stage: "submitting", phase: "submitted", status: "PROCESSING", failureCode: null },
    { stage: "submitted", phase: "settled", status: "FAILED", failureCode: "policy_refused" },
    { stage: "unknown", phase: "open" },
    { stage: "voting" },
    { stage: "submitted" },
  ] as const;
  let index = 0;
  t.mock.method(fake.platform.owner, "status", async () => ({ ok: true as const,
    value: { ...answers[index++]!, error: "private platform detail", signedData: { signature: "private signature" }, intent: { secret: true } } }));
  for (const expected of answers) {
    const read = await call("GET", "owner/actions/status-fixture");
    assert.deepEqual([read.status, read.body], [200, { ok: true, value: expected }]);
    assert.deepEqual(contract.ownerActionStatus.parse(read.body.value), expected);
  }
});

test("owner action guards use phase first: a submitted signature stays held after expiry, and a settled failure releases the hold", async () => {
  const expired = new Date(Date.now() - 60_000).toISOString();
  const cases = [
    { stage: "expired", phase: "submitted", status: "PROCESSING", held: true },
    { stage: "submitted", phase: "settled", status: "FAILED", held: false },
    { stage: "submitted", phase: "open", status: null, held: false },
    { stage: "submitted", phase: "expired", status: null, held: false },
  ] as const;
  for (const { held, ...action } of cases) {
    reset();
    fake.readAnswers.ownerActions = [{ ok: true, value: [{ correlationId: "earlier-freeze", type: "agent_freeze", expiresAt: expired,
      signer: "wallet", ownerSucceeded: false, failureCode: action.status === "FAILED" ? "provider_refused" : null, payment: null, ...action }] }];
    const prepared = await call("POST", "unfreeze");
    if (held) assert.deepEqual(prepared.body, { ok: false, kind: "refused", code: "action_pending" });
    else assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepares().length, held ? 0 : 1, JSON.stringify(action));
  }
});

test("a freeze and an unfreeze hold each other while either's outcome is unknown: one submitted, or a DAO's request waiting for its vote", async () => {
  reset();
  // Only prepared, never signed: nothing is unknown, and a reload mid-signature must not delay an emergency stop.
  assert.equal((await call("POST", "freeze")).status, 200);
  assert.equal((await call("POST", "freeze")).status, 200, "prepared again");
  assert.equal(prepares().length, 2);
  fake.grants[0]!.stage = "submitted";
  for (const action of ["freeze", "unfreeze"]) assert.deepEqual((await call("POST", action)).body, { ok: false, kind: "refused", code: "action_pending" }, `${action}: a submitted one waits for its outcome`);
  assert.equal(prepares().length, 2, "nothing more prepared");
  fake.grants[0]!.stage = "prepared";
  fake.grants[1]!.stage = "submitted";
  assert.deepEqual((await call("POST", "unfreeze")).body, { ok: false, kind: "refused", code: "action_pending" });
  // A pending grant is not a freeze: the two kinds don't hold each other.
  reset();
  fake.grants.push({ correlationId: "grant-9", agent: "portfolio", signer: "wallet", digest: DIGEST, stage: "submitted", expiresAt: new Date(Date.now() + 600_000).toISOString() });
  assert.equal((await call("POST", "freeze")).status, 200);
});

test("nothing is prepared without owner actions allowed, or for a malformed body; the platform's refusals are stable codes", async () => {
  reset(["read", "treasury"]);
  assert.deepEqual((await call("POST", "freeze")).body, { ok: false, kind: "refused", code: "owner_not_allowed" });
  assert.deepEqual(prepares(), []);
  reset();
  assert.deepEqual((await call("POST", "freeze", { extra: 1 })).body, { ok: false, kind: "refused", code: "bad_request" });
  assert.deepEqual(prepares(), []);
  fake.grantAnswers.ownerPrepare = [{ ok: false, kind: "refused", status: 409, error: "The agent is already frozen: detail" }];
  const refused = await call("POST", "freeze");
  assert.deepEqual(refused.body, { ok: false, kind: "refused", code: "action_refused" });
  assert.ok(!refused.text.includes("detail"), "no platform text reaches the browser");
  fake.grantAnswers.ownerPrepare = [{ ok: false, kind: "forbidden", status: 403, error: "No live owner consent" }];
  assert.deepEqual((await call("POST", "freeze")).body, { ok: false, kind: "refused", code: "owner_not_allowed" });
  fake.grantAnswers.ownerPrepare = [new Error("socket hang up")];
  assert.equal((await call("POST", "unfreeze")).status, 503);
  assert.deepEqual(audit.filter(entry => entry.action === "unfreeze" && entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined), [{ ok: false, kind: "unavailable" }], "a result even when the call threw");
});

test("the platform's limit on the deployment's calls: the freeze isn't prepared, so asking again is offered at once", async () => {
  reset();
  fake.grantAnswers.ownerPrepare = [{ ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }];
  const limited = await call("POST", "freeze");
  assert.deepEqual([limited.status, limited.body], [429, { ok: false, kind: "refused", code: "platform_rate_limited" }]);
  assert.deepEqual(audit.filter(entry => entry.action === "freeze" && entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "rate_limited", status: 429, code: "platform_rate_limited" }]);
  assert.equal((await call("POST", "freeze")).status, 200, "nothing waits on a freeze that was never prepared");
});

test("an action the platform holds for the owner's confirm page comes back as that link and nothing else: no token, no intent", async () => {
  reset();
  fake.grantAnswers.ownerPrepare = [confirmAnswer as never];
  const prepared = await call("POST", "freeze");
  assert.equal(prepared.status, 200, prepared.text);
  assert.deepEqual(Object.keys(prepared.body.value).sort(), ["confirm", "correlationId", "expiresAt"]);
  assert.deepEqual(Object.keys(prepared.body.value.confirm).sort(), ["expiresAt", "url"]);
  assert.ok(!prepared.text.includes("secret-token"), "the platform's token isn't passed on");
  assert.ok(!prepared.text.includes("intent"));
  fake.grantAnswers.ownerPrepare = [{ ok: true, value: { correlationId: "x", expiresAt: new Date(Date.now() + 600_000).toISOString(), digest: null, preview: { summary: "?" } } } as never];
  assert.equal((await call("POST", "unfreeze")).status, 503, "an answer in none of the forms is unavailable");
});

test("a malformed signature is refused unasked; a lost submit is unavailable, recorded and never sent again; the platform's refusal is action_refused", async () => {
  reset();
  const made = contract.ownerActionPrepared.parse((await call("POST", "freeze")).body.value);
  assert.deepEqual((await call("POST", `owner/actions/${made.correlationId}/submit`, { signedData: { standard: "nep413" } })).body, { ok: false, kind: "refused", code: "bad_request" });
  assert.equal(ownerSubmits().length, 0, "nothing relayed for a malformed one");
  fake.grantAnswers.submit = [new Error("socket hang up"), { ok: false, kind: "refused", status: 400, error: "signature invalid: detail" }, { ok: false, kind: "rate_limited", status: 429, error: "Request limit reached" }];
  assert.equal((await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!))).status, 503);
  assert.equal(ownerSubmits().length, 1, "the server never sends it again by itself: one call, however it answered");
  const refused = await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!));
  assert.deepEqual(refused.body, { ok: false, kind: "refused", code: "action_refused" });
  assert.ok(!refused.text.includes("detail"));
  const limited = await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!));
  assert.deepEqual([limited.status, limited.body], [429, { ok: false, kind: "refused", code: "platform_rate_limited" }]);
  assert.deepEqual(audit.filter(entry => entry.action === "owner-submit" && entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined),
    [{ ok: false, kind: "unavailable" }, { ok: false, kind: "refused", status: 400, code: "action_refused" },
      { ok: false, kind: "rate_limited", status: 429, code: "platform_rate_limited" }]);
  assert.deepEqual((await call("POST", "owner/actions/no-such-action/submit", signedFor(made.intent!))).body, { ok: false, kind: "refused", code: "no_action" });
  assert.deepEqual((await call("GET", "owner/actions/no-such-action")).body, { ok: false, kind: "refused", code: "no_action" });
});

test("a DAO's member asks for a freeze: prepared for the DAO's vote as the transaction they file, and no member submits a signature", async () => {
  reset();
  const prepared = await call("POST", "freeze", {}, council, "daoagent");
  assert.equal(prepared.status, 200, prepared.text);
  const made = contract.ownerActionPrepared.parse(prepared.body.value);
  assert.ok(made.dao && !made.intent, "a transaction to file, not an intent to sign");
  assert.deepEqual(prepares(), [`owner.prepare ${DAO.replaceAll(".", "--")} daoagent dao agent_freeze`]);
  assert.deepEqual(contract.ownerActionStatus.parse((await call("GET", `owner/actions/${made.correlationId}`, {}, council, "daoagent")).body.value), { stage: "voting" });
  assert.deepEqual((await call("POST", `owner/actions/${made.correlationId}/submit`, { signedData: { standard: "nep413", payload: { message: "m", recipient: "r", nonce: "n" }, public_key: "k", signature: "s" } }, council, "daoagent")).body,
    { ok: false, kind: "refused", code: "not_permitted" });
  assert.deepEqual((await call("POST", "unfreeze", {}, council, "daoagent")).body, { ok: false, kind: "refused", code: "action_pending" }, "held for the vote");
  fake.grants.find(item => item.correlationId === made.correlationId)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call("POST", "unfreeze", {}, council, "daoagent")).status, 200, "a vote that lapsed holds nothing");
});

test("the owner-action routes answer another account with not_owner and no session with not_signed_in, and relay nothing for either", async () => {
  reset();
  // The council member owns no wallet agent: `portfolio` is owner.near's.
  for (const [method, path] of [["POST", "freeze"], ["POST", "unfreeze"], ["GET", "owner/actions/x"], ["POST", "owner/actions/x/submit"]] as const) {
    const stranger = await call(method, path, {}, council, "portfolio");
    assert.deepEqual([stranger.status, stranger.body], [403, { ok: false, kind: "not_owner" }], path);
    const anonymous = await fetch(`${base}/api/agents/portfolio/${path}`, { method, headers: { ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) }, ...(method === "POST" && { body: "{}" }) });
    assert.equal(anonymous.status, 401, path);
  }
  assert.deepEqual(prepares(), []);
  assert.ok(!fake.calls.some(made => made.startsWith("grant.") || made.startsWith("reads.")), `nothing relayed: ${fake.calls.join(", ")}`);
});

test("a wallet owner revokes a grant: the grant named is what is prepared, signed here, recorded as a revocation; a bare or extra body is refused before anything is prepared", async () => {
  reset();
  assert.deepEqual((await call("POST", "grants/revoke", {})).body, { ok: false, kind: "refused", code: "bad_request" });
  assert.deepEqual((await call("POST", "grants/revoke", { grantId: "g1", extra: 1 })).body, { ok: false, kind: "refused", code: "bad_request" });
  assert.deepEqual(prepares(), [], "nothing prepared");
  const prepared = await call("POST", "grants/revoke", { grantId: "g1" });
  assert.equal(prepared.status, 200, prepared.text);
  const made = contract.ownerActionPrepared.parse(prepared.body.value);
  assert.ok(made.intent && !made.dao, "an intent to sign here");
  assert.deepEqual(prepares(), ["owner.prepare owner--near portfolio wallet grant_revoke"]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage]), [["grant-revoke", "attempt"], ["grant-revoke", "result"]]);
  const submitted = await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!));
  assert.deepEqual(submitted.body, { ok: true, value: { status: "SUCCESS", failureCode: null } });
});

test("a revocation is held only by another revocation whose outcome is unknown, never by a freeze; a connection without owner actions is refused", async () => {
  reset();
  fake.grants.push({ correlationId: "r1", agent: "portfolio", signer: "wallet", digest: "", stage: "submitted", expiresAt: new Date(Date.now() + 600_000).toISOString(), type: "grant_revoke" });
  assert.deepEqual((await call("POST", "grants/revoke", { grantId: "g2" })).body, { ok: false, kind: "refused", code: "action_pending" });
  assert.equal((await call("POST", "freeze")).status, 200, "a revocation doesn't hold a freeze");
  reset(["read", "treasury"]);
  assert.deepEqual((await call("POST", "grants/revoke", { grantId: "g1" })).body, { ok: false, kind: "refused", code: "owner_not_allowed" });
  assert.deepEqual(prepares(), []);
});

test("a DAO's member asks for a revocation: prepared for the vote as the transaction they file", async () => {
  reset();
  const prepared = await call("POST", "grants/revoke", { grantId: "g1" }, council, "daoagent");
  assert.equal(prepared.status, 200, prepared.text);
  assert.ok(contract.ownerActionPrepared.parse(prepared.body.value).dao, "a transaction to file");
  assert.deepEqual(prepares(), [`owner.prepare ${DAO.replaceAll(".", "--")} daoagent dao grant_revoke`]);
  assert.deepEqual((await call("POST", "grants/revoke", { grantId: "g2" }, council, "daoagent")).body, { ok: false, kind: "refused", code: "action_pending" }, "held for the vote");
});

const REVIEWED = { revision: 1, digest: DIGEST };
test("a wallet owner edits the policy: the reviewed revision and the changes are what is prepared, recorded as a policy update; a malformed edit is refused before anything is prepared", async () => {
  reset();
  for (const bad of [{}, { expectedPolicy: REVIEWED }, { expectedPolicy: { revision: 1, digest: "x" }, changes: {} }, { expectedPolicy: REVIEWED, changes: { owner_approval: true }, extra: 1 }])
    assert.deepEqual((await call("POST", "policy", bad)).body, { ok: false, kind: "refused", code: "bad_request" }, JSON.stringify(bad));
  assert.deepEqual(prepares(), [], "nothing prepared");
  const prepared = await call("POST", "policy", { expectedPolicy: REVIEWED, changes: { owner_approval: false } });
  assert.equal(prepared.status, 200, prepared.text);
  const made = contract.ownerActionPrepared.parse(prepared.body.value);
  assert.ok(made.intent && !made.dao && !made.policy, "an intent to sign here");
  assert.deepEqual(prepares(), ["owner.prepare owner--near portfolio wallet policy_update"]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage, entry.subject]), [["policy-update", "attempt", undefined], ["policy-update", "result", made.correlationId]], "recorded before and after");
  assert.deepEqual((await call("POST", `owner/actions/${made.correlationId}/submit`, signedFor(made.intent!))).body, { ok: true, value: { status: "SUCCESS", failureCode: null } });
});

test("a policy edit is held only by another policy edit whose outcome is unknown; a freeze or a revocation does not hold it", async () => {
  reset();
  const future = new Date(Date.now() + 600_000).toISOString();
  fake.grants.push({ correlationId: "f1", agent: "portfolio", signer: "wallet", digest: "", stage: "submitted", expiresAt: future, type: "agent_freeze" });
  fake.grants.push({ correlationId: "r1", agent: "portfolio", signer: "wallet", digest: "", stage: "submitted", expiresAt: future, type: "grant_revoke" });
  const edit = { expectedPolicy: REVIEWED, changes: { owner_approval: false } };
  assert.equal((await call("POST", "policy", edit)).status, 200);
  fake.grants.push({ correlationId: "p1", agent: "portfolio", signer: "wallet", digest: "", stage: "submitted", expiresAt: future, type: "policy_update" });
  assert.deepEqual((await call("POST", "policy", edit)).body, { ok: false, kind: "refused", code: "action_pending" });
  fake.grants.length = 0;
  fake.grants.push({ correlationId: "p2", agent: "portfolio", signer: "wallet", digest: "", stage: "submitted", expiresAt: future, type: "policy_update" });
  assert.equal((await call("POST", "freeze")).status, 200, "a policy edit doesn't hold a freeze");
});

test("a DAO member's policy edit is filed for the vote with the terms before and after beside it; a member without filing roles is refused before anything is prepared", async () => {
  reset();
  const edit = { expectedPolicy: REVIEWED, changes: { owner_approval: false } };
  const prepared = await call("POST", "policy", edit, council, "daoagent");
  assert.equal(prepared.status, 200, prepared.text);
  const made = contract.ownerActionPrepared.parse(prepared.body.value);
  assert.ok(made.dao && !made.intent, "a transaction to file");
  assert.deepEqual(made.policy, { current: { owner_approval: true }, requested: { owner_approval: false } }, "the member compares before filing");
  assert.deepEqual(prepares(), [`owner.prepare ${DAO.replaceAll(".", "--")} daoagent dao policy_update`]);
  fake.calls.length = 0;
  assert.deepEqual((await call("POST", "policy", edit, voter, "daoagent")).body, { ok: false, kind: "refused", code: "not_permitted" });
  assert.deepEqual(prepares(), [], "nothing prepared for a member who can only vote");
});

test("the policy history is relayed as the platform answers it", async () => {
  reset();
  fake.reads.policyHistory = [{ revision: 1, digest: DIGEST, at: "2026-11-01T00:00:00.000Z" }] as never;
  const read = await call("GET", "policy-history");
  assert.equal(read.status, 200, read.text);
  assert.ok(Array.isArray(read.body.value));
});

test("a policy edit that changes nothing is refused as no_change, with nothing prepared and nothing recorded", async () => {
  reset();
  const base = fake.reads.overview as any, saved = base.policy.policy;
  base.policy.policy = { frozen: false, actions: ["swap"], confidential: true, owner_approval: true, assets: "any", limits: {}, max_actions_per_hour: 10, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, destinations: { mode: "any", list: [] } };
  try {
    const same = await call("POST", "policy", { expectedPolicy: REVIEWED, changes: { owner_approval: true, max_actions_per_hour: 10 } });
    assert.deepEqual(same.body, { ok: false, kind: "refused", code: "no_change" });
    assert.deepEqual(prepares(), []);
    assert.deepEqual(audit, [], "refused before anything was attempted");
    assert.equal((await call("POST", "policy", { expectedPolicy: REVIEWED, changes: { owner_approval: false } })).status, 200, "a real change goes through");
  } finally { base.policy.policy = saved; }
});
