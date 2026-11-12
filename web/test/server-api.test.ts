import { test } from "node:test";
import assert from "node:assert/strict";
import { serverApi } from "../src/server-api.ts";
import { fail, ID, lost, ok, proposal, refused, scripted } from "./server-fixtures.ts";

const NONCE = `${"A".repeat(43)}=`, KEY = `ed25519:${"1".repeat(44)}`;
const base = "/api/agents/portfolio";

test("each route is called same-origin, as the server expects: reads as GETs, writes as JSON POSTs, sign-out a bodiless DELETE", async () => {
  const server = scripted();
  const api = serverApi(server.fetcher), agent = api.agent("portfolio");
  const signed = { message: "m", nonce: NONCE, publicKey: KEY, signature: "s" };
  server.answer("POST /api/session/challenge", ok({ message: "Sign in", recipient: "treasury.test", nonce: NONCE }));
  server.answer("POST /api/session", ok({ account: "owner.near" }));
  server.answer("DELETE /api/session", ok({}));
  server.answer(`GET ${base}`, ok({ agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test",
    signer: "wallet", account: "owner.near", access: { canSign: true, canPropose: false, canVote: false, canExecute: true, canManage: true } }));
  server.answer(`GET ${base}/consent`, ok({ consent: null }));
  server.answer(`POST ${base}/consent/text`, ok({ message: "consent", nonce: NONCE, recipient: "platform.test" }));
  server.answer(`POST ${base}/consent`, ok({ consent: { id: "c1", scopes: ["read", "treasury"], expiresAt: 1 } }));
  server.answer(`POST ${base}/consent/revoke`, ok({ revoked: 1 }));
  server.answer(`GET ${base}/proposals`, ok({ proposals: [proposal()] }));
  server.answer(`GET ${base}/proposals/${ID}`, ok({ proposal: proposal() }));
  server.answer(`POST ${base}/proposals/${ID}/approve`, ok({ proposal: proposal({ state: "approved" }) }));
  server.answer(`POST ${base}/proposals/${ID}/reject`, ok({ proposal: proposal({ state: "rejected" }) }));
  const executed = proposal({ state: "executed" });
  server.answer(`POST ${base}/proposals/${ID}/execute`, ok({ result: "final", proposal: executed }));

  assert.deepEqual(await api.challenge(), { ok: true, value: { message: "Sign in", recipient: "treasury.test", nonce: NONCE } });
  assert.deepEqual(await api.signIn({ accountId: "owner.near", publicKey: KEY, signature: "s", nonce: NONCE }), { ok: true, value: { account: "owner.near" } });
  assert.deepEqual(await api.signOut(), { ok: true, value: {} });
  assert.equal((await agent.identity()).ok, true);
  assert.deepEqual(await agent.consent(), { ok: true, value: { consent: null } });
  assert.equal((await agent.consentText()).ok, true);
  assert.equal((await agent.connect(signed)).ok, true);
  assert.deepEqual(await agent.disconnect(), { ok: true, value: { revoked: 1 } });
  assert.equal((await agent.proposals()).ok, true);
  assert.equal((await agent.proposal(ID)).ok, true);
  assert.equal((await agent.verdict(ID, "approve", signed)).ok, true);
  assert.equal((await agent.verdict(ID, "reject", signed)).ok, true);
  assert.deepEqual(await agent.execute(ID), { ok: true, value: { result: "final", proposal: executed } });

  for (const request of server.sent) {
    assert.equal(request.credentials, "same-origin", request.path);
    assert.ok(request.path.startsWith("/api/"), "only the app server's own routes");
    if (request.method === "POST") {
      assert.equal(request.headers["content-type"], "application/json", request.path);
      assert.doesNotThrow(() => JSON.parse(request.body), "a POST always carries a JSON body");
    } else assert.deepEqual([request.headers["content-type"], request.body], [undefined, ""], `${request.method} ${request.path}`);
  }
  assert.deepEqual(JSON.parse(server.sent.find(request => request.path.endsWith("/approve"))!.body), signed, "the signed body, as signed");
  assert.equal(server.sent.find(request => request.path.endsWith("/execute"))!.body, "{}");
});

