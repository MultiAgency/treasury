import { randomBytes } from "node:crypto";

type Session = { account: string; createdAt: number; lastSeen: number };

/** Where sessions live. In memory for now, so a restart signs everyone out; a durable store can replace it later. */
export type SessionStore = {
  get(token: string): Session | undefined;
  set(token: string, session: Session): void;
  delete(token: string): void;
  /** Removes every session `ended` says has ended. */
  sweep(ended: (session: Session) => boolean): void;
};
export const memorySessions = (): SessionStore => {
  const sessions = new Map<string, Session>();
  return {
    get: token => sessions.get(token),
    set: (token, session) => { sessions.set(token, session); },
    delete: token => { sessions.delete(token); },
    sweep: ended => { for (const [token, session] of sessions) if (ended(session)) sessions.delete(token); },
  };
};

/**
 * Sessions bound to a verified NEAR account, ended by idle time, maximum age or sign-out. An ended session is removed
 * when its token comes back, and every sign-in and `sweep()` removes the rest, so abandoned ones don't accumulate.
 */
export function createSessions({ idleMs, maxMs, store = memorySessions(), now = Date.now }: {
  idleMs: number; maxMs: number; store?: SessionStore; now?: () => number;
}) {
  const ended = (session: Session, at: number) => at - session.lastSeen > idleMs || at - session.createdAt > maxMs;
  const sweep = () => { const at = now(); store.sweep(session => ended(session, at)); };
  return {
    maxMs,
    sweep,
    /** A new session for `account`: an unguessable token, never logged. */
    start(account: string) {
      sweep();
      const token = randomBytes(32).toString("base64url"), at = now();
      store.set(token, { account, createdAt: at, lastSeen: at });
      return token;
    },
    /** The session's account, or nothing when it has ended; reading it counts as activity. */
    account(token: string | undefined): string | undefined {
      if (!token) return undefined;
      const session = store.get(token), at = now();
      if (!session) return undefined;
      if (ended(session, at)) { store.delete(token); return undefined; }
      store.set(token, { ...session, lastSeen: at });
      return session.account;
    },
    end(token: string | undefined) { if (token) store.delete(token); },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
