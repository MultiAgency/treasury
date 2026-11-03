import { randomBytes } from "node:crypto";

type Session = { account: string; createdAt: number; lastSeen: number };

/** Where sessions live. In memory for now, so a restart signs everyone out; a durable store can replace it later. */
export type SessionStore = {
  get(token: string): Session | undefined;
  set(token: string, session: Session): void;
  delete(token: string): void;
};
export const memorySessions = (): SessionStore => {
  const sessions = new Map<string, Session>();
  return { get: token => sessions.get(token), set: (token, session) => { sessions.set(token, session); }, delete: token => { sessions.delete(token); } };
};

/** Sessions bound to a verified NEAR account, ended by idle time, maximum age or sign-out. */
export function createSessions({ idleMs, maxMs, store = memorySessions(), now = Date.now }: {
  idleMs: number; maxMs: number; store?: SessionStore; now?: () => number;
}) {
  return {
    maxMs,
    /** A new session for `account`: an unguessable token, never logged. */
    start(account: string) {
      const token = randomBytes(32).toString("base64url"), at = now();
      store.set(token, { account, createdAt: at, lastSeen: at });
      return token;
    },
    /** The session's account, or nothing when it has ended; reading it counts as activity. */
    account(token: string | undefined): string | undefined {
      if (!token) return undefined;
      const session = store.get(token), at = now();
      if (!session) return undefined;
      if (at - session.lastSeen > idleMs || at - session.createdAt > maxMs) { store.delete(token); return undefined; }
      store.set(token, { ...session, lastSeen: at });
      return session.account;
    },
    end(token: string | undefined) { if (token) store.delete(token); },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
