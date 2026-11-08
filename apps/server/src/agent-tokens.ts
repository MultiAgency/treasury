import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createRecords, memoryRecords } from "./records.ts";

/** The longest an owner may let a token live (#139). */
export const MAX_TOKEN_DAYS = 30;
/** Tokens a single agent may hold unended: enough for a few agents of an owner's, few enough to review by eye. */
const MAX_LIVE_PER_AGENT = 10;
/** Records kept in all, ended ones included until `KEEP_ENDED_MS` has passed. */
const MAX_RECORDS = 1_024;
const KEEP_ENDED_MS = 7 * 86_400_000;
/** `lastUsedAt` is kept in memory on every call but written to disk at most this often: a read must not cost a write. */
const PERSIST_USE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * What the server keeps of a token: never the token itself, only the SHA-256 of its secret. `account` is who issued it,
 * and a call by the token is admitted exactly as a call by that account's session would be (still the owner, or still a
 * DAO member who may propose), so an ownership change ends a token's use without anyone remembering to revoke it.
 */
const stored = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  account: z.string().min(1),
  label: z.string().max(40),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
});
export type StoredAgentToken = z.output<typeof stored>;
/** A token as the owner is shown it: when it was made, when it lapses, when it was last used. Never the secret or its hash. */
export type AgentTokenView = Pick<StoredAgentToken, "id" | "label" | "createdAt" | "expiresAt" | "lastUsedAt">;

const TOKEN = /^tre1\.([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const hashOf = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
const viewOf = ({ id, label, createdAt, expiresAt, lastUsedAt }: StoredAgentToken): AgentTokenView => ({ id, label, createdAt, expiresAt, lastUsedAt });
const live = (token: StoredAgentToken, now: number) => token.revokedAt === null && token.expiresAt > now;

/** Where the records are kept: `createRecords`' file, or (in a test) memory. */
export type TokenRecords = Pick<Awaited<ReturnType<typeof createRecords<typeof stored>>>, "all" | "commit">;

/** Records that live only as long as the process: for tests, and the default when no file is configured. */
export const memoryTokenRecords = (): TokenRecords => memoryRecords<StoredAgentToken>();

/** The tokens file: owner-only like the credential file, and only hashes in it. */
export const fileTokenRecords = (path: string) => createRecords(path, "tokens", stored, "the agent tokens this server issued");

/**
 * The tokens this server issues to an owner's agent (#139): issued from the owner's session for one agent, shown once,
 * stored hashed, listed with when each was last used, and revocable. A revocation answers once it is on disk, and every
 * call reads the records, so it holds from the next call; a write that fails revokes nothing and says so.
 */
export function createAgentTokens(records: TokenRecords, { now = Date.now }: { now?: () => number } = {}) {
  const lastPersistedUse = new Map<string, number>();
  const prune = (all: readonly StoredAgentToken[], at: number) => all.filter(token => live(token, at) || (token.revokedAt ?? token.expiresAt) + KEEP_ENDED_MS > at);

  return {
    /**
     * Issues a token for `agent`, to last `days` (1 to 30), and answers it once: it can't be read again. Refused (null)
     * when the agent already holds as many live tokens as it may, or the server holds as many records as it may.
     */
    async issue({ agent, account, days, label = "" }: { agent: string; account: string; days: number; label?: string }): Promise<{ token: string; view: AgentTokenView } | null> {
      if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) throw new RangeError(`A token lasts 1 to ${MAX_TOKEN_DAYS} days`);
      const at = now(), id = randomBytes(8).toString("hex"), secret = randomBytes(32).toString("base64url");
      const record: StoredAgentToken = { id, agent, account, label: label.slice(0, 40), hash: hashOf(secret), createdAt: at, expiresAt: at + days * DAY_MS, lastUsedAt: null, revokedAt: null };
      const written = await records.commit(current => {
        const kept = prune(current, at);
        if (kept.filter(token => token.agent === agent && live(token, at)).length >= MAX_LIVE_PER_AGENT || kept.length >= MAX_RECORDS) return null;
        return [...kept, record];
      });
      return written ? { token: `tre1.${id}.${secret}`, view: viewOf(record) } : null;
    },
    /**
     * The record a token presents, or undefined: a token that doesn't parse, names no record, has the wrong secret, was
     * revoked or has lapsed. The secret is compared in constant time.
     */
    find(presented: string): StoredAgentToken | undefined {
      const parts = TOKEN.exec(presented);
      if (!parts) return undefined;
      const record = records.all().find(token => token.id === parts[1]);
      const want = Buffer.from(record?.hash ?? "0".repeat(64), "hex"), got = Buffer.from(hashOf(parts[2]!), "hex");
      return record && timingSafeEqual(want, got) && live(record, now()) ? record : undefined;
    },
    /** Notes a use. In memory at once, on disk at most once a minute; a failed write loses only the time of use. */
    async used(id: string): Promise<void> {
      const at = now(), record = records.all().find(token => token.id === id);
      if (!record) return;
      (record as { lastUsedAt: number | null }).lastUsedAt = at;
      if (at - (lastPersistedUse.get(id) ?? 0) < PERSIST_USE_MS) return;
      lastPersistedUse.set(id, at);
      await records.commit(current => current.map(token => token.id === id ? { ...token, lastUsedAt: at } : token)).catch(() => {});
    },
    /** The agent's live tokens, newest first. */
    list(agent: string): AgentTokenView[] {
      const at = now();
      return records.all().filter(token => token.agent === agent && live(token, at)).map(viewOf).sort((a, b) => b.createdAt - a.createdAt);
    },
    /** Revokes one of the agent's tokens; false when it has none live by that ID. */
    revoke(agent: string, id: string): Promise<boolean> {
      const at = now();
      return records.commit(current => current.some(token => token.id === id && token.agent === agent && live(token, at))
        ? current.map(token => token.id === id && token.agent === agent && live(token, at) ? { ...token, revokedAt: at } : token) : null);
    },
    /** Revokes all of the agent's tokens: its owner disconnected it, so nothing acts for it any more. */
    async revokeAll(agent: string): Promise<number> {
      const at = now();
      const count = records.all().filter(token => token.agent === agent && live(token, at)).length;
      if (count === 0) return 0;
      await records.commit(current => current.map(token => token.agent === agent && live(token, at) ? { ...token, revokedAt: at } : token));
      return count;
    },
  };
}
export type AgentTokens = ReturnType<typeof createAgentTokens>;
