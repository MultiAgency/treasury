import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { api } from "./api.js";
import { authorize } from "./authorize.js";
import { getInvoice } from "./invoice-store.js";
import { canonical, mandateDigest } from "./mandate.js";
import { AuthorizationHeld, readOps, type Op } from "./ops.js";
import { ASSETS } from "./policy.js";
import type { Action } from "./agent.js";

export type PaymentApproval = { approvalId: string; correlationId: string; verdict: "approve" | "reject";
  requestHash: string; key?: string; invoiceRevision?: number; policyDigest?: string };

/** The terms a provider approval names: a confidential transfer of `amount` of `token` to `to`. */
type Terms = { to: string; token: string; amount: string };

/**
 * The wallet provider's hash of a confidential transfer: sha256 of its canonical operation
 * (`shared-tee-helpers` `wallet_policy::request_hash`, `Op::Confidential`), recomputed here so the
 * readable terms are proven to be the ones the approval releases.
 */
const requestHash = (terms: Terms) =>
  createHash("sha256").update(canonical({ ...terms, chain: "near", flow: "transfer", kind: "confidential" })).digest("hex");

/** The observed withdrawal route only; no memo, wrapped delivery or exact-output approval. */
function withdrawalTerms(data: Record<string, unknown>, op: Op | undefined): Extract<Action, { method: "withdraw" }> {
  if (!op || op.method !== "withdraw" || op.invoiceId || op.journalVersion !== 2 ||
      op.submissionState !== "SUBMISSION_ATTEMPTED" || op.status !== "PENDING_APPROVAL" || op.refused ||
      !op.policyDigest || !/^sha256:[a-f0-9]{64}$/.test(op.policyDigest) || !Number.isInteger(op.policyRevision))
    throw new AuthorizationHeld("withdrawal approval needs its durable held operation");
  const { to, token, amount, chain, destination_asset } = data;
  if (typeof to !== "string" || !to || typeof token !== "string" || typeof amount !== "string" || !/^[1-9]\d{0,77}$/.test(amount) || typeof chain !== "string")
    throw new AuthorizationHeld("provider withdrawal terms are incomplete");
  if (token !== ASSETS.USDC || chain !== "near" || destination_asset !== token ||
      Object.keys(data).some(key => !["to", "token", "amount", "chain", "destination_asset"].includes(key)))
    throw new AuthorizationHeld("unsupported withdrawal delivery terms");
  const r = op.request;
  if (r.asset !== token || r.amount !== amount || r.chain !== chain || r.recipient !== to || r.confidential !== true ||
      Object.keys(r).some(key => !["asset", "amount", "chain", "recipient", "confidential", "async"].includes(key)) ||
      (r.async !== undefined && typeof r.async !== "boolean"))
    throw new AuthorizationHeld("provider withdrawal terms do not match the recorded withdrawal");
  return { method: "withdraw", request: { asset: token, amount, chain, recipient: to, confidential: true } };
}

/**
 * Checks a vote on one held payment against the provider's own evidence. Transfer approval can use
 * an approve-only instance that never saw the send. The approval and execution must name each other
 * and this agent's wallet; an approval must name
 * a confidential transfer, or a recorded confidential USDC withdrawal to NEAR, whose terms hash to
 * the provider's request hash and the applied policy allows. Withdrawals require the local journal;
 * their approval hash does not establish exact delivery or final-artifact binding. A recorded payment
 * must also match its record and any invoice behind it must be unrevised. Missing evidence refuses.
 */
