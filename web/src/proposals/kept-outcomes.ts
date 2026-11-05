import { useSyncExternalStore } from "react";
import type { GrantPrepared } from "./proposals-api";

/**
 * What a page remembers about an action whose outcome may be unknown, kept outside any component (#146). The agent's
 * pages are separate routes: leaving Funding or Strategy unmounts its component, and coming back must not offer the
 * action again as if nothing had happened. Like `blockFunding`, this lasts as long as the page is loaded: no read the
 * page makes reports whether a shield was sent, and a reload starts the page afresh.
 */

const shields = new Map<string, true>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The agent's shield may have gone out (a lost answer, or a run that sent some of it): Shield isn't offered again. */
export function blockShield(agent: string) {
  if (shields.has(agent)) return;
  shields.set(agent, true);
  changed();
}
export const shieldBlocked = (agent: string) => shields.has(agent);
export const useShieldBlock = (agent: string) => useSyncExternalStore(subscribe, () => shields.has(agent));

/**
 * The grant the agent's strategy is being authorized with, by the strategy's digest: once it is prepared, signing or filing
 * it may already have happened (a lost answer, a wallet that didn't say), so a return to the Strategy page resumes reading
 * its status instead of offering to start another. A grant for another digest, or one that reached a final stage without
 * taking effect (expired, failed), is forgotten.
 */
const grants = new Map<string, { digest: string; grant: GrantPrepared }>();

export const keptGrant = (agent: string, digest: string): GrantPrepared | undefined => {
  const kept = grants.get(agent);
  return kept?.digest === digest ? kept.grant : undefined;
};
export const keepGrant = (agent: string, digest: string, grant: GrantPrepared) => { grants.set(agent, { digest, grant }); };
export const forgetGrant = (agent: string) => { grants.delete(agent); };

/** For tests: forget everything, as a fresh page load would. */
export function resetKeptOutcomes() { shields.clear(); grants.clear(); changed(); }