test("for a DAO-owned agent, filing its consent and its vote are bodiless JSON POSTs to the same routes, answered with the request", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const transaction = { receiverId: "agentic.sputnik-dao.near", actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: { proposal: {} }, gas: "1", deposit: "0" } }] };
  const request = (verdict?: "approve" | "reject") => ({ id: "d".repeat(64), description: "* Signs: hash", votingUntil: 1, check: "https://platform.test/confirm/dao/d",
    ...(verdict && { verdict }), offer: { state: "file", transaction } });
  server.answer(`POST ${base}/consent/text`, ok({ request: request() }));
  server.answer(`POST ${base}/proposals/${ID}/reject`, ok({ request: request("approve") }));
  server.answer(`GET ${base}/proposals/${ID}`, ok({ proposal: proposal(), vote: request("approve") }));
  assert.deepEqual(await agent.fileConsent(), { ok: true, value: { request: request() } });
  assert.deepEqual(await agent.fileVote(ID, "reject"), { ok: true, value: { request: request("approve") } }, "the open vote, with its own verdict");
  const read = await agent.proposal(ID);
  assert.deepEqual(read.ok && read.value.vote, request("approve"), "a proposal's read carries the DAO's vote while it waits");
  for (const sent of server.sent.filter(item => item.method === "POST")) assert.equal(sent.body, "{}", `${sent.path}: the browser sends nothing for a DAO`);
});

test("every failure the server answers is its kind and code; an answer the contract doesn't describe is lost", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const route = `GET ${base}/proposals/${ID}`;
  server.answer(route,
    fail({ kind: "not_signed_in" }, 401), fail({ kind: "not_owner" }, 403), refused("not_connected"), fail({ kind: "unavailable" }, 503),
    lost,
    () => new Response("<html>Bad gateway</html>", { status: 502 }),
    ok({ proposal: { ...proposal(), state: "pondering" } }),
    fail({ kind: "refused" }, 409),
    fail({ kind: "unavailable", error: "platform text" }, 503),
    () => Response.json({ ok: true }, { status: 200 }));
  const answers = [];
  for (let i = 0; i < 10; i++) answers.push(await agent.proposal(ID));
  assert.deepEqual(answers, [
    { ok: false, kind: "not_signed_in" }, { ok: false, kind: "not_owner" }, { ok: false, kind: "refused", code: "not_connected" },
    { ok: false, kind: "unavailable" },
    ...Array(6).fill({ ok: false, kind: "lost" }),
  ], "the network, a non-JSON body, an unknown state, a refusal without its code, a failure with extra keys and a success without a value");
});

test("every execute answer parses: final, pending with or without a proposal, and not_executable", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const route = `POST ${base}/proposals/${ID}/execute`;
  server.answer(route, ok({ result: "pending", proposal: null }), ok({ result: "pending", proposal: proposal({ state: "approved" }) }),
    ok({ result: "not_executable", proposal: proposal({ state: "approved" }) }), ok({ result: "not_executable", proposal: null }), ok({ result: "done", proposal: proposal() }));
  assert.deepEqual(await agent.execute(ID), { ok: true, value: { result: "pending", proposal: null } });
  assert.equal((await agent.execute(ID)).ok, true);
  assert.equal((await agent.execute(ID)).ok, true);
  assert.deepEqual(await agent.execute(ID), { ok: false, kind: "lost" }, "not_executable always carries the proposal");
  assert.deepEqual(await agent.execute(ID), { ok: false, kind: "lost" }, "no such result");
});

test("inputs are held to the server's own schemas before anything is sent", () => {
  const server = scripted(), api = serverApi(server.fetcher);
  assert.throws(() => api.agent("Not An Agent"));
  const agent = api.agent("portfolio");
  assert.throws(() => agent.proposal("not-a-proposal-id"), "proposal IDs are 32 lowercase hex characters");
  assert.throws(() => agent.verdict(ID, "approve", { message: "m", nonce: "short", publicKey: KEY, signature: "s" }), "a nonce of 32 bytes only");
  assert.throws(() => agent.verdict(ID, "approve", { message: "m", nonce: NONCE, publicKey: KEY, signature: "s", extra: 1 } as never), "no extra keys");
  assert.throws(() => api.signIn({ accountId: "Owner", publicKey: KEY, signature: "s", nonce: NONCE }));
  assert.deepEqual(server.sent, []);
});

