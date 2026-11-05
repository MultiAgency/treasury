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

const DAO = "agentic.sputnik-dao.near";
const owner = wallet("owner.near"), intruder = wallet("intruder.near"), council = wallet("council.near"), reader = wallet("reader.near"), admin = wallet("admin.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near", daoagent: DAO }, { daos: ["daoagent"] });
const policy: Policy = {
  proposal_bond: "100000000000000000000000", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
    { name: "council", kind: { Group: ["council.near"] }, permissions: ["call:AddProposal", "call:VoteApprove", "call:VoteReject"], vote_policy: {} },
    { name: "readers", kind: { Group: ["reader.near"] }, permissions: [], vote_policy: {} },
    { name: "admins", kind: { Group: ["admin.near"] }, permissions: ["*:*"], vote_policy: {} }],
};
const audit: AuditEntry[] = [];
let server: Server, base: string;
const cookies: Record<string, string> = {};

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000,
      keyLookup: standInKeyLookup(Object.fromEntries([owner, intruder, council, reader, admin].map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({ [DAO]: policy }, { [DAO]: [] }), daoRequests: await createDaoRequests(join(tempDir("treasury-funding-"), "dao-requests.json")),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const who of [owner, intruder, council, reader, admin]) cookies[who.accountId] = await signIn(who);
});
after(() => server.close());

async function signIn(who: ReturnType<typeof wallet>) {
  const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
  const response = await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(who.sign(issued.value)) });
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const call = async (method: "GET" | "POST", path: string, as: ReturnType<typeof wallet> = owner, body: unknown = {}) => {
  const response = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[as.accountId]!, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const agent = "/api/agents/portfolio";
const fundingCalls = () => fake.calls.filter(made => made.startsWith("funding."));
const reset = () => { fake.calls.length = 0; audit.length = 0; };

test("the linked account reads null until the owner links one; linked, it reads back with its balances", async () => {
  reset();
  assert.deepEqual(contract.treasuryRead.parse((await call("GET", `${agent}/treasury`)).body.value), { treasury: null });
  const linked = await call("POST", `${agent}/treasury/link`, owner, { accountId: "funds.near" });
  assert.deepEqual([linked.status, linked.body], [200, { ok: true, value: {} }]);
  const read = contract.treasuryRead.parse((await call("GET", `${agent}/treasury`)).body.value);
  assert.equal(read.treasury?.accountId, "funds.near");
  assert.deepEqual(fundingCalls(), ["funding.treasury owner--near portfolio", "funding.link owner--near portfolio funds.near", "funding.treasury owner--near portfolio"],
    "under the owner's Organization");
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage, entry.who, "answer" in entry ? entry.answer.ok : undefined]), [["link", "attempt", "owner.near", undefined], ["link", "result", "owner.near", true]]);
});

test("marking the account confidential and unlinking it are relayed once each, and recorded before and after", async () => {
  reset();
  assert.equal((await call("POST", `${agent}/treasury/confidential`, owner, { confidential: true })).status, 200);
  assert.equal(contract.treasuryRead.parse((await call("GET", `${agent}/treasury`)).body.value).treasury?.confidential, true);
  assert.equal((await call("POST", `${agent}/treasury/unlink`)).status, 200);
  assert.equal(contract.treasuryRead.parse((await call("GET", `${agent}/treasury`)).body.value).treasury, null);
  assert.deepEqual(fundingCalls().filter(made => !made.startsWith("funding.treasury")),
    ["funding.setConfidential owner--near portfolio true", "funding.unlink owner--near portfolio"]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage]), [["confidential", "attempt"], ["confidential", "result"], ["unlink", "attempt"], ["unlink", "result"]]);
});

test("a malformed change is refused before anything is asked or recorded", async () => {
  reset();
  for (const [path, body] of [["link", { accountId: "Not An Account" }], ["link", {}], ["confidential", { confidential: "yes" }], ["unlink", { extra: 1 }]] as const)
    assert.deepEqual((await call("POST", `${agent}/treasury/${path}`, owner, body)).body, { ok: false, kind: "refused", code: "bad_request" }, path);
  assert.deepEqual([fundingCalls(), audit], [[], []]);
});

