import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createAgentTokens, memoryTokenRecords } from "../src/agent-tokens.ts";
import type { AuditEntry } from "../src/audit.ts";
import { createDaoRequests } from "../src/dao-requests.ts";
import { standInDaos } from "../src/dao.ts";
import { createServer } from "../src/http.ts";
import { standInKeyLookup } from "../src/keys.ts";
import { createSessions } from "../src/sessions.ts";
import { createSignIn } from "../src/signin.ts";
import { createStrategyProposals, memoryProposalRecords } from "../src/strategy-proposals.ts";
import { OVERVIEW } from "./fakes.ts";
import { fakePlatform, HOST, ORIGIN, wallet } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const DAY = 86_400_000;
const owner = wallet("owner.near"), stranger = wallet("stranger.near");
const fake = fakePlatform({ portfolio: "owner.near", elsewhere: "owner.near" });
const audit: AuditEntry[] = [];
const time = { now: Date.now() };
const cookies: Record<string, string> = {};
let server: Server, base: string;
const strategyProposals = createStrategyProposals(memoryProposalRecords(), { audit: { append: async entry => { audit.push(entry); } } });

before(async () => {
  server = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup(Object.fromEntries([owner, stranger].map(who => [who.accountId, [who.publicKey]]))) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async entry => { audit.push(entry); } }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}, {}), daoRequests: await createDaoRequests(join(tempDir("treasury-token-routes-"), "dao-requests.json")),
    agentTokens: createAgentTokens(memoryTokenRecords(), { now: () => time.now }), tokenRequestsPerHour: 8, tokenBudgetPerHour: 1_000, strategyProposals,
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const who of [owner, stranger]) {
    const issued = await (await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).json() as any;
    cookies[who.accountId] = (await fetch(`${base}/api/session`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(who.sign(issued.value)) }))
      .headers.get("set-cookie")!.split(";")[0]!;
  }
});
after(() => server.close());

const consent = (agent: string) => ({ id: `c-${agent}`.padEnd(64, "0"), deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near", agent, agentId: `id-${agent}`,
  scopes: ["owner", "read", "treasury"] as ("owner" | "read" | "treasury")[], expiresAt: Date.now() + 86_400_000, createdAt: 0, publicKey: "k", revoked: false, revokedAt: null });