test("setup: the account's treasuries, the setup text and the signed setup, a DAO's setup, and an agent's creation and its status", async () => {
  const server = scripted(), api = serverApi(server.fetcher), agent = api.agent("treasury-1");
  const signed = { message: "setup", nonce: NONCE, publicKey: KEY, signature: "s" };
  const transaction = { receiverId: "agentic.sputnik-dao.near", actions: [{ type: "FunctionCall", params: { methodName: "add_proposal", args: { proposal: {} }, gas: "1", deposit: "0" } }] };
  const dao = "/api/setup/dao/agentic.sputnik-dao.near";
  server.answer("GET /api/setup", ok({ account: "owner.near", agents: ["treasury-1"] }));
  server.answer("POST /api/setup/text", ok({ message: "setup", nonce: NONCE, recipient: "platform.test" }));
  server.answer("POST /api/setup", ok({ agent: "treasury-1" }));
  const access = { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: false };
  server.answer(`GET ${dao}`, ok({ account: "council.near", access, agents: [], request: null, ended: "expired" }));
  server.answer(`POST ${dao}`, ok({ request: { id: "e".repeat(64), description: "* Signs", votingUntil: 1, check: "https://platform.test/confirm/dao/e", offer: { state: "file", transaction } } }));
  server.answer("POST /api/agents/treasury-1/creation", ok({ correlationId: "create-1", expiresAt: "2026-11-05T00:10:00.000Z",
    confirm: { url: "https://platform.test/confirm/create-1", expiresAt: "2026-11-05T00:10:00.000Z" } }));
  server.answer("GET /api/agents/treasury-1/creation/create-1", ok({ stage: "voting" }));

  assert.deepEqual(await api.setups(), { ok: true, value: { account: "owner.near", agents: ["treasury-1"] } });
  assert.equal((await api.setupText()).ok, true);
  assert.deepEqual(await api.setup(signed), { ok: true, value: { agent: "treasury-1" } });
  assert.deepEqual(await api.daoSetup("agentic.sputnik-dao.near"), { ok: true, value: { account: "council.near", access, agents: [], request: null, ended: "expired" } });
  assert.equal((await api.fileDaoSetup("agentic.sputnik-dao.near")).ok, true);
  assert.equal((await agent.create()).ok, true);
  assert.deepEqual(await agent.creation("create-1"), { ok: true, value: { stage: "voting" } });
  assert.deepEqual(JSON.parse(server.sent.find(request => request.path === "/api/setup" && request.method === "POST")!.body), signed, "the signed body, as signed");
  // Nothing typed reaches a path unchecked: a DAO is an account ID, a correlation ID a token.
  assert.throws(() => api.daoSetup("../agents"));
  assert.throws(() => agent.creation("../consent"));
});

test("the owner reads: each a GET of the agent's route, parsed by the server's contract, amounts kept as exact decimal strings", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const big = "123456789012345678901234567";
  const policy = { wallet_id: "w", revision: 3, status: "APPLIED", provider_policy_synced: true, cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
    policy: null, usage: { budget: Object.fromEntries(["daily", "weekly", "monthly"].map(w => [w, { limit_usd: null, spent_usd: "0.000000", remaining_usd: null, resets_at: null }])),
      timelock: { delay_ms: 0, scheduled_count: 0 } } };
  const overview = { agentId: "id-portfolio", book: [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, public: "0", confidential: big, price: 2.5,
    priceUpdatedAt: null, priceExpiresAt: null, usd: 308.64 }], unmanaged: [], target: {}, rebalance: { minLegUsd: 10, maxCostBps: 50 }, policy,
    digest: null, notInForce: null, agreed: [], grants: [] };
  const row = { at: "2026-11-05T00:00:00.000Z", kind: "swap", request: { amount: big }, correlationId: "c1", status: "SUCCESS" };
  server.answer(`GET ${base}/overview`, ok(overview));
  server.answer(`GET ${base}/activity`, ok([row]));
  server.answer(`GET ${base}/held`, ok([]));
  server.answer(`GET ${base}/unresolved`, ok([]));
  server.answer(`GET ${base}/runs`, ok({ ticks: [], corrupt: [] }));
  server.answer(`GET ${base}/requests/watch-7`, ok({ proposal: proposal() }));
  server.answer(`GET ${base}/operations/c1`, ok({ correlationId: "c1", at: row.at, kind: "swap", status: null, refused: null }));

  const read = await agent.overview();
  assert.equal(read.ok && read.value.book[0]!.confidential, big, "a string, never a number");
  assert.deepEqual(await agent.activity(), { ok: true, value: [row] });
  assert.deepEqual(await agent.held(), { ok: true, value: [] });
  assert.deepEqual(await agent.unresolved(), { ok: true, value: [] });
  assert.deepEqual(await agent.runs(), { ok: true, value: { ticks: [], corrupt: [] } });
  assert.equal((await agent.request("watch-7")).ok, true);
  assert.deepEqual(await agent.operation("c1"), { ok: true, value: { correlationId: "c1", at: row.at, kind: "swap", status: null, refused: null } });
  assert.ok(server.sent.every(request => request.method === "GET"));
  // An amount sent as a number doesn't pass for one: the answer can't be read.
  server.answer(`GET ${base}/overview`, ok({ ...overview, book: [{ ...overview.book[0], confidential: 1.2345678901234568e26 }] }));
  assert.deepEqual(await agent.overview(), { ok: false, kind: "lost" });
  assert.throws(() => agent.request("../consent"));
  assert.throws(() => agent.recording("../consent"));
});

