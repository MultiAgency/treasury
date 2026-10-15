import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { api, readStatus } from "../../src/api.js";
import { dispatch } from "../../src/agent.js";
import { file } from "../../src/invoices.js";
import { claimInvoiceSubmission, getInvoice, invoiceDatabasePath, invoiceId, type StoredInvoice } from "../../src/invoice-store.js";
import { acquireMoneyLock } from "../../src/lock.js";
import { readOps, settle } from "../../src/ops.js";
import { ASSETS, payoutPolicy } from "../../src/policy.js";
import { recover, type Recovery } from "../../src/recover.js";
import { authorityFixture, policyView } from "./authority.js";

if (process.env.PROTO_TEST_MODE !== "offline") throw new Error("This fixture requires the guarded offline runner");

export type ProviderReply = { status: string; details?: Record<string, unknown> };
type Filing = Awaited<ReturnType<typeof file>>;
export type ReplayReport = {
  pid: number;
  invoice: StoredInvoice;
  operations: ReturnType<typeof readOps>;
  result?: Filing;
  recoveries?: Recovery[];
  filings?: { original: Filing; revised: Filing; repeated: Filing };
  conflict?: { observed: ProviderReply; invoice: StoredInvoice; filing: Filing };
  counts: { invoices: number; payments: number; reservations: number; revisions: number; attempt: number };
};

const mode = process.argv[2];
if (!["held", "observe", "replay"].includes(mode ?? "")) throw new Error("Unknown fixture mode");
const reply: ProviderReply = JSON.parse(process.argv[3]!);
const invoice = { payee: "alice.near", amount: "1000000", note: "October", submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
const request = { asset: ASSETS.USDC, amount: invoice.amount, recipient: invoice.payee, confidential: true };
const correlationId = "op_invoice_terminal_replay";
const saved = () => getInvoice(invoiceId(invoice))!;
process.env.AGENT_GRANT_TOKEN = "ngt_test";

Object.assign(api, {
  ...authorityFixture(),
  getPolicy: async () => policyView(payoutPolicy([invoice.payee])),
  forGrant: () => ({ transfer: async (agentId: string, body: unknown, options: { idempotencyKey: string }) => {
    // A separate provider-side call log survives every fixture process and counts all sends,
    // including accidental replacements under a new key. No remote deduplication is simulated.
    appendFileSync("provider.jsonl", JSON.stringify({ agentId, request: body, ...options, correlationId }) + "\n");
    return { correlation_id: correlationId };
  } }),
  getStatus: async (correlation_id: string) => {
    assert.equal(correlation_id, correlationId);
    return { correlation_id, agent_id: process.env.AGENT_ID, type: "transfer", ...reply };
  },
});

async function rejectReplay() {
  const operation = saved().operation;
  // Probe before adding a changed revision, so review alone cannot explain the refusal.
  assert.throws(() => claimInvoiceSubmission(operation.idempotencyKey, operation.request), /replay is blocked/);
  const lock = await acquireMoneyLock();
  try {
    await assert.rejects(dispatch(lock, "invoices", { method: "transfer", request }, undefined,
      operation.idempotencyKey), /not prepared; replay is blocked/);
  } finally { await lock.release(); }
}

const report: Partial<ReplayReport> = { pid: process.pid };
if (mode === "held") {
  report.result = await file(invoice, invoice.payee);
} else if (mode === "observe") {
  report.recoveries = await recover();
} else {
  report.recoveries = await recover();
  const original = await file(invoice, invoice.payee);
  await rejectReplay();
  const revised = await file({ ...invoice, amount: "2000000", note: "Corrected October" }, invoice.payee);
  const repeated = await file(invoice, invoice.payee);
  report.filings = { original, revised, repeated };

  // Recovery need not poll terminal records. Explicitly feed a later conflicting observation
  // through the existing status-to-journal boundary as well. This checks replay protection,
  // not whether conflicting provider evidence is adequately retained or reconciled.
  const observed = await readStatus(correlationId);
  settle(observed.correlation_id, observed.status);
  await recover();
  const filing = await file(invoice, invoice.payee);
  await rejectReplay();
  report.conflict = { observed, invoice: saved(), filing };
}

const db = new DatabaseSync(invoiceDatabasePath());
try {
  const count = (table: "invoices" | "payments" | "reservations" | "revisions") =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  report.counts = { invoices: count("invoices"), payments: count("payments"), reservations: count("reservations"),
    revisions: count("revisions"), attempt: (db.prepare("SELECT attempt FROM payments").get() as { attempt: number }).attempt };
} finally { db.close(); }
report.invoice = saved();
report.operations = readOps();
console.log(JSON.stringify(report));