const reset = () => { fake.calls.length = 0; audit.length = 0; fake.consents.length = 0; fake.consents.push(consent("portfolio"), consent("elsewhere")); fake.schedules.portfolio = { on: false, unbound: true }; };
/** A call from the owner's page: the session cookie and the server's own origin. */
const session = async (method: "GET" | "POST", path: string, body: unknown = {}, as = owner, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/${path}`, { method, headers: { cookie: cookies[as.accountId]!, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
/** A call from software holding a token: no cookie, no origin. */
const bearer = async (token: string, method: "GET" | "POST", path: string, body?: unknown, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(method === "POST" && { "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body ?? {}) }) });
  return { status: response.status, body: await response.json() as any };
};
const issue = async (days = 7, label = "rebalancer") => {
  const made = await session("POST", "tokens", { days, label });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.value as { token: string; view: { id: string; label: string; createdAt: string; expiresAt: string; lastUsedAt: string | null } };
};

test("the owner issues a token for one agent, sees it listed without its secret, and revokes it; the next call by it is refused", async () => {
  reset();
  const { token, view } = await issue(7, "rebalancer");
  assert.match(token, /^tre1\./);
  assert.equal(view.label, "rebalancer");
  assert.equal(Date.parse(view.expiresAt) - Date.parse(view.createdAt), 7 * DAY);
  const listed = await session("GET", "tokens");
  assert.deepEqual(listed.body.value.map((item: { id: string }) => item.id), [view.id]);
  assert.equal(JSON.stringify(listed.body).includes(token.split(".")[2]!), false, "never the secret again");
  assert.equal((await bearer(token, "GET", "overview")).status, 200);
  assert.equal((await session("POST", `tokens/${view.id}/revoke`)).status, 200);
  assert.deepEqual((await bearer(token, "GET", "overview")).body, { ok: false, kind: "refused", code: "invalid_token" });
  assert.deepEqual((await session("GET", "tokens")).body.value, []);
  assert.deepEqual((await session("POST", `tokens/${view.id}/revoke`)).body, { ok: false, kind: "refused", code: "no_token" });
});

test("a token reads what the owner reads, and the listing shows when it was last used", async () => {
  reset();
  const { token, view } = await issue();
  for (const path of ["overview", "activity", "unresolved", "strategy", "autopilot", "proposals"]) assert.equal((await bearer(token, "GET", path)).status, 200, path);
  assert.notEqual((await session("GET", "tokens")).body.value.find((item: { id: string }) => item.id === view.id).lastUsedAt, null);
});

test("a proposal by token is relayed once and recorded with the token's ID", async () => {
  reset();
  const { token, view } = await issue();
  fake.calls.length = 0; audit.length = 0;
  const made = await bearer(token, "POST", "proposals", { requestId: "agent-rebalance-1" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(fake.calls.filter(call => call.startsWith("proposals.create")).length, 1, "relayed once");
  assert.deepEqual(audit.map(entry => [entry.who, entry.action, entry.stage]), [[`token:${view.id}`, "propose", "attempt"], [`token:${view.id}`, "propose", "result"]]);
  assert.equal((await bearer(token, "POST", "proposals", { requestId: "bad id!" })).status, 400);
});

test("a token is refused on every route outside its set, and nothing reaches the platform", async () => {
  reset();
  const { token } = await issue();
  fake.calls.length = 0;
  const outside: [("GET" | "POST"), string][] = [["POST", "freeze"], ["POST", "unfreeze"], ["POST", "sweep"], ["POST", "autopilot/enable"], ["POST", "strategy"], ["POST", "tokens"], ["GET", "tokens"],
    ["POST", "consent/revoke"], ["POST", "proposals/abc/approve"], ["POST", "proposals/abc/execute"], ["GET", "consent"], ["GET", "treasury"], ["GET", "owner/actions"], ["POST", "deposit"]];
  for (const [method, path] of outside) {
    const answer = await bearer(token, method, path);
    assert.deepEqual([answer.status, answer.body], [403, { ok: false, kind: "refused", code: "token_not_allowed" }], `${method} ${path}`);
  }
  assert.deepEqual(fake.calls, [], "nothing was relayed");
});

test("a token works only for its own agent, and a made-up or malformed one is refused", async () => {
  reset();
  const { token } = await issue();
  assert.deepEqual((await bearer(token, "GET", "overview", undefined, "elsewhere")).body, { ok: false, kind: "refused", code: "token_not_allowed" });
  for (const wrong of [token.slice(0, -2) + "xx", "tre1.0000000000000000." + "A".repeat(43), "nonsense", ""]) {
    assert.deepEqual((await bearer(wrong, "GET", "overview")).body, { ok: false, kind: "refused", code: "invalid_token" }, wrong);
  }
  const response = await fetch(`${base}/api/agents/portfolio/overview`, { headers: { authorization: token } });
  assert.equal(response.status, 401, "not a Bearer header");
});

test("an expired token is refused", async () => {
  reset();
  const { token } = await issue(1);
  assert.equal((await bearer(token, "GET", "overview")).status, 200);
  time.now += 2 * DAY;
  try { assert.deepEqual((await bearer(token, "GET", "overview")).body, { ok: false, kind: "refused", code: "invalid_token" }); }
  finally { time.now -= 2 * DAY; }
});

test("disconnecting the agent revokes its tokens, and only its own", async () => {
  reset();
  const mine = await issue(), other = (await (async () => {
    const made = await session("POST", "tokens", { days: 3 }, owner, "elsewhere");
    return made.body.value as { token: string };
  })());
  assert.equal((await session("POST", "consent/revoke")).status, 200);
  assert.deepEqual((await bearer(mine.token, "GET", "overview")).body, { ok: false, kind: "refused", code: "invalid_token" });
  assert.equal((await bearer(other.token, "GET", "overview", undefined, "elsewhere")).status, 200, "another agent's stays");
});

test("a token is counted on its own: the account's page is unaffected when it is over its limit", async () => {
  reset();
  const { token } = await issue();
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await bearer(token, "GET", "overview")).status);
  assert.deepEqual(statuses.slice(-2), [429, 429], "past 8 an hour");
  assert.equal((await session("GET", "overview")).status, 200, "the owner's own page");
});

test("only the agent's owner issues, lists or revokes tokens", async () => {
  reset();
  const { view } = await issue();
  for (const [method, path] of [["POST", "tokens"], ["GET", "tokens"], ["POST", `tokens/${view.id}/revoke`]] as const) {
    assert.deepEqual((await session(method, path, { days: 1 }, stranger)).body, { ok: false, kind: "not_owner" }, `${method} ${path}`);
  }
  assert.equal((await session("POST", "tokens", { days: 31 })).status, 400, "at most 30 days");
  assert.equal((await session("POST", "tokens", {})).status, 400);
  assert.deepEqual(audit.filter(entry => entry.action === "token-issue").map(entry => [entry.who, entry.stage]), [["owner.near", "attempt"], ["owner.near", "result"]], "recorded before and after, by the account");
});

test("the API description is public and lists exactly the routes a token may call", async () => {
  const answer = await (await fetch(`${base}/api/agent-api`)).json() as any;
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.value.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`).sort(), [
    "GET /api/agents/:agent/activity", "GET /api/agents/:agent/autopilot", "GET /api/agents/:agent/overview", "GET /api/agents/:agent/proposals", "GET /api/agents/:agent/proposals/:id",
    "GET /api/agents/:agent/strategy", "GET /api/agents/:agent/unresolved", "POST /api/agents/:agent/proposals", "POST /api/agents/:agent/strategy-proposals"]);
  const posted = (path: string) => answer.value.routes.find((route: { method: string; path: string }) => route.method === "POST" && route.path === path);
  assert.ok(posted("/api/agents/:agent/proposals").request.properties.requestId, "the request schema is described");
  assert.deepEqual(Object.keys(posted("/api/agents/:agent/strategy-proposals").request.properties).sort(), ["expectedDigest", "reasons", "strategy"]);
});