test("funding: the account and the funding account as GETs, a deposit address and each change to the funding account as one JSON POST", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const linked = { accountId: "funds.near", dao: null, balances: { near: "306132631859932448916007858", usdc: "305530000" }, confidential: false, payees: [] };
  const deposit = { correlationId: "d1", address: "a".repeat(64), memo: null, minAmount: null, expiresAt: null };
  server.answer(`GET ${base}/account`, ok({ agentId: "id-portfolio", executor: true, wallet: "portfolio.near", grant: null, stagedGrant: null }));
  server.answer(`GET ${base}/treasury`, ok({ treasury: linked }));
  server.answer(`POST ${base}/deposit`, ok({ deposit }));
  for (const path of ["link", "unlink"]) server.answer(`POST ${base}/treasury/${path}`, ok({}));

  const account = await agent.account();
  assert.equal(account.ok && account.value.wallet, "portfolio.near");
  assert.deepEqual(await agent.treasury(), { ok: true, value: { treasury: linked } });
  assert.deepEqual(await agent.deposit("NEAR"), { ok: true, value: { deposit } });
  assert.deepEqual(await agent.link("funds.near"), { ok: true, value: {} });
  assert.deepEqual(await agent.unlink(), { ok: true, value: {} });
  assert.deepEqual(server.sent.filter(request => request.method === "POST").map(request => [request.path, JSON.parse(request.body)]), [
    [`${base}/deposit`, { asset: "NEAR" }],
    [`${base}/treasury/link`, { accountId: "funds.near" }],
    [`${base}/treasury/unlink`, {}],
  ]);
  assert.throws(() => agent.link("Not An Account"), "held to the server's schema before anything is sent");
  assert.throws(() => agent.deposit("ETH" as "USDC"));
});

test("asking for a rebalance is one JSON POST naming the request; its proposal parses", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  server.answer(`POST ${base}/proposals`, ok({ proposal: proposal() }));
  assert.equal((await agent.proposeRebalance("page-1")).ok, true);
  assert.deepEqual(server.sent.map(request => [request.method, request.path, JSON.parse(request.body)]), [["POST", `${base}/proposals`, { requestId: "page-1" }]]);
  assert.throws(() => agent.proposeRebalance("has space"), "held to the server's schema before anything is sent");
});

test("the consent text is asked for with an empty body, or { owner: true } to add owner to a connection without it", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const text = { message: "m", nonce: NONCE, recipient: "platform.test" };
  server.answer(`POST ${base}/consent/text`, ok(text));
  await agent.consentText();
  await agent.consentText({ owner: true });
  assert.deepEqual(server.sent.map(request => JSON.parse(request.body)), [{}, { owner: true }]);
});

