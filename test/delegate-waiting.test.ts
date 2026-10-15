import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { daoRequests, delegateWaiting, prepare, reconcileOwnerIntents } from "../src/owner-intents.js";
import { Near } from "near-kit";
import { api } from "../src/api.js";

/**
 * One owner key, one nonce sequence: a NEAR delegate action executing raises the key's nonce, so a
 * second one prepared while the first waits for its vote would fail after its own vote. Both agents'
 * servers on a host keep their pending owner intents side by side in `.owner-intents/`.
 */

const home = process.cwd();
const OWNER = "c1bec849".padEnd(64, "0");
const future = new Date(Date.now() + 300_000).toISOString();
const delegate = (owner = OWNER, change: Record<string, unknown> = {}) =>
  ({ type: "agent_freeze", expiresAt: future, stage: "prepared", dao: { owner: { account_id: owner }, hash: "h", delegate: "AAAA" }, ...change });

beforeEach(() => { process.chdir(mkdtempSync(join(tmpdir(), "delegate-"))); mkdirSync(".owner-intents"); });
afterEach(() => process.chdir(home));
const file = (name: string, entries: Record<string, unknown>) => writeFileSync(join(".owner-intents", name), JSON.stringify(entries));

test("a delegate action another agent's server prepared for the same owner is found", () => {
  file(".env.payout.json", { "intent-1": delegate() });
  assert.equal(delegateWaiting(OWNER)?.type, "agent_freeze");
});

for (const raw of ['{"partial":', 'null', '[]', '{"intent":null}', '{"intent":{}}',
  JSON.stringify({ intent: delegate(OWNER, { expiresAt: "invalid" }) }),
  JSON.stringify({ intent: delegate(OWNER, { stage: "unknown" }) }),
  JSON.stringify({ intent: { ...delegate(), dao: { delegate: "AAAA" } } }),
]) test(`unreadable peer owner intents refuse a new delegate: ${raw}`, () => {
  writeFileSync(join(".owner-intents", "peer.json"), raw);
  assert.throws(() => delegateWaiting(OWNER), /owner.intent.*unavailable/i);
});

test("legacy prepared records without stage still block", () => {
  file("peer.json", { intent: delegate(OWNER, { stage: undefined }) });
  assert.equal(delegateWaiting(OWNER)?.type, "agent_freeze");
});

for (const stage of [undefined, "prepared"]) test(`expired peer with retained signature cannot become unsigned: ${stage ?? "missing stage"}`, () => {
  file("peer.json", { intent: delegate(OWNER, { stage, expiresAt: new Date(0).toISOString(),
    signedData: { standard: "nep366", signed_delegate: "retained-signature" } }) });
  const before = readFileSync(join(".owner-intents", "peer.json"), "utf8");
  assert.throws(() => delegateWaiting(OWNER), /owner.intent.*unavailable/i);
  assert.equal(readFileSync(join(".owner-intents", "peer.json"), "utf8"), before);
});

test("DAO preparation refuses damaged peer evidence before constructing a delegate", async t => {
  const treasury = process.env.TREASURY_ACCOUNT;
  process.env.TREASURY_ACCOUNT = "fixture.near";
  t.after(() => {
    if (treasury === undefined) delete process.env.TREASURY_ACCOUNT;
    else process.env.TREASURY_ACCOUNT = treasury;
  });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network call"); });
  t.mock.method(Near.prototype, "view", (async () => "ed25519:11111111111111111111111111111111") as typeof Near.prototype.view);
  const generated = t.mock.method(api, "generateIntent", async () => ({
    type: "agent_freeze", correlation_id: "new-delegate", expires_at: future, preview: {},
    signer: { type: "near", account_id: "0".repeat(64), public_key: "ed25519:11111111111111111111111111111111" },
    intent: { standard: "nep366", payload: { receiverId: "fixture.near", actions: [] } },
  }) as never);
  writeFileSync(join(".owner-intents", "peer.json"), '{"incomplete":');
  await assert.rejects(prepare({ type: "agent_freeze" }, "dao"), /owner.intent.*unavailable/i);
  assert.equal(generated.mock.callCount(), 1);
  assert.equal(network.mock.callCount(), 0, "no delegate construction or signature submission starts");
  assert.equal(existsSync(join(".owner-intents", ".env.json")), false, "no new signing request is recorded");
});

test("resolved, expired unsubmitted, signature-only and other owners' intents don't block", () => {
  file(".env.dao.json", {
    a: delegate(OWNER, { stage: "submitted", ownerSucceeded: true, releases: "still-settling" }),
    b: delegate(OWNER, { stage: "settled", result: { status: "FAILED" } }),
    c: delegate(OWNER, { expiresAt: new Date(Date.now() - 1).toISOString() }),
    d: { ...delegate(), dao: { owner: { account_id: OWNER }, hash: "h" } },
    e: delegate("someone-else"),
  });
  writeFileSync(join(".owner-intents", ".env.dao.expired.jsonl"), "{}\n");
  assert.equal(delegateWaiting(OWNER), undefined);
});

for (const change of [
  { stage: "submitted" },
  { stage: "submitted", expiresAt: new Date(0).toISOString() },
  { stage: "settled" },
  { stage: "settled", result: { status: "UNCERTAIN" } },
]) test(`unproven delegate outcome blocks: ${JSON.stringify(change)}`, () => {
  file("peer.json", { intent: delegate(OWNER, change) });
  assert.equal(delegateWaiting(OWNER)?.type, "agent_freeze");
});

test("a DAO-signed approval names the payment it released, also once settled", () => {
  file(".env.json", { "vote-1": { ...delegate(OWNER, { type: "approval_vote", stage: "settled", result: { status: "SUCCESS" } }),
    paymentApproval: { approvalId: "a", correlationId: "op_payment", verdict: "approve", requestHash: "r" } } });
  const [request] = daoRequests();
  assert.equal(request?.state, "done");
  assert.deepEqual(request?.payment, { correlationId: "op_payment", verdict: "approve" });
});

test("an approval whose signing window closed still names its payment, read back from the archive", async () => {
  const past = new Date(Date.now() - 1).toISOString();
  file(".env.json", { "vote-2": { ...delegate(OWNER, { type: "approval_vote", expiresAt: past }),
    paymentApproval: { approvalId: "a", correlationId: "op_payment", verdict: "reject", requestHash: "r" } } });
  // An archive line from before payments were recorded, then a torn tail.
  writeFileSync(join(".owner-intents", ".env.expired.jsonl"), `${JSON.stringify({ correlationId: "vote-1", type: "approval_vote", expiresAt: past, hash: "h", delegate: null })}\n{"correlationId":"vo`);
  await reconcileOwnerIntents();
  const requests = daoRequests();
  assert.deepEqual(requests.map((r) => [r.correlationId, r.state, r.payment]), [
    ["vote-1", "expired", null],
    ["vote-2", "expired", { correlationId: "op_payment", verdict: "reject" }],
  ]);
});