test("the platform's refusal is funding_refused without its text, no consent is not_connected, and a lost answer is unavailable: each recorded", async () => {
  reset();
  fake.fundingAnswers.link = [{ ok: false, kind: "refused", status: 400, error: "account does not exist: secret detail" },
    { ok: false, kind: "forbidden", status: 403, error: "No live owner consent" }, new Error("socket hang up")];
  const answers = [];
  for (let i = 0; i < 3; i++) answers.push(await call("POST", `${agent}/treasury/link`, owner, { accountId: "funds.near" }));
  assert.deepEqual(answers.map(({ status, body }) => [status, body]), [
    [409, { ok: false, kind: "refused", code: "funding_refused" }],
    [409, { ok: false, kind: "refused", code: "not_connected" }],
    [503, { ok: false, kind: "unavailable" }],
  ]);
  assert.ok(!answers[0]!.text.includes("secret detail"), "the platform's text stays on the server");
  assert.deepEqual(audit.filter(entry => entry.stage === "result").map(entry => "answer" in entry ? entry.answer : undefined), [
    { ok: false, kind: "refused", status: 400, code: "funding_refused" },
    { ok: false, kind: "forbidden", status: 403, code: "not_connected" },
    { ok: false, kind: "unavailable" },
  ]);
});

test("a deposit address is asked for by asset, NEAR as wNEAR, each one fresh; any other asset is refused unasked", async () => {
  reset();
  const usdc = await call("POST", `${agent}/deposit`, owner, { asset: "USDC" });
  assert.equal(usdc.status, 200, usdc.text);
  const first = contract.depositRead.parse(usdc.body.value).deposit;
  const near = contract.depositRead.parse((await call("POST", `${agent}/deposit`, owner, { asset: "NEAR" })).body.value).deposit;
  assert.notEqual(first.address, near.address);
  assert.deepEqual((await call("POST", `${agent}/deposit`, owner, { asset: "ETH" })).body, { ok: false, kind: "refused", code: "bad_request" });
  assert.deepEqual(fundingCalls(), [
    "funding.deposit owner--near portfolio nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "funding.deposit owner--near portfolio nep141:wrap.near",
  ]);
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage, entry.subject]),
    [["deposit", "attempt", undefined], ["deposit", "result", first.correlationId], ["deposit", "attempt", undefined], ["deposit", "result", near.correlationId]]);
});

test("someone else's agent is not_owner for every funding route, and nothing is asked", async () => {
  reset();
  for (const [method, path, body] of [["GET", "treasury", undefined], ["POST", "deposit", { asset: "USDC" }], ["POST", "treasury/link", { accountId: "funds.near" }],
    ["POST", "treasury/unlink", {}], ["POST", "treasury/confidential", { confidential: false }]] as const)
    assert.deepEqual((await call(method, `${agent}/${path}`, intruder, body)).body, { ok: false, kind: "not_owner" }, path);
  assert.deepEqual(fundingCalls(), []);
});

test("a DAO's council reads its funding account and asks for a deposit address, but its funding account is the DAO: no link, unlink or setting", async () => {
  reset();
  const dao = "/api/agents/daoagent";
  assert.equal((await call("GET", `${dao}/treasury`, council)).status, 200);
  assert.equal((await call("POST", `${dao}/deposit`, council, { asset: "USDC" })).status, 200);
  for (const [path, body] of [["link", { accountId: "funds.near" }], ["unlink", {}], ["confidential", { confidential: true }]] as const) {
    assert.deepEqual((await call("POST", `${dao}/treasury/${path}`, council, body)).body, { ok: false, kind: "refused", code: "not_permitted" }, path);
    // A member with every DAO permission passes the roles check, and is refused all the same.
    assert.deepEqual((await call("POST", `${dao}/treasury/${path}`, admin, body)).body, { ok: false, kind: "refused", code: "dao_funding_fixed" }, `${path}, every permission`);
  }
  const organization = DAO.replaceAll(".", "--");
  assert.deepEqual(fundingCalls(), [`funding.treasury ${organization} daoagent`,
    `funding.deposit ${organization} daoagent nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`]);
  assert.deepEqual(audit.map(entry => entry.action), ["deposit", "deposit"]);
});

test("a DAO member whose roles don't allow filing proposals may read the funding account, but not ask for a deposit address", async () => {
  reset();
  assert.equal((await call("GET", "/api/agents/daoagent/treasury", reader)).status, 200);
  assert.deepEqual((await call("POST", "/api/agents/daoagent/deposit", reader, { asset: "USDC" })).body, { ok: false, kind: "refused", code: "not_permitted" });
  assert.deepEqual(fundingCalls(), [`funding.treasury ${DAO.replaceAll(".", "--")} daoagent`]);
});
