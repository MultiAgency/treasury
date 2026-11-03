import { useSyncExternalStore } from "react";
// With its extension, unlike the other app modules: test/access.test.ts loads this one under Node, which resolves only
// explicit `.ts` paths.
import { onDenial, type Denial } from "../platform.ts";

/** An agent denial, with the account the session was answering for when it came (null before any session read). */
type AgentDenial = Denial & { account: string | null };
type AccessState = { session?: Denial; agents: Readonly<Record<string, AgentDenial>> };
let state: AccessState = { agents: {} };
/** The account the latest successful session read answered for. */
let account: string | null = null;
/**
 * Agents whose denial a session read has already lifted for an account, in this page. The gateway's session read and
 * an agent's route make the same provider check; if the read grants an agent and the route then denies it again, the
 * check is failing and passing in turn. That agent stays hidden until "Check access again", rather than alternating
 * between hidden and shown, with each turn sending the next read at once.
 */
const lifted = new Set<string>();
const listeners = new Set<() => void>();
const handlers = new Set<(denial: Denial) => void>();

// An explicit gateway denial hides private observations before its permission refresh returns. A procedure denial
// latches nothing: it only revokes the controls that relied on it (see main.tsx).
onDenial(denial => {
  if (denial.scope === "session") {
    if (state.session) return;
    state = { ...state, session: denial };
  } else if (denial.scope === "agent" && denial.agent) {
    if (state.agents[denial.agent]) return;
    state = { ...state, agents: { ...state.agents, [denial.agent]: { ...denial, account } } };
  }
  for (const listener of listeners) listener();
  for (const handler of handlers) handler(denial);
});

export const onAccessDenial = (handler: (denial: Denial) => void) => {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};
/** The denials in force now; `useAccessState` is the same, for components. */
export const accessState = () => state;
export const useAccessState = () => useSyncExternalStore(listener => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}, accessState);
export const deniedAt = (snapshot: AccessState, agent: string | null) => snapshot.session ?? (agent ? snapshot.agents[agent] : undefined);

/**
 * A successful session read is the authority again: it lifts the denials it answers.
 * - Signed out: nothing stays latched.
 * - Signed in: the session denial goes. An agent denial goes if the new access map grants that agent and either another
 *   account is now signed in, or this account's denial of it hasn't been lifted before in this page (see `lifted`).
 *   An agent the map doesn't grant stays hidden.
 */
export function settleDenials(viewer: { account: string; access: Readonly<Record<string, unknown>> } | null) {
  if (!viewer) {
    account = null;
    lifted.clear();
    if (!state.session && Object.keys(state.agents).length === 0) return;
    state = { agents: {} };
    for (const listener of listeners) listener();
    return;
  }
  account = viewer.account;
  const agents: Record<string, AgentDenial> = {};
  for (const [name, denial] of Object.entries(state.agents)) {
    const sameAccount = denial.account === null || denial.account === viewer.account, key = `${viewer.account}|${name}`;
    if (name in viewer.access && !(sameAccount && lifted.has(key))) {
      if (sameAccount) lifted.add(key);
      continue;
    }
    agents[name] = denial;
  }
  if (!state.session && Object.keys(agents).length === Object.keys(state.agents).length) return;
  state = { agents };
  for (const listener of listeners) listener();
}

/** Reloading checks the session and starts fresh caches; no owner action or payment is retried. */
export const recheckAccess = () => location.reload();
