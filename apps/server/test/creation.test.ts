import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as contract from "../src/contract.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

async function world(t: TestContext) {
  const owner = wallet("creator.near"), other = wallet("other.near"), fake = fakePlatform({});
  const { server, base, signIn } = await testServer({ platform: fake.platform, wallets: [owner, other] });
  t.after(() => server.close());
  const cookie = await signIn(owner);
  const call = async (method: string, path: string, body?: unknown, as = cookie) => {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie: as, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
      ...(method === "POST" && { body: JSON.stringify(body ?? {}) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const text = (await call("POST", "/api/setup/text")).body.value;
  const signed = owner.sign(text);
  const setup = await call("POST", "/api/setup", { message: text.message, nonce: text.nonce, publicKey: signed.publicKey, signature: signed.signature });
  const agent = setup.body.value.agent, path = `/api/agents/${agent}`;
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const intent = { standard: "nep413" as const, payload: { message: "Create this Treasury agent with its owner and policy", recipient: "provider.test", nonce: Buffer.alloc(32, 1).toString("base64") } };
  const prepared = { correlationId: "create-readable", expiresAt, digest: null, preview: { summary: "Create a Treasury agent" }, intent,
    signer: { type: "near" as const, account_id: owner.accountId, public_key: owner.publicKey } };
  fake.creationAnswers.push({ ok: true, value: prepared });
  fake.reads.ownerActions = [{ correlationId: prepared.correlationId, type: "agent_create", expiresAt, signer: "wallet", stage: "prepared", phase: "open",
    ownerSucceeded: false, status: null, failureCode: null, payment: null }];
  return { owner, other, fake, call, path, prepared, intent, cookie, signIn };
}

test("a readable creation is reviewed under its exact owner, setup key and host; rereading changes no intent and prepares nothing", async t => {
  const { fake, call, path, prepared, intent, owner } = await world(t);
  // The action list is empty before preparation; subsequent reads see the platform's durable open action.
  fake.readAnswers.ownerActions = [{ ok: true, value: [] }];
  const made = await call("POST", `${path}/creation`);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const creation = contract.creation.parse(made.body.value);
  assert.deepEqual(creation.intent, intent);
  assert.deepEqual(creation.review, { agent: path.split("/").at(-1), owner: owner.accountId, host: "platform.test", publicKey: owner.publicKey });
  fake.statusAnswers.push({ ok: true, value: { stage: "unknown", phase: "open" } });
  const read = await call("GET", `${path}/creation/${prepared.correlationId}/review`);
  assert.deepEqual(read.body, made.body);
  assert.equal(fake.calls.filter(call => call.startsWith("creation.prepare")).length, 1);
});

test("a creation review fails closed after a changed setup key, submitted action, unreadable status or another principal", async t => {
  const { fake, call, path, prepared, other, signIn } = await world(t);
  fake.readAnswers.ownerActions = [{ ok: true, value: [] }];
  assert.equal((await call("POST", `${path}/creation`)).status, 200);
  const review = `${path}/creation/${prepared.correlationId}/review`;
  const setup = fake.consents.at(-1)!;
  const key = setup.publicKey;
  setup.publicKey = other.publicKey;
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "creation_changed" });
  setup.publicKey = key;
  fake.statusAnswers.push({ ok: true, value: { stage: "submitting", phase: "submitted" } });
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "action_pending" });
  fake.statusAnswers.push({ ok: false, kind: "unavailable" });
  assert.equal((await call("GET", review)).status, 503);
  assert.equal((await call("GET", review, undefined, await signIn(other))).status, 403);
  fake.reads.ownerActions[0]!.phase = "submitted";
  assert.deepEqual((await call("POST", `${path}/creation`)).body, { ok: false, kind: "refused", code: "action_pending" });
  assert.equal(fake.calls.filter(call => call.startsWith("creation.prepare")).length, 1, "no duplicate preparation");
});

test("malformed or foreign readable creation material is never released", async t => {
  const { fake, call, path, prepared, other } = await world(t);
  fake.reads.ownerActions = [];
  fake.creationAnswers.length = 0;
  for (const changed of [
    { ...prepared, signer: { ...prepared.signer, account_id: other.accountId } },
    { ...prepared, signer: { ...prepared.signer, public_key: other.publicKey } },
    { ...prepared, intent: { ...prepared.intent, payload: { ...prepared.intent.payload, message: "" } } },
    { ...prepared, intent: { ...prepared.intent, payload: { ...prepared.intent.payload, nonce: "?" } } },
    { ...prepared, intent: undefined },
  ]) {
    fake.creationAnswers.push({ ok: true, value: changed } as never);
    assert.equal((await call("POST", `${path}/creation`)).status, 503);
  }
});