export async function checkPaymentApproval(input: Pick<PaymentApproval, "approvalId" | "correlationId" | "verdict">, saved?: PaymentApproval) {
  const id = process.env.AGENT_ID;
  if (!id) throw new AuthorizationHeld("agent missing");
  const options = { signal: AbortSignal.timeout(10_000) };
  const approving = input.verdict === "approve";
  const [approval, status, wallet, view] = await Promise.all([
    api.getApproval(id, input.approvalId, options), api.getStatus(input.correlationId, options), api.getWallet(id, options),
    approving ? api.getPolicy(id, options) : undefined,
  ]);
  if (status.correlation_id !== input.correlationId || status.agent_id !== id || status.status !== "PENDING_APPROVAL" || !("details" in status) ||
      !("approval_id" in status.details) || status.details.approval_id !== input.approvalId || approval.approval_id !== input.approvalId ||
      approval.wallet_id !== wallet.wallet_id || approval.status !== "PENDING" || Date.parse(approval.expires_at) <= Date.now() ||
      !Number.isFinite(Date.parse(approval.expires_at)) || !approval.request_hash)
    throw new AuthorizationHeld("approval does not identify this pending agent payment");
  let binding: PaymentApproval = { approvalId: input.approvalId, correlationId: input.correlationId, verdict: input.verdict, requestHash: approval.request_hash };

  // Rejecting releases nothing, so it needs no more than the identity checks above.
  let invoiceId: string | undefined;
  let withdrawalRecord: Op | undefined;
  if (approving) {
    if (approval.request_type !== "confidential") throw new AuthorizationHeld(`approving a ${approval.request_type} request is not supported`);
    const op = readOps().find((o) => o.correlationId === input.correlationId);
    if (status.type === "withdraw" || op?.method === "withdraw") {
      if (status.type !== "withdraw") throw new AuthorizationHeld("provider execution is not a withdrawal");
      const action = withdrawalTerms(approval.request_data, op);
      const r = action.request;
      const hash = createHash("sha256").update(canonical({ kind: "confidential", flow: "withdraw", to: r.recipient, token: r.asset, amount: r.amount, chain: r.chain })).digest("hex");
      if (hash !== approval.request_hash) throw new AuthorizationHeld("provider withdrawal terms don't match its request hash");
      if (!view) throw new AuthorizationHeld("policy unavailable");
      const refusal = authorize(action, { purpose: "approval", facts: { now: Date.now(), agentId: id, view, grant: undefined } });
      if (refusal) throw new AuthorizationHeld(`${refusal.code}: ${refusal.message}`);
      withdrawalRecord = structuredClone(op!);
      binding = { ...binding, key: op!.idempotencyKey, policyDigest: mandateDigest(view.policy!) };
    } else {
      const { to, token, amount } = approval.request_data as Partial<Record<keyof Terms, unknown>>;
      if (typeof to !== "string" || typeof token !== "string" || typeof amount !== "string" || !/^[1-9]\d*$/.test(amount))
        throw new AuthorizationHeld("provider approval terms are incomplete: recipient, asset or amount missing");
      if (requestHash({ to, token, amount }) !== approval.request_hash)
        throw new AuthorizationHeld("provider approval terms don't match its request hash");

      if (!view) throw new AuthorizationHeld("policy unavailable");
      const refusal = authorize({ method: "transfer", request: { recipient: to, asset: token, amount, confidential: true } },
        { purpose: "approval", facts: { now: Date.now(), agentId: id, view, grant: undefined } });
      if (refusal) throw new AuthorizationHeld(`${refusal.code}: ${refusal.message}`);
      const policy = view.policy!;

      // A payment this instance sent must be exactly the one approved, and its invoice unrevised.
      if (op && (op.method !== "transfer" || op.request.recipient !== to || op.request.asset !== token || op.request.amount !== amount))
        throw new AuthorizationHeld("provider approval terms do not match the recorded payment");
      invoiceId = op?.invoiceId;
      const invoice = invoiceId ? getInvoice(invoiceId) : undefined;
      if (invoiceId && (!invoice || invoice.review)) throw new AuthorizationHeld("invoice revision invalidated approval");
      binding = { ...binding, policyDigest: mandateDigest(policy),
        ...(op && { key: op.idempotencyKey }), ...(invoice && { invoiceRevision: invoice.revision }) };
    }
  }
  if (saved && canonical(saved) !== canonical(binding)) throw new AuthorizationHeld("approval binding changed");
  const assertCurrent = () => {
    if (Date.parse(approval.expires_at) <= Date.now()) throw new AuthorizationHeld("approval expired");
    if (withdrawalRecord) {
      const current = readOps().find(op => op.idempotencyKey === withdrawalRecord!.idempotencyKey);
      if (!current || !isDeepStrictEqual(current, withdrawalRecord)) throw new AuthorizationHeld("withdrawal changed before approval submission");
    }
    if (invoiceId) {
      const invoice = getInvoice(invoiceId);
      if (!invoice || invoice.review || invoice.revision !== binding.invoiceRevision) throw new AuthorizationHeld("payment changed before approval submission");
    }
  };
  assertCurrent();
  return { binding, assertCurrent };
}
