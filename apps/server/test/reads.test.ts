import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import * as contract from "../src/contract.ts";
import { BIG, fakePlatform, OVERVIEW, proposal, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
let server: Server, base: string, cookie: string, signIn: Awaited<ReturnType<typeof testServer>>["signIn"];

before(async () => {
  ({ server, base, signIn } = await testServer({ platform: fake.platform, wallets: [owner, intruder] }));
  cookie = await signIn(owner);
});
after(() => server.close());

const get = async (path: string, as = cookie) => {
  const response = await fetch(`${base}${path}`, { headers: { cookie: as } });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const agent = "/api/agents/portfolio";
const READS = [
  ["overview", `${agent}/overview`, contract.overviewRead],
  ["activity", `${agent}/activity`, contract.activityRead],
  ["held", `${agent}/held`, contract.heldRead],
  ["unresolved", `${agent}/unresolved`, contract.unresolvedRead],
  ["runs", `${agent}/runs`, contract.runsRead],
  ["account", `${agent}/account`, contract.accountRead],
] as const;

test("the overview reaches the page under the owner's Organization, every amount an exact decimal string, a balance past 2^53 included", async () => {
  fake.calls.length = 0;
  const { status, body, text } = await get(`${agent}/overview`);
  assert.equal(status, 200, text);
  const overview = contract.overviewRead.parse(body.value);
  assert.equal(overview.book[0]!.confidential, String(BIG));
  assert.equal(BigInt(overview.book[0]!.confidential), BIG, "exactly");
  assert.equal(overview.book[0]!.public, "0");
  assert.equal(overview.unmanaged[0]!.amount, "5000000");
  assert.ok(text.includes(`"confidential":"${BIG}"`), "a string on the wire, never a number");
  assert.deepEqual(fake.calls.filter(made => made.startsWith("reads.")), ["reads.overview owner--near portfolio"]);
});

test("activity, held, unresolved, the autopilot's runs and the account reach the page as the platform answers them, a bigint in a request included", async () => {
  const request = { amount: BIG, to: "payee.near" };
  fake.reads.activity = [{ at: "2026-11-05T00:00:00.000Z", kind: "swap", request, correlationId: "c1", status: "SUCCESS" }];
  fake.reads.held = [{ at: "2026-11-05T00:00:00.000Z", kind: "pay", request, correlationId: "c2", approvalId: "a2" }];
  fake.reads.unresolved = [{ key: "k3", at: "2026-11-05T00:00:00.000Z", kind: "swap", request, status: null, sent: true, evidence: null }];
  fake.reads.runs = { ticks: [], corrupt: [3] };
  for (const [name, path, schema] of READS.slice(1)) {
    const { status, body, text } = await get(path);
    assert.equal(status, 200, `${name}: ${text}`);
    schema.parse(body.value);
    if (name !== "runs" && name !== "account") assert.equal(body.value[0].request.amount, String(BIG), name);
  }
  assert.deepEqual((await get(`${agent}/runs`)).body.value, { ticks: [], corrupt: [3] });
});

test("one run's recording, by its tick ID; one the platform doesn't have is not_found; an ID that isn't one is refused before the platform", async () => {
  fake.calls.length = 0;
  fake.reads.recording = { recorded: true } as never;
  assert.deepEqual((await get(`${agent}/runs/tick-1`)).body, { ok: true, value: { recorded: true } });
  fake.reads.recording = undefined;
  assert.deepEqual((await get(`${agent}/runs/tick-2`)).body, { ok: false, kind: "refused", code: "not_found" });
  assert.equal((await get(`${agent}/runs/${"x".repeat(200)}`)).status, 400);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("reads.")), ["reads.recording owner--near portfolio tick-1", "reads.recording owner--near portfolio tick-2"]);
});