test("a submitted creation stays held past expiry on a fresh server; an unsigned review lost on restart is never reconstructed", async t => {
  const { fake, call, path, owner, prepared } = await world(t);
  fake.readAnswers.ownerActions = [{ ok: true, value: [] }];
  assert.equal((await call("POST", `${path}/creation`)).status, 200);
  const next = await testServer({ platform: fake.platform, wallets: [owner] });
  t.after(() => next.server.close());
  const cookie = await next.signIn(owner);
  const again = async (method: string, suffix: string) => {
    const response = await fetch(`${next.base}${path}${suffix}`, { method, headers: { cookie, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
      ...(method === "POST" && { body: "{}" }) });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await again("GET", `/creation/${prepared.correlationId}/review`)).body, { ok: false, kind: "refused", code: "creation_review_unavailable" });
  assert.deepEqual((await again("POST", "/creation")).body, { ok: false, kind: "refused", code: "creation_review_unavailable" });
  fake.reads.ownerActions[0]!.phase = "submitted";
  fake.reads.ownerActions[0]!.expiresAt = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual((await again("POST", "/creation")).body, { ok: false, kind: "refused", code: "action_pending" });
  assert.equal(fake.calls.filter(call => call.startsWith("creation.prepare")).length, 1);
});

test("a revoked setup offers renewal rather than hiding it behind an owner-actions refusal; an outage is never called expiry", async t => {
  const { fake, call, path } = await world(t);
  fake.consents.at(-1)!.revoked = true;
  fake.readAnswers.ownerActions = [{ ok: false, kind: "forbidden", status: 403, error: "No consent" }];
  assert.deepEqual((await call("GET", `${path}/owner/actions`)).body, { ok: false, kind: "refused", code: "not_set_up" });
  assert.deepEqual((await call("POST", `${path}/creation`)).body, { ok: false, kind: "refused", code: "not_set_up" });
  fake.readAnswers.ownerActions = [{ ok: false, kind: "unavailable" }];
  assert.equal((await call("GET", `${path}/owner/actions`)).status, 503);
});

test("a creation whose owner actions are refused offers renewal, as its preparation's refusal does; one unanswered is only unavailable", async t => {
  const { fake, call, path } = await world(t);
  fake.readAnswers.ownerActions = [{ ok: false, kind: "forbidden", status: 403, error: "No consent" }];
  assert.deepEqual((await call("POST", `${path}/creation`)).body, { ok: false, kind: "refused", code: "not_set_up" });
  fake.readAnswers.ownerActions = [{ ok: false, kind: "unavailable" }];
  assert.equal((await call("POST", `${path}/creation`)).status, 503);
  assert.equal(fake.calls.filter(call => call.startsWith("creation.prepare")).length, 0, "nothing is prepared without reading earlier creations");
});

test("a review reread past its signing window reads expired, not lost; one signed elsewhere first reads pending", async t => {
  const { fake, call, path, prepared } = await world(t);
  fake.readAnswers.ownerActions = [{ ok: true, value: [] }];
  assert.equal((await call("POST", `${path}/creation`)).status, 200);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 601_000 });
  const review = `${path}/creation/${prepared.correlationId}/review`;
  fake.reads.ownerActions = [{ ...fake.reads.ownerActions[0]!, phase: "expired", stage: "expired" }];
  fake.statusAnswers.push({ ok: true, value: { stage: "expired", phase: "expired" } });
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "creation_expired" });
  fake.reads.ownerActions = [{ ...fake.reads.ownerActions[0]!, phase: "submitted", stage: "submitted" }];
  fake.statusAnswers.push({ ok: true, value: { stage: "submitting", phase: "submitted" } });
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "action_pending" });
});

test("fresh identity host changes and setup expiry invalidate an already open readable review", async t => {
  const { fake, call, path, prepared } = await world(t);
  fake.readAnswers.ownerActions = [{ ok: true, value: [] }];
  assert.equal((await call("POST", `${path}/creation`)).status, 200);
  const realIdentity = fake.platform.identity;
  const changed = t.mock.method(fake.platform, "identity", async (...args: Parameters<typeof realIdentity>) => {
    const result = await realIdentity(...args);
    return result.answer.ok ? { ...result, answer: { ...result.answer, value: { ...result.answer.value, host: "another-host.test" } } } : result;
  });
  const review = `${path}/creation/${prepared.correlationId}/review`;
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "creation_changed" });
  changed.mock.restore();
  fake.consents.at(-1)!.expiresAt = Date.now() - 1;
  assert.deepEqual((await call("GET", review)).body, { ok: false, kind: "refused", code: "not_set_up" });
});
