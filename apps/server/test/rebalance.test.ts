import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
const audit: AuditEntry[] = [];
let server: Server, base: string;
const cookies: Record<string, string> = {};

before(async () => {
  const started = await testServer({ platform: fake.platform, wallets: [owner, intruder], audited: audit });
  ({ server, base } = started);
  for (const who of [owner, intruder]) cookies[who.accountId] = await started.signIn(who);
});
after(() => server.close());

const propose = async (body: unknown, as = owner, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/proposals`, { method: "POST", headers: { cookie: cookies[as.accountId]!, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const creates = () => fake.calls.filter(made => made.startsWith("proposals.create"));
const reset = () => { fake.calls.length = 0; audit.length = 0; };

test("the owner asks for a rebalance to the strategy: proposed under their Organization, open for a day, recorded before and after", async () => {
  reset();
  const before = Date.now();
  const { status, body, text } = await propose({ requestId: "page-1" });
  assert.equal(status, 200, text);
  const { proposal } = contract.rebalanceMade.parse(body.value);
  assert.equal(proposal.requestId, "page-1");
  const open = Date.parse(proposal.expiresAt) - before;
  assert.ok(open >= 24 * 3_600_000 - 1_000 && open <= 24 * 3_600_000 + 5_000, "open for a day");
  assert.deepEqual(creates(), ['proposals.create owner--near portfolio page-1 "strategy"'], "the strategy's legs, under the owner's Organization");
  assert.deepEqual(audit.map(entry => [entry.action, entry.stage, entry.subject]), [["propose", "attempt", undefined], ["propose", "result", proposal.id]]);
});

test("the platform's refusals reach the page as its own codes, never its text; a lost answer is unavailable, recorded", async () => {
  reset();
  fake.proposalAnswers.create = [
    { ok: false, kind: "refused", status: 409, code: "nothing_to_propose", error: "The strategy picks no leg: secret detail" },
    { ok: false, kind: "refused", status: 409, code: "too_many_proposals", error: "x" },
    { ok: false, kind: "forbidden", status: 403, error: "No live owner consent" } as never,
    new Error("socket hang up"),
  ];
  const answers = [];
  for (let i = 0; i < 4; i++) answers.push(await propose({ requestId: `page-r${i}` }));
  assert.deepEqual(answers.map(({ status, body }) => [status, body]), [
    [409, { ok: false, kind: "refused", code: "nothing_to_propose" }],
    [409, { ok: false, kind: "refused", code: "too_many_proposals" }],
    [409, { ok: false, kind: "refused", code: "not_connected" }],
    [503, { ok: false, kind: "unavailable" }],
  ]);
  assert.ok(!answers[0]!.text.includes("secret detail"));
  assert.equal(audit.filter(entry => entry.stage === "result").length, 4, "each recorded");
});

test("after a lost answer the proposal is found by its requestId; asked again under it, the platform answers the same proposal", async () => {
  reset();
  const first = contract.rebalanceMade.parse((await propose({ requestId: "page-2" })).body.value).proposal;
  const found = await (await fetch(`${base}/api/agents/portfolio/requests/page-2`, { headers: { cookie: cookies["owner.near"]! } })).json() as any;
  assert.equal(found.value.proposal.id, first.id);
  assert.equal(contract.rebalanceMade.parse((await propose({ requestId: "page-2" })).body.value).proposal.id, first.id);
});

test("a malformed requestId is refused unasked, and someone else's agent is not_owner", async () => {
  reset();
  for (const body of [{}, { requestId: "has space" }, { requestId: "x".repeat(65) }, { requestId: "ok", legs: [] }])
    assert.deepEqual((await propose(body)).body, { ok: false, kind: "refused", code: "bad_request" }, JSON.stringify(body));
  assert.deepEqual((await propose({ requestId: "page-3" }, owner, "theirs")).body, { ok: false, kind: "not_owner" });
  assert.deepEqual([creates(), audit], [[], []]);
});