test("all tokens together stay within their share of the platform's hourly budget, whichever token makes the calls", async () => {
  reset();
  // A server of its own, so the budget isn't spent by the other tests: 3 calls an hour per token, 5 for every token together.
  const store = createAgentTokens(memoryTokenRecords());
  const small = createHttpServer(createServer({
    platform: fake.platform,
    signIn: createSignIn({ recipient: HOST, ttlMs: 5 * 60_000, perMinute: 1_000, keyLookup: standInKeyLookup({}) }),
    sessions: createSessions({ idleMs: 30 * 60_000, maxMs: 12 * 60 * 60_000 }),
    publicOrigin: ORIGIN, deployment: "treasury", trustedProxyHops: 0, ownerRequestsPerMinute: 1_000,
    audit: { append: async () => {} }, consentsPerDay: 1_000, daoFilingsPerDay: 1_000, keyLookup: async () => "full",
    daos: standInDaos({}, {}), daoRequests: await createDaoRequests(join(tempDir("treasury-token-budget-"), "dao-requests.json")),
    agentTokens: store, tokenRequestsPerHour: 3, tokenBudgetPerHour: 5,
  }));
  await new Promise<void>(resolve => small.listen(0, "127.0.0.1", resolve));
  try {
    const at = `http://127.0.0.1:${(small.address() as AddressInfo).port}`;
    const read = async (token: string) => (await fetch(`${at}/api/agents/portfolio/overview`, { headers: { authorization: `Bearer ${token}` } })).status;
    const [first, second] = [await store.issue({ agent: "portfolio", account: "owner.near", days: 7 }), await store.issue({ agent: "portfolio", account: "owner.near", days: 7 })];
    const firstCalls = [await read(first!.token), await read(first!.token), await read(first!.token), await read(first!.token)];
    assert.deepEqual(firstCalls, [200, 200, 200, 429], "one token: 3 an hour");
    const secondCalls = [await read(second!.token), await read(second!.token), await read(second!.token)];
    assert.deepEqual(secondCalls, [200, 200, 429], "every token together: 5 an hour, so the second gets what the first left");
    const relayed = fake.calls.filter(call => call.startsWith("reads.overview")).length;
    assert.equal(relayed, 5, "the platform was asked 5 times, not 7");
  } finally {
    small.close();
  }
});

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const DIGEST = `sha256:${"a".repeat(64)}`;
const strategy = { targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, minLegUsd: 2, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 0 } };
/** The agent's overview under a policy that may move `assets`. */
const policyOf = (assets: "any" | string[]) => ({ ...OVERVIEW, policy: { ...OVERVIEW.policy, policy: { frozen: false, actions: ["swap"], confidential: true, owner_approval: true, assets,
  limits: {}, budget: {}, max_actions_per_hour: null } } }) as typeof OVERVIEW;

