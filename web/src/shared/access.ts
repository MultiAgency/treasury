import { useSyncExternalStore } from "react";
import type { Decoded } from "../../../src/gateway/proposals.js";

export type AccessDenial = { base: string; scope: "session" | "agent" | "procedure"; message: string };
type AccessState = { session?: AccessDenial; agents: Readonly<Record<string, AccessDenial>> };
let state: AccessState = { agents: {} };
const listeners = new Set<() => void>();
const handlers = new Set<(denial: AccessDenial) => void>();

/** An explicit gateway denial hides private observations before its permission refresh returns. */
export function reportAccessDenial(denial: AccessDenial) {
  if (denial.scope === "session") {
    if (state.session) return;
    state = { ...state, session: denial };
  } else if (denial.scope === "agent") {
    if (state.agents[denial.base]) return;
    state = { ...state, agents: { ...state.agents, [denial.base]: denial } };
  }
  for (const listener of listeners) listener();
  for (const handler of handlers) handler(denial);
}

export const onAccessDenial = (handler: (denial: AccessDenial) => void) => {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};
export const useAccessState = () => useSyncExternalStore(listener => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}, () => state);
export const deniedAt = (snapshot: AccessState, base: string) => snapshot.session ?? snapshot.agents[base];

/** The same latched denial filters cached rows, render-time reads and responses arriving later. */
export function visibleProposals(proposals: readonly Decoded[], snapshot: AccessState = state): Decoded[] {
  if (snapshot.session) return [];
  return proposals.filter(p => p.what !== "agent" || !deniedAt(snapshot, `/a/${p.agent}`));
}

/** Reloading checks the session and starts fresh caches; no owner action or payment is retried. */
export const recheckAccess = () => location.reload();