test("autopilot: the strategy and schedule as GETs; on (naming the digest), off and run now as JSON POSTs", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const digest = `sha256:${"a".repeat(64)}`;
  for (const path of ["enable", "stop"]) server.answer(`POST ${base}/autopilot/${path}`, ok({}));
  server.answer(`POST ${base}/autopilot/tick`, ok({ summary: "Ran." }));
  await agent.enableAutopilot(digest);
  await agent.stopAutopilot();
  assert.deepEqual(await agent.runNow(), { ok: true, value: { summary: "Ran." } });
  assert.deepEqual(server.sent.map(request => [request.path, JSON.parse(request.body)]),
    [[`${base}/autopilot/enable`, { expectedDigest: digest }], [`${base}/autopilot/stop`, {}], [`${base}/autopilot/tick`, {}]]);
  assert.throws(() => agent.enableAutopilot("abc"), "held to the server's schema before anything is sent");
});

test("a grant is asked for by digest, its signed intent submitted once to its own route, and its status read by correlation ID", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const digest = `sha256:${"a".repeat(64)}`;
  const intent = { standard: "nep413" as const, payload: { message: "grant", recipient: "provider.test", nonce: NONCE } };
  server.answer(`POST ${base}/grant`, ok({ correlationId: "grant-1", expiresAt: "2026-11-05T00:10:00.000Z", intent }));
  server.answer(`POST ${base}/grant/grant-1/submit`, ok({ status: "SUCCESS", failureCode: null }));
  server.answer(`GET ${base}/grant/grant-1`, ok({ stage: "submitted" }));
  assert.equal((await agent.grant(digest)).ok, true);
  assert.deepEqual(await agent.submitGrant("grant-1", { ...intent, public_key: KEY, signature: "ed25519:s" }), { ok: true, value: { status: "SUCCESS", failureCode: null } });
  assert.deepEqual(await agent.grantStatus("grant-1"), { ok: true, value: { stage: "submitted" } });
  assert.deepEqual(server.sent.filter(request => request.method === "POST").map(request => [request.path, JSON.parse(request.body)]), [
    [`${base}/grant`, { expectedDigest: digest }],
    [`${base}/grant/grant-1/submit`, { signedData: { ...intent, public_key: KEY, signature: "ed25519:s" } }],
  ]);
  assert.throws(() => agent.grantStatus("../consent"));
});

test("a strategy is saved by one JSON POST naming the digest it replaces, held to the platform's rules before it's sent", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const digest = `sha256:${"a".repeat(64)}`;
  const strategy = { targetBps: { "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": 5_000, "nep141:wrap.near": 2_500, "nep141:eth.omft.near": 2_500 },
    minLegUsd: 2, maxCostBps: 250, autopilot: { everyMin: 60, maxUsd: 0 } };
  server.answer(`POST ${base}/strategy`, ok({ digest: `sha256:${"b".repeat(64)}` }));
  assert.equal((await agent.saveStrategy(strategy, digest)).ok, true);
  assert.deepEqual(server.sent.map(request => JSON.parse(request.body)), [{ strategy, expectedDigest: digest }]);
  assert.throws(() => agent.saveStrategy({ ...strategy, maxCostBps: 2_000 }, digest));
});

test("the forward risk report is read from the agent's own route, parsed with the server's contract; none yet is null", async () => {
  const server = scripted(), agent = serverApi(server.fetcher).agent("portfolio");
  const report = { at: "2026-11-06T12:00:00.000Z", seq: 7, level: 2, reason: "projected drawdown 22.6% is at or past its L2 step, 16%",
    projection: { usable: true, reasons: [], projectedDrawdownPct: 22.62, expectedShortfallPct: 22.66, breachProbabilityPct: 4.2, runwayMonths: 30, monthsToFloor: 24, volatileSharePct: 40 },
    scenarios: [{ id: "drop:wNEAR:80", label: "wNEAR falls 80% in a day", valueUsd: 68_000, lossUsd: 32_000, drawdownPct: 32, stableUsd: 60_000, runwayMonths: 30, floorUsd: 12_000, floorBreached: false, unfundedUsd: 0, tradable: true }],
    recommendations: [{ action: "hold-buys", reason: "holds" }], derisk: null, proposed: false };
  server.answer(`GET ${base}/risk`, ok({ risk: report }));
  assert.deepEqual(await agent.risk(), { ok: true, value: { risk: report } });
  server.answer(`GET ${base}/risk`, ok({ risk: null }));
  assert.deepEqual(await agent.risk(), { ok: true, value: { risk: null } });
  assert.deepEqual(server.sent.map(request => request.path), [`${base}/risk`, `${base}/risk`]);
});