test("a token proposes a strategy with its reasons: stored for the owner under the token's ID, recorded by it, and its next one replaces it (#206)", async () => {
  reset();
  fake.reads.overview = policyOf([USDC, WNEAR]);
  const { token, view } = await issue();
  fake.calls.length = 0; audit.length = 0;
  const made = await bearer(token, "POST", "strategy-proposals", { strategy, reasons: "Hold more NEAR while it's cheap.", expectedDigest: DIGEST });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.deepEqual(fake.calls.filter(call => !call.startsWith("identity")), ["reads.overview owner--near portfolio"], "one read, for the policy's assets");
  assert.deepEqual(audit.map(entry => [entry.who, entry.action, entry.stage, entry.subject]),
    [[`token:${view.id}`, "strategy-propose", "attempt", made.body.value.id], [`token:${view.id}`, "strategy-propose", "result", made.body.value.id]]);
  const listed = await session("GET", "strategy-proposals");
  assert.deepEqual(listed.body.value.map((p: { id: string; source: string; reasons: string; against: string }) => [p.id, p.source, p.reasons, p.against]),
    [[made.body.value.id, `token:${view.id}`, "Hold more NEAR while it's cheap.", DIGEST]]);

  const again = await bearer(token, "POST", "strategy-proposals", { strategy: { ...strategy, maxCostBps: 60 }, reasons: "A tighter cost limit.", expectedDigest: DIGEST });
  assert.equal(again.status, 200);
  assert.deepEqual((await session("GET", "strategy-proposals")).body.value.map((p: { id: string }) => p.id), [again.body.value.id], "one open per token");
  fake.reads.overview = OVERVIEW;
});

test("a token's malformed proposal, or one targeting an asset outside the policy, is refused and nothing is stored (#206)", async () => {
  reset();
  fake.reads.overview = policyOf([USDC]);
  const { token } = await issue();
  const before = (await session("GET", "strategy-proposals")).body.value.length;
  audit.length = 0;
  const malformed: unknown[] = [
    { strategy, reasons: "", expectedDigest: DIGEST },
    { strategy, reasons: "x".repeat(2_001), expectedDigest: DIGEST },
    { strategy: { ...strategy, maxCostBps: 1_001 }, reasons: "why", expectedDigest: DIGEST },
    { strategy, reasons: "why", expectedDigest: "abc" },
    { strategy, reasons: "why", expectedDigest: DIGEST, extra: 1 },
  ];
  for (const body of malformed) assert.deepEqual((await bearer(token, "POST", "strategy-proposals", body)).body, { ok: false, kind: "refused", code: "bad_request" }, JSON.stringify(body).slice(0, 80));
  assert.deepEqual((await bearer(token, "POST", "strategy-proposals", { strategy, reasons: "why", expectedDigest: DIGEST })).body,
    { ok: false, kind: "refused", code: "strategy_not_allowed" }, "wNEAR is outside a policy of USDC");
  assert.equal((await session("GET", "strategy-proposals")).body.value.length, before);
  assert.deepEqual(audit.filter(entry => entry.action === "strategy-propose"), [], "nothing recorded");
  fake.reads.overview = OVERVIEW;
});

test("the owner's own session can't propose a strategy: the owner changes it on the Strategy page (#206)", async () => {
  reset();
  assert.deepEqual((await session("POST", "strategy-proposals", { strategy, reasons: "why", expectedDigest: DIGEST })).body, { ok: false, kind: "refused", code: "token_only" });
});

test("a token's strategy proposals count against its hourly limit like any of its calls (#206)", async () => {
  reset();
  fake.reads.overview = policyOf("any");
  const { token } = await issue();
  const answers: number[] = [];
  for (let i = 0; i < 9; i++) answers.push((await bearer(token, "POST", "strategy-proposals", { strategy, reasons: `Proposal ${i}`, expectedDigest: DIGEST })).status);
  assert.deepEqual(answers, [200, 200, 200, 200, 200, 200, 200, 200, 429], "8 an hour in this server's settings");
  fake.reads.overview = OVERVIEW;
});
