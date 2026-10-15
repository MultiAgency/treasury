/** Compatibility exports. Implementation dependencies use the focused planning modules directly. */
export type { Plan, PlannedAction, Snapshot } from "./planning/model.js";
export { snapshot, observe } from "./planning/observation.js";
export { savePlan, loadPlan, claimPlan } from "./planning/store.js";
export { checkPlan, feasibility } from "./planning/checks.js";
export { executePlan, type PlanEvent } from "./planning/execution.js";
