import { z } from "zod";
import { api } from "./api.js";
import { agentId, executes } from "./env.js";
import { ASSETS } from "./policy.js";
import { daoOwner } from "./dao-owner.js";
import { callWorkOrder } from "./work-order-pool.js";
import { createWorkOrder, getWorkOrder, listWorkOrders, workOrderId, workOrderInput } from "./work-order-store.js";
import { workOrderCommand, type WorkOrderReply } from "./work-order-protocol.js";

export const newWorkOrder = workOrderInput.pick({ id: true, payee: true, amount: true, note: true, until: true });
export const workOrderRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z.object({ type: z.literal("create"), input: newWorkOrder }).strict(),
  z.object({ type: z.literal("command"), id: workOrderId, command: workOrderCommand }).strict(),
]);
type Request = z.infer<typeof workOrderRequest>;

/** The bridge is bound to the configured parent, never a caller-selected executor or owner. */
export async function localWorkOrders(parent: string, raw: Request) {
  if (parent !== agentId() || !executes()) throw new Error("Work orders require their configured parent executor.");
  const request = workOrderRequest.parse(raw);
  if (request.type === "list") return listWorkOrders(parent);
  if (request.type === "create") {
    const [agent, view] = await Promise.all([api.getAgent(parent), api.getPolicy(parent)]);
    if (agent.owner?.type !== "near" || !view.policy || view.policy.actions.includes("swap"))
      throw new Error("Create work orders from a NEAR-owned Payables agent.");
    const dao = process.env.TREASURY_ACCOUNT;
    if (dao) {
      const owner = await daoOwner(dao);
      if (owner.account_id !== agent.owner.account_id || owner.public_key !== agent.owner.public_key)
        throw new Error("The linked DAO does not own this Payables agent.");
    }
    return createWorkOrder(parent, { ...request.input, asset: ASSETS.USDC, owner: agent.owner, ...(dao && { dao }) });
  }
  getWorkOrder(parent, request.id);
  return callWorkOrder(parent, request.id, request.command);
}

async function requestWorkOrders(request: Request): Promise<unknown> {
  const { AGREEMENTS_URL, AGREEMENTS_SECRET, INVOICES_PORT } = process.env;
  if (!INVOICES_PORT && AGREEMENTS_URL && AGREEMENTS_SECRET) {
    const response = await fetch(new URL("/internal/work-orders", AGREEMENTS_URL), { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AGREEMENTS_SECRET}` },
      body: JSON.stringify({ parentAgentId: agentId(), request }), signal: AbortSignal.timeout(210_000) });
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Work order executor unavailable. Follow the existing record before repeating an action.");
    return body.result;
  }
  return localWorkOrders(agentId(), request);
}

export const workOrders = {
  list: () => requestWorkOrders({ type: "list" }) as Promise<ReturnType<typeof listWorkOrders>>,
  create: (input: z.infer<typeof newWorkOrder>) => requestWorkOrders({ type: "create", input }) as Promise<ReturnType<typeof createWorkOrder>>,
  get: (id: string) => requestWorkOrders({ type: "command", id, command: { type: "snapshot" } }) as Promise<WorkOrderReply["snapshot"]>,
  prepare: (id: string, action: Extract<z.infer<typeof workOrderCommand>, { type: "prepare" }>["action"], signer: "wallet" | "dao") =>
    requestWorkOrders({ type: "command", id, command: { type: "prepare", action, signer } }) as Promise<WorkOrderReply["prepare"]>,
  submit: (id: string, correlationId: string, signedData: Record<string, unknown>) =>
    requestWorkOrders({ type: "command", id, command: { type: "submit", correlationId, signedData } }) as Promise<WorkOrderReply["submit"]>,
  status: (id: string, correlationId: string) =>
    requestWorkOrders({ type: "command", id, command: { type: "status", correlationId } }) as Promise<WorkOrderReply["status"]>,
};
