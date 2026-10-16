import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { api } from "../src/api.js";
import { canonical, mandateDigest } from "../src/mandate.js";
import { claimSubmission, opsLog, record } from "../src/ops.js";
import { checkPaymentApproval } from "../src/payment-approval.js";
import { authorize, type Case } from "../src/authorize.js";
import { prepare, submit } from "../src/owner-intents.js";
import { ASSETS, treasuryPolicy } from "../src/policy.js";
import { authorityFixture, policyView } from "./fixtures/authority.js";
import { freshDirectory, offline } from "./fixtures/harness.js";
import { walletIntent, walletSignature, walletSigner } from "./fixtures/wallet-signature.js";

const vote = { type: "approval_vote" as const, approvalId: "withdrawal-approval", correlationId: "withdrawal-operation", verdict: "approve" as const };
const request = { asset: ASSETS.USDC, amount: "300000", chain: "near", recipient: "recipient.near", confidential: true, async: true };
const originalTerms = { to: request.recipient, token: request.asset, amount: request.amount, chain: request.chain, destination_asset: request.asset };
const hash = (terms: typeof originalTerms) => createHash("sha256").update(canonical({ kind: "confidential", flow: "withdraw", to: terms.to, token: terms.token, amount: terms.amount, chain: terms.chain })).digest("hex");
let terms: Record<string, unknown>, requestHash: string, view: ReturnType<typeof policyView>, signatures: number, paymentStatus: string;
function held(recordedRequest: Record<string, unknown> = request) {
  record({ at: new Date().toISOString(), idempotencyKey: "withdrawal-key", kind: "withdrawal-test", method: "withdraw", journalVersion: 2,
    policyDigest: mandateDigest(view.policy), policyRevision: view.revision, usdIn: 0.3, request: recordedRequest });
  claimSubmission("withdrawal-key", recordedRequest);
  record({ idempotencyKey: "withdrawal-key", correlation_id: vote.correlationId, status: "PENDING_APPROVAL" });
}
freshDirectory("withdrawal-approval");
beforeEach(() => {
  offline();
  terms = { ...originalTerms }; requestHash = hash(originalTerms); signatures = 0; paymentStatus = "PENDING_APPROVAL";
  view = policyView({ ...structuredClone(treasuryPolicy), actions: ["withdraw"], owner_approval: true,
    destinations: { mode: "only", list: [{ action: "withdraw", chain: "near", address: request.recipient, memo: null }] } });
  for (const [name, method] of Object.entries(authorityFixture("treasury"))) mock.method(api, name as keyof typeof api, method as never);
  mock.method(api, "getPolicy", async () => view);
  mock.method(api, "getStatus", async (correlation_id: string) => correlation_id === vote.correlationId
    ? { correlation_id, agent_id: process.env.AGENT_ID, type: "withdraw", status: paymentStatus, details: { approval_id: vote.approvalId } }
    : { correlation_id, agent_id: process.env.AGENT_ID, type: "approval_vote", status: "SUCCESS" });
  mock.method(api, "getApproval", async () => ({ approval_id: vote.approvalId, wallet_id: "wallet-fixture", status: "PENDING",
    expires_at: new Date(Date.now() + 60000).toISOString(), request_type: "confidential", request_data: terms, request_hash: requestHash }));
  mock.method(api, "generateIntent", async () => ({ type: "approval_vote", correlation_id: "withdrawal-vote", expires_at: new Date(Date.now() + 60000).toISOString(),
    preview: { approval: { approval_id: vote.approvalId, request_hash: requestHash, verdict: "approve" } }, intent: walletIntent, signer: walletSigner }));
  mock.method(api, "submitIntent", async () => { signatures++; paymentStatus = "SUCCESS"; return { status: "SUCCESS" }; });
  held();
});
afterEach(() => mock.restoreAll());

test("recorded withdrawal approval binds the observed canonical terms and current policy", async () => {
  const checked = await checkPaymentApproval(vote);
  assert.equal(checked.binding.requestHash, requestHash);
  assert.equal(checked.binding.key, "withdrawal-key");
  assert.equal(checked.binding.policyDigest, mandateDigest(view.policy));
  checked.assertCurrent();
});

for (const field of ["to", "token", "amount", "chain"] as const) test(`a changed provider ${field} cannot release the recorded withdrawal`, async () => {
  terms[field] = field === "amount" ? "300001" : "changed";
  requestHash = hash(terms as typeof originalTerms);
  await assert.rejects(checkPaymentApproval(vote), /unsupported|match/);
  assert.equal(signatures, 0);
});

test("a transfer hash cannot approve a withdrawal with the same source terms", async () => {
  requestHash = createHash("sha256").update(canonical({ kind: "confidential", flow: "transfer", to: request.recipient, token: request.asset, amount: request.amount, chain: "near" })).digest("hex");
  await assert.rejects(checkPaymentApproval(vote), /request hash/);
});