test("a read's failures: no live consent is not_connected, anything else unavailable, a thrown call too; the platform's text never reaches the page", async t => {
  const logged = t.mock.method(console, "error", () => {});
  const secret = "platform says: tap_SECRET_internal_detail";
  for (const [name, path] of READS) {
    for (const [answer, status, expected] of [
      [{ ok: false, kind: "forbidden", status: 403, error: secret }, 409, { ok: false, kind: "refused", code: "not_connected" }],
      [{ ok: false, kind: "refused", status: 500, error: secret }, 503, { ok: false, kind: "unavailable" }],
      [{ ok: false, kind: "unavailable" }, 503, { ok: false, kind: "unavailable" }],
      [new Error(secret), 503, { ok: false, kind: "unavailable" }],
    ] as const) {
      (fake.readAnswers[name as "overview"] ??= []).push(answer as never);
      const reply = await get(path);
      assert.deepEqual([reply.status, reply.body], [status, expected], `${name}: ${JSON.stringify(answer)}`);
      assert.ok(!reply.text.includes("SECRET"), name);
    }
  }
  // A thrown call is the platform's lost answer (`relay`), never an internal error of this server.
  const events = logged.mock.calls.map(c => JSON.parse(String(c.arguments[0])).event);
  assert.equal(events.filter(event => event === "platform_call_threw").length, READS.length);
  assert.ok(!events.includes("internal_error"), events.join());
});

test("a proposal is found by its requestId among the agent's proposals; one not there is no_proposal; nothing is ever created or sent", async () => {
  fake.calls.length = 0;
  fake.proposals.push({ ...proposal({ id: "e".repeat(32), requestId: "watch-7" }), agent: "portfolio" });
  const found = await get(`${agent}/requests/watch-7`);
  assert.equal(found.status, 200, found.text);
  assert.equal(contract.requestRead.parse(found.body.value).proposal.id, "e".repeat(32));
  assert.deepEqual((await get(`${agent}/requests/watch-8`)).body, { ok: false, kind: "refused", code: "no_proposal" });
  assert.equal((await get(`${agent}/requests/${"r".repeat(200)}`)).status, 400);
  assert.ok(fake.calls.every(made => made.startsWith("identity ") || made.startsWith("proposals.list ")), fake.calls.join());
});

test("an operation's status comes from its activity row, never owner/status: an outcome not yet recorded reads null, an unknown ID not_found", async () => {
  fake.calls.length = 0;
  fake.reads.activity = [
    { at: "2026-11-05T00:00:00.000Z", kind: "swap", request: {}, correlationId: "c1", status: "SUCCESS" },
    { at: "2026-11-05T00:01:00.000Z", kind: "swap", request: {}, correlationId: "c2" },
    { at: "2026-11-05T00:02:00.000Z", kind: "pay", request: {}, correlationId: "c3", refused: "budget" },
  ];
  assert.deepEqual((await get(`${agent}/operations/c1`)).body.value, { correlationId: "c1", at: "2026-11-05T00:00:00.000Z", kind: "swap", status: "SUCCESS", refused: null });
  assert.deepEqual((await get(`${agent}/operations/c2`)).body.value, { correlationId: "c2", at: "2026-11-05T00:01:00.000Z", kind: "swap", status: null, refused: null });
  assert.equal((await get(`${agent}/operations/c3`)).body.value.refused, "budget");
  assert.deepEqual((await get(`${agent}/operations/c9`)).body, { ok: false, kind: "refused", code: "not_found" });
  assert.ok(fake.calls.every(made => made.startsWith("identity ") || made.startsWith("reads.activity ")), fake.calls.join());
});

test("someone else's agent is not_owner on every read, and the platform's reads aren't asked", async () => {
  const theirs = await signIn(intruder);
  fake.calls.length = 0;
  for (const path of [...READS.map(([, path]) => path), `${agent}/runs/t`, `${agent}/requests/r`, `${agent}/operations/c`])
    assert.deepEqual((await get(path, theirs)).body, { ok: false, kind: "not_owner" }, path);
  assert.ok(fake.calls.every(made => made.startsWith("identity ")), fake.calls.join());
  assert.equal(OVERVIEW.book.length, 1);
});
