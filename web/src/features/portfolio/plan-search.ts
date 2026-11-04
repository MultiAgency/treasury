/** A saved plan's identifier, as `executePlan` accepts it (a UUID). */
export const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page address's `plan`, as a route validates it: only a plan's identity, never anything that sends. */
export const planSearch = (search: Record<string, unknown>): { plan?: string } =>
  typeof search.plan === "string" && PLAN_ID.test(search.plan) ? { plan: search.plan } : {};

/** The Runs page's `run`: a recorded run's id, as the scheduler names it. */
export const runSearch = (search: Record<string, unknown>): { run?: string } =>
  typeof search.run === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(search.run) ? { run: search.run } : {};
