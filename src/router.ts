import { ownerRoutes } from "./rpc/owner.js";
import { payablesRoutes } from "./rpc/payables.js";
import { treasuryRoutes } from "./rpc/treasury.js";
import { observationsRoutes } from "./rpc/observations.js";
import { workOrderRoutes } from "./rpc/work-orders.js";

/** Public procedure names stay stable; each module owns one responsibility. */
export const router = {
  ...ownerRoutes,
  ...payablesRoutes,
  ...treasuryRoutes,
  ...observationsRoutes,
  ...workOrderRoutes,
};

export type Router = typeof router;
