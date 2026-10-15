import type { Access } from "./roles.js";

/**
 * Agent-server procedures by capability, shared with the dashboard. Unknown paths are denied even
 * to wallet owners. These controls do not replace the provider's policy, grant or owner signature.
 */
const READS = new Set([
  "setup",
  "instance",
  "overview",
  "policyHistory",
  "treasury/get",
  "activity",
  "unresolved",
  "held",
  "autopilot/get",
  "strategy/get",
  "autopilot/evidence",
  "autopilot/log",
  "inbox/list",
  "ledger",
  "ledgerCsv",
  "reconcileBooks",
  "owner/status",
  "owner/pending",
  "owner/actions",
  "paymentHistory",
  "paymentStatus",
  "agreements/list",
  "invoices",
  "workOrders/list",
  "workOrders/get",
  "workOrders/status",
]);

const OWNER_PROPOSALS = new Set([
  "owner/prepare",
  "agreements/propose",
  "agreements/offer",
  "workOrders/create",
  "workOrders/prepare",
]);
const PREPARE = new Set([...OWNER_PROPOSALS, "rebalance", "steward/propose", "deposit", "treasury/fund"]);
const EXECUTE = new Set(["pay", "sweep", "executePlan", "autopilot/tick", "autopilot/enable"]);
const MANAGE = new Set(["strategy/save", "treasury/link", "treasury/unlink", "treasury/setConfidential", "agreements/decline"]);
const MAINTAIN = new Set(["autopilot/stop", "recover", "inbox/dismiss", "cancelPreparedInvoice"]);

/** Whether this admitted account may call `path` (`owner/prepare`, without the `/rpc/` prefix). */
export function mayCall(access: Access, path: string): boolean {
  if (READS.has(path)) return true;
  if (PREPARE.has(path)) return access.canSign || access.canPropose;
  if (path === "owner/submit" || path === "workOrders/submit") return access.canSign;
  if (EXECUTE.has(path)) return access.canExecute;
  if (MANAGE.has(path)) return access.canManage;
  if (path === "autopilot/set") return access.canManage && access.canExecute;
  if (MAINTAIN.has(path)) return access.canManage || access.canExecute;
  return false;
}

/** Preserve the historical intervention classification, including invoice review reads. */
export const isIntervention = (path: string) => path === "invoices" || (!READS.has(path) && !OWNER_PROPOSALS.has(path));
