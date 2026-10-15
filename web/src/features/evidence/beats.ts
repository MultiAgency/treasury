// Canonical requirements and evidence; do not maintain a second inventory here.
export * from "../../../../evidence/inventory.js";

import type { Kind } from "../../../../evidence/inventory.js";

/** Product labels only; requirement names and evidence remain canonical. */
export const AREA_NAMES: Record<Kind, string> = { facilitator: "Payables", treasury: "Portfolio" };
