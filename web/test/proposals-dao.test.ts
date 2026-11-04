import { test } from "node:test";
import assert from "node:assert/strict";
import { askable, checkLinkOf, endedText, filedOutcome, memberText } from "../src/proposals/dao-flow.ts";
import { asksToReconnect } from "../src/proposals/proposal-flow.ts";
import { proposalsApi } from "../src/proposals/proposals-api.ts";
import { failureText } from "../src/proposals/words.ts";
import { fail, ID, ok, scripted } from "./proposals-fixtures.ts";

const base = "/api/agents/portfolio";
const request = { id: "r1", hash: "h1", description: "Connect the Treasury app. Check: https://platform.test/confirm/dao/h1", votingUntil: 1,
  checkUrl: "https://platform.test/confirm/dao/h1", transaction: { receiverId: "dao.sputnik-dao.near", actions: [{ type: "FunctionCall" as const, params: { methodName: "add_proposal" } }] }, votes: false };

test("a DAO's routes are called same-origin: reads as GETs, filings as JSON POSTs, the vote's verdict its only body", async () => {
  const server = scripted();
  const agent = proposalsApi(server.fetcher).agent("portfolio");
  server.answer(`GET ${base}`, ok({ agent: "portfolio", owner: "dao.sputnik-dao.near", agentId: "id-portfolio", host: "platform.test", signer: "dao",
    member: { canPropose: true, canVote: false, canExecute: false, canManage: false } }));
  server.answer(`GET ${base}/consent/dao`, ok({ state: "none" }));
  server.answer(`POST ${base}/consent/dao`, ok({ state: "pending", request }));
  server.answer(`GET ${base}/proposals/${ID}/vote`, ok({ state: "relayed", verdict: "approve", proposalState: "approved" }));
  server.answer(`POST ${base}/proposals/${ID}/vote`, ok({ state: "pending", verdict: "reject", request }));
  const identity = await agent.identity();
  assert.ok(identity.ok && identity.value.signer === "dao" && identity.value.member?.canPropose);
  assert.deepEqual(await agent.daoConsent(), { ok: true, value: { state: "none" } });
  assert.equal((await agent.fileDaoConsent()).ok, true);
  assert.deepEqual(await agent.vote(ID), { ok: true, value: { state: "relayed", verdict: "approve", proposalState: "approved" } });
  assert.equal((await agent.fileVote(ID, "reject")).ok, true);
  for (const sent of server.sent) {
    assert.equal(sent.credentials, "same-origin");
    if (sent.method === "POST") assert.equal(sent.headers["content-type"], "application/json");
  }
  assert.deepEqual(JSON.parse(server.sent.find(sent => sent.path.endsWith("/vote") && sent.method === "POST")!.body), { verdict: "reject" });
  assert.throws(() => agent.fileVote(ID, "maybe" as never), "a verdict is approve or reject");
});

test("an identity from before DAO-owned agents reads as a wallet owner's", async () => {
  const server = scripted();
  server.answer(`GET ${base}`, ok({ agent: "portfolio", owner: "owner.near", agentId: "id-portfolio", host: "platform.test" }));
  const identity = await proposalsApi(server.fetcher).agent("portfolio").identity();
  assert.ok(identity.ok);
  assert.deepEqual([identity.value.signer, identity.value.member], ["wallet", null]);
  assert.equal(memberText(identity.value), "Signed in as owner.near");
});

test("the check link is offered only as the platform's own page for the request's hash", () => {
  assert.equal(checkLinkOf(request, "platform.test"), "https://platform.test/confirm/dao/h1");
  for (const checkUrl of ["https://elsewhere.test/confirm/dao/h1", "https://platform.test/confirm/dao/other", "javascript:alert(1)", "http://platform.test/confirm/dao/h1"])
    assert.equal(checkLinkOf({ ...request, checkUrl }, "platform.test"), null, checkUrl);
});

test("filing is offered again only after the DAO refused the transaction; an unknown answer sends the member to the DAO first", () => {
  assert.equal(filedOutcome({ kind: "succeeded" }).fileAgain, false);
  assert.equal(filedOutcome({ kind: "failed", failure: {} }).fileAgain, true);
  const unknown = filedOutcome({ kind: "unknown" });
  assert.deepEqual([unknown.fileAgain, unknown.tone], [false, "alert"]);
  assert.match(unknown.text, /Check the DAO's proposals before filing again/);
});

test("a member may ask again only once nothing is open, and is told why the last request ended", () => {
  for (const state of ["none", "expired", "ended", "gone"] as const) assert.equal(askable(state), true, state);
  for (const state of ["pending", "signed", "relayed"] as const) assert.equal(askable(state), false, state);
  assert.equal(endedText("pending"), null);
  assert.match(endedText("ended")!, /stopped this agent/);
});

test("a forbidden after the consent was revoked asks the owner to reconnect, from one request, never retried", async () => {
  const server = scripted();
  const agent = proposalsApi(server.fetcher).agent("portfolio");
  server.answer(`GET ${base}/proposals`, fail({ kind: "refused", code: "not_connected" }, 409));
  const listed = await agent.proposals();
  assert.ok(!listed.ok);
  assert.equal(asksToReconnect(listed), true);
  assert.match(failureText(listed, "read"), /Connect it/);
  assert.match(failureText(listed, "proposal"), /Connect it/);
  assert.equal(server.sent.length, 1, "one request: nothing is retried");
  assert.equal(asksToReconnect({ ok: false, kind: "unavailable" }), false, "an outage isn't a reason to reconnect");
});

test("a DAO's codes read in words for the member", () => {
  assert.match(failureText({ ok: false, kind: "refused", code: "not_permitted" }, "proposal"), /roles in the DAO/);
  assert.match(failureText({ ok: false, kind: "refused", code: "dao_owner" }, "consent"), /own vote/);
  assert.match(failureText({ ok: false, kind: "refused", code: "vote_open" }, "proposal"), /other verdict/);
});
