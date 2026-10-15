import { z } from "zod";
import { os } from "./base.js";
import { workOrderId } from "../work-order-store.js";
import { newWorkOrder, workOrders } from "../work-orders.js";

export const workOrderRoutes = { workOrders: {
  list: os.handler(() => workOrders.list()),
  create: os.input(newWorkOrder).handler(({ input }) => workOrders.create(input)),
  get: os.input(z.object({ id: workOrderId })).handler(({ input }) => workOrders.get(input.id)),
  prepare: os.input(z.object({ id: workOrderId, action: z.enum(["create", "grant", "approve", "reject", "revoke"]), signer: z.enum(["wallet", "dao"]) }))
    .handler(({ input }) => workOrders.prepare(input.id, input.action, input.signer)),
  submit: os.input(z.object({ id: workOrderId, correlationId: z.string().min(1).max(200), signedData: z.record(z.string(), z.unknown()) }))
    .handler(({ input }) => workOrders.submit(input.id, input.correlationId, input.signedData)),
  status: os.input(z.object({ id: workOrderId, correlationId: z.string().min(1).max(200) }))
    .handler(({ input }) => workOrders.status(input.id, input.correlationId)),
} };
