import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Policy } from "@near-intents-agent-api/sdk";
import type { InvoiceInput } from "./invoice-store.js";

export const workOrderId = z.uuid();
const parentId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const account = z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
export const workOrderInput = z.object({
  id: workOrderId,
  payee: account,
  amount: z.string().regex(/^[1-9][0-9]{0,17}$/),
  note: z.string().trim().min(1).max(200).refine(value => !/\p{Cc}/u.test(value)),
  until: z.iso.datetime(),
  asset: z.string().min(1),
  owner: z.object({ type: z.literal("near"), account_id: account, public_key: z.string().min(1) }).strict(),
  dao: account.optional(),
}).strict();
export const workOrderRecord = workOrderInput.extend({ version: z.literal(1), parentAgentId: parentId, createdAt: z.iso.datetime() }).strict();
export type WorkOrder = z.infer<typeof workOrderRecord>;
export type WorkOrderInput = z.infer<typeof workOrderInput>;

export const workOrderDirectory = (parent: string) => join(".work-orders", parentId.parse(parent));
export const workOrderFile = (parent: string, id: string) => join(workOrderDirectory(parent), `${workOrderId.parse(id)}.json`);

/** Immutable records. Partial or corrupt writes remain present and block reuse of the identity. */
export function getWorkOrder(parent: string, id: string): WorkOrder {
  const path = workOrderFile(parent, id);
  if (!existsSync(path)) throw new Error("Work order not found.");
  let order: WorkOrder;
  try { order = workOrderRecord.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error("Work order record unavailable; preserve and restore its original record."); }
  if (order.parentAgentId !== parent || order.id !== id) throw new Error("Work order identity does not match its record.");
  return order;
}

export function listWorkOrders(parent: string): WorkOrder[] {
  const directory = workOrderDirectory(parent);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => getWorkOrder(parent, name.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createWorkOrder(parent: string, raw: WorkOrderInput, now = Date.now()): WorkOrder {
  const input = workOrderInput.parse(raw);
  const path = workOrderFile(parent, input.id);
  const same = () => {
    const saved = getWorkOrder(parent, input.id);
    const { version: _version, parentAgentId: _parent, createdAt: _at, ...terms } = saved;
    if (JSON.stringify(terms) !== JSON.stringify(input)) throw new Error("This work order identity already has different terms.");
    return saved;
  };
  if (existsSync(path)) return same();
  if (Date.parse(input.until) <= now || Date.parse(input.until) > now + 365 * 86_400_000)
    throw new Error("The work order deadline must be in the future and within 365 days.");
  const order: WorkOrder = { ...input, version: 1, parentAgentId: parentId.parse(parent), createdAt: new Date(now).toISOString() };
  mkdirSync(workOrderDirectory(parent), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, JSON.stringify(order), { flag: "wx", mode: 0o600, flush: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return same(); throw error; }
  // Persist both the record and its containing directory entry before acknowledging creation.
  for (const directory of [workOrderDirectory(parent), ".work-orders", "."]) {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return order;
}

/** Payees cannot choose amounts, destinations, another agent, or a fresh submission identity. */
export function workOrderInvoice(order: WorkOrder, authenticatedPayee: string, now = Date.now()): InvoiceInput {
  if (authenticatedPayee !== order.payee) throw new Error("Work order not found.");
  if (now >= Date.parse(order.until)) throw new Error("The work order deadline has passed. Review its existing payment; do not create a replacement.");
  return { payee: order.payee, amount: order.amount, note: order.note, submission: order.id };
}

/** The first work-order flow always holds its confidential payment for owner approval. */
export function workOrderPolicy(order: Pick<WorkOrder, "payee" | "asset" | "amount">): Policy {
  return {
    frozen: false, actions: ["transfer"], confidential: true, owner_approval: true,
    assets: [order.asset], limits: { per_transaction: { [order.asset]: order.amount } },
    max_actions_per_hour: 1,
    destinations: { mode: "only", list: [{ action: "transfer", address: order.payee, confidential: true }] },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
  };
}

/** Set only by the private work-order subprocess, never by an HTTP request. */
export function currentWorkOrder(): WorkOrder | undefined {
  if (!process.env.WORK_ORDER_ID && !process.env.WORK_ORDER_PARENT) return undefined;
  if (!process.env.WORK_ORDER_ID || !process.env.WORK_ORDER_PARENT) throw new Error("Incomplete work order instance identity.");
  return getWorkOrder(process.env.WORK_ORDER_PARENT, process.env.WORK_ORDER_ID);
}
