import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalsApi } from "../src/proposals/proposals-api.ts";
import { fail, ID, lost, ok, proposal, refused, scripted } from "./proposals-fixtures.ts";

const NONCE = `${"A".repeat(43)}=`, KEY = `ed25519:${"1".repeat(44)}`;
const base = "/api/agents/portfolio";

test("each route is called same-origin, as the server expects: reads as GETs, writes as JSON POSTs, sign-out a bodiless DELETE", async () => {
  const server = scripted();
  const api = proposalsApi(server.fetcher), agent = api.agent("portfolio");
  const signed = { message: "m", nonce: NONCE, publicKey: KEY, signature: "s" };
  server.answer("POST /api/session/challenge", ok({ message: "Sign in", recipient: "treasury.test", nonce: NONCE }));
  server.answer("POST /api/session", ok({ account: "owner.near" }));
  server.answer("DELETE /api/session", ok({}));
  server.answer(`GET ${base}`, ok({ agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test" }));
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

test("every failure the server answers is its kind and code; an answer the contract doesn't describe is lost", async () => {
  const server = scripted(), agent = proposalsApi(server.fetcher).agent("portfolio");
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
  const server = scripted(), agent = proposalsApi(server.fetcher).agent("portfolio");
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
  const server = scripted(), api = proposalsApi(server.fetcher);
  assert.throws(() => api.agent("Not An Agent"));
  const agent = api.agent("portfolio");
  assert.throws(() => agent.proposal("not-a-proposal-id"), "proposal IDs are 32 lowercase hex characters");
  assert.throws(() => agent.verdict(ID, "approve", { message: "m", nonce: "short", publicKey: KEY, signature: "s" }), "a nonce of 32 bytes only");
  assert.throws(() => agent.verdict(ID, "approve", { message: "m", nonce: NONCE, publicKey: KEY, signature: "s", extra: 1 } as never), "no extra keys");
  assert.throws(() => api.signIn({ accountId: "Owner", publicKey: KEY, signature: "s", nonce: NONCE }));
  assert.deepEqual(server.sent, []);
});