for (const mutate of [
  () => { delete terms.chain; },
  () => { delete terms.destination_asset; },
  () => { terms.destination_asset = ASSETS.wNEAR; },
  () => { terms.memo = "not-bound"; },
  () => { terms.min_amount_out = "1"; },
  () => { terms.amount = "0"; },
]) test("incomplete or unbound withdrawal delivery terms refuse approval", async () => {
  mutate();
  await assert.rejects(checkPaymentApproval(vote), /incomplete|unsupported/);
});

test("provider-only withdrawal approval requires the original local journal", async () => {
  writeFileSync(opsLog(), "");
  await assert.rejects(checkPaymentApproval(vote), /durable held operation/);
});

for (const extra of [{ memo: "not-bound" }, { wrapped: true }, { dry: true }]) test("unbound request options cannot be silently omitted from withdrawal approval", async () => {
  writeFileSync(opsLog(), ""); held({ ...request, ...extra });
  await assert.rejects(checkPaymentApproval(vote), /recorded withdrawal/);
});

test("withdrawal approval refuses execution type changes", async () => {
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID,
    type: "transfer", status: "PENDING_APPROVAL", details: { approval_id: vote.approvalId } }));
  await assert.rejects(checkPaymentApproval(vote), /not a withdrawal/);
});

test("withdrawal approval refuses a held record without its recorded mandate", async () => {
  writeFileSync(opsLog(), "");
  record({ at: new Date().toISOString(), idempotencyKey: "withdrawal-key", kind: "withdrawal-test", method: "withdraw", journalVersion: 2, request });
  claimSubmission("withdrawal-key", request);
  record({ idempotencyKey: "withdrawal-key", correlation_id: vote.correlationId, status: "PENDING_APPROVAL" });
  await assert.rejects(checkPaymentApproval(vote), /durable held operation/);
});

test("approval authorization cannot permit a public withdrawal or a cross-chain route", () => {
  const c = { purpose: "approval", facts: { now: Date.now(), agentId: process.env.AGENT_ID!, view, grant: undefined } } as unknown as Case;
  for (const changes of [{ confidential: false }, { chain: "base" }, { memo: "unbound" }]) {
    assert.equal(authorize({ method: "withdraw", request: { ...request, ...changes } }, c)?.code, "withdrawal_not_allowed");
  }
});

for (const [label, change] of [
  ["action", () => { view.policy.actions = []; }],
  ["asset", () => { view.policy.assets = [ASSETS.wNEAR]; }],
  ["destination", () => { view.policy.destinations.list = []; }],
  ["destination mode", () => { view.policy.destinations = { mode: "any", list: [] }; }],
  ["approval requirement", () => { view.policy.owner_approval = false; }],
  ["confidential capability", () => { view.policy.confidential = false; }],
  ["cap", () => { view.policy.limits.per_transaction = { [ASSETS.USDC]: "1" }; }],
  ["freeze", () => { view.policy.frozen = true; }],
  ["synchronization", () => { view.provider_policy_synced = false; }],
] as const) test(`current policy ${label} is checked before withdrawal approval`, async () => {
  change(); await assert.rejects(checkPaymentApproval(vote), /not_allowed|denied|required|exceeded|not_in_force/);
});

test("a journal outcome changing after review invalidates the approval before submission", async () => {
  const checked = await checkPaymentApproval(vote);
  record({ idempotencyKey: "withdrawal-key", correlation_id: vote.correlationId, status: "FAILED" });
  assert.throws(checked.assertCurrent, /withdrawal changed/);
});

test("a policy change between preparing and submitting a withdrawal vote sends no signature", async () => {
  const prepared = await prepare(vote);
  view.policy.max_actions_per_hour = 1;
  await assert.rejects(submit(prepared.correlationId, await walletSignature()), /binding changed/);
  assert.equal(signatures, 0);
});

test("the existing owner-intent flow submits one verified withdrawal approval and never replays it", async () => {
  const prepared = await prepare(vote);
  const signed = await walletSignature();
  await submit(prepared.correlationId, signed);
  await submit(prepared.correlationId, signed);
  assert.equal(signatures, 1);
});

test("a lost withdrawal approval submission is poll-only on the next submit", async () => {
  mock.method(api, "submitIntent", async () => { signatures++; throw new Error("approval response lost"); });
  mock.method(api, "getStatus", async (correlation_id: string) => ({ correlation_id, agent_id: process.env.AGENT_ID,
    type: correlation_id === vote.correlationId ? "withdraw" : "approval_vote",
    status: correlation_id === vote.correlationId ? "PENDING_APPROVAL" : "PROCESSING", details: { approval_id: vote.approvalId } }));
  const prepared = await prepare(vote);
  const signed = await walletSignature();
  await assert.rejects(submit(prepared.correlationId, signed), /response lost/);
  await submit(prepared.correlationId, signed);
  assert.equal(signatures, 1);
});

test("withdrawal rejection requires identity evidence but no terms or policy approval", async () => {
  terms = {}; mock.method(api, "getPolicy", async () => assert.fail("rejection does not authorize payment"));
  assert.equal((await checkPaymentApproval({ ...vote, verdict: "reject" })).binding.verdict, "reject");
});
