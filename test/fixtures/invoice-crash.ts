import { authorityFixture, policyView } from "./authority.js";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { api } from "../../src/api.js";
import { file } from "../../src/invoices.js";
import { getInvoice, invoiceId } from "../../src/invoice-store.js";
import { payoutPolicy } from "../../src/policy.js";
import { recover } from "../../src/recover.js";

const mode = process.argv[2]!;
const invoice = { payee: "alice.near", amount: "1000000", note: "October", submission: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
process.env.AGENT_GRANT_TOKEN = "ngt_test";
// Kill the real process at SQLite transaction boundaries, without hooks in production code.
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql: string) {
  let row: { state: string; status: string | null } | undefined;
  if (sql === "COMMIT") row = this.prepare("SELECT state, status FROM payments WHERE invoice_id = ?").get(invoiceId(invoice)) as typeof row;
  if (row?.state === "PREPARED" && mode === "before_prepare_commit") process.exit(71);
  if (row?.state === "SUBMISSION_ATTEMPTED" && mode === "before_attempt_commit") process.exit(71);
  if (row?.status === "SENT" && mode === "before_correlation_commit") process.exit(71);
  if (row?.status === "SUCCESS" && mode === "before_settlement_commit") process.exit(71);
  if (row?.status === "SUCCESS" && mode === "recover_only_before_commit") process.exit(71);
  const result = exec.call(this, sql);
  if (row?.state === "PREPARED" && mode === "after_prepare_commit") process.exit(71);
  if (row?.state === "SUBMISSION_ATTEMPTED" && mode === "after_attempt_commit") process.exit(71);
  if (row?.status === "SUCCESS" && mode === "after_settlement_commit") process.exit(71);
  if (row?.status === "SUCCESS" && mode === "recover_only_after_commit") process.exit(71);
  return result;
};

Object.assign(api, {
    ...authorityFixture(),
  getPolicy: async () => policyView(payoutPolicy([invoice.payee])),
  forGrant: () => ({ transfer: async (_id: string, request: unknown, options: { idempotencyKey: string }) => {
    // Separate provider-side evidence, persisted before the simulated response can be lost.
    appendFileSync("provider.jsonl", JSON.stringify({ ...options, request }) + "\n");
    if (mode === "after_remote_acceptance") process.exit(71);
    return { correlation_id: "op_invoice" };
  } }),
  getStatus: async (correlation_id: string) => {
    if (mode === "after_correlation_commit") process.exit(71);
    return { correlation_id, status: "SUCCESS" };
  },
});

if (mode === "recover_revoked") Object.assign(api, { listGrants: async () => [] });
if (mode.startsWith("recover")) await recover();
const result = mode.includes("only") ? null : await file(invoice, invoice.payee);
console.log(JSON.stringify({ result, invoice: getInvoice(invoiceId(invoice)) }));
