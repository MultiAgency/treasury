import { readFile, stat } from "node:fs/promises";
import { accessOf, type Access, type DaoPolicy } from "@multiagency/sdk";
import { Near } from "near-kit";
import { z } from "zod";
import type { Secret } from "./config.ts";
import { daoTransaction } from "./contract.ts";
import { writeAtomic } from "./files.ts";
import { rpcHeaders } from "./keys.ts";

/**
 * DAO-owned agents (#20, PR 5). When `identity` answers `signer: "dao"`, the owner is a Sputnik DAO with no keys: the
 * platform admits this app, not a member, so this server gates each member itself with the SDK's own reading of the
 * DAO's roles (`accessOf`), from its `get_policy` view read at most a minute ago (app-server skill, "A DAO owner").
 */

/** A DAO's policy as its `get_policy` view answers it, or `unavailable` when the chain didn't answer or answered nonsense. */
export type PolicyRead = DaoPolicy | "unavailable";
export type PolicyReader = (dao: string) => Promise<PolicyRead>;

const threshold = z.looseObject({ threshold: z.unknown() });
/** The parts of a Sputnik policy `accessOf` reads; anything else it holds is kept, unread. */
const policyView = z.looseObject({
  proposal_bond: z.string(),
  roles: z.array(z.looseObject({
    name: z.string(),
    kind: z.union([z.string(), z.looseObject({ Group: z.array(z.string()) }), z.looseObject({ Member: z.string() })]),
    permissions: z.array(z.string()),
    vote_policy: z.record(z.string(), threshold),
  })),
  default_vote_policy: threshold,
});

/** The part of near-kit the reader uses: a view call. */
export type ViewCall = (contractId: string, method: string, args: object) => Promise<unknown>;

/**
 * The DAO's policy from the chain (`get_policy`), through the same RPC as sign-in. Every failure is `unavailable`,
 * never an empty policy: a policy that can't be read admits no member. One retry at most and a timeout.
 */
export function chainPolicyReader({ rpcUrl, apiKey, timeoutMs, view }: { rpcUrl: string; apiKey: Secret | undefined; timeoutMs: number; view?: ViewCall }): PolicyReader {
  const call: ViewCall = view ?? (() => {
    const near = new Near({ network: { networkId: "mainnet", rpcUrl }, headers: rpcHeaders(rpcUrl, apiKey), retryConfig: { maxRetries: 1, initialDelayMs: 250 } });
    return (contractId, method, args) => near.view(contractId, method, args);
  })();
  return async dao => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const answer = await Promise.race([call(dao, "get_policy", {}), timeout]);
      if (answer === "timeout") return "unavailable";
      const parsed = policyView.safeParse(answer);
      return parsed.success ? parsed.data as DaoPolicy : "unavailable";
    } catch {
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Reuses a DAO's policy for `cacheMs` (a minute, the skill's limit). Only a policy is reused, never `unavailable`, so a
 * DAO whose chain read failed is read again on the next request.
 */
export function cachedPolicyReader(read: PolicyReader, { cacheMs = 60_000, now = Date.now }: { cacheMs?: number; now?: () => number } = {}): PolicyReader {
  const kept = new Map<string, { policy: DaoPolicy; until: number }>();
  return async dao => {
    const reuse = kept.get(dao);
    if (reuse && reuse.until > now()) return reuse.policy;
    const policy = await read(dao);
    if (policy === "unavailable") kept.delete(dao);
    else kept.set(dao, { policy, until: now() + cacheMs });
    return policy;
  };
}

/**
 * What `account` may do for the DAO's agent, or null when it isn't a member: only accounts in the DAO's Group roles are,
 * and none of them may sign as the DAO. `signer` isn't read for a member, so it's the DAO itself, as the skill passes it.
 */
export const memberAccess = (account: string, dao: string, policy: DaoPolicy): Access | null => accessOf(account, { account: dao, policy, signer: dao });

/**
 * A DAO request this server filed and follows by its ID until it's final. The platform has no list of them, and
 * filing again files a new request, so its ID is kept here: reading its `state` after the vote passed is what stores the
 * consent or relays the vote. `transactions` are as the platform answered them, for the next member who files.
 */
const record = z.strictObject({
  kind: z.enum(["consent", "vote"]),
  organization: z.string().min(1),
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** The Treasury proposal a vote is on; null for a consent. */
  proposal: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
  verdict: z.enum(["approve", "reject"]).nullable(),
  id: z.string().min(1),
  /** The NEP-413 hash the DAO's key signs: public, shown on the platform's check page. */
  hash: z.string().min(1),
  description: z.string(),
  votingUntil: z.number(),
  transactions: z.strictObject({ proposal: daoTransaction.nullable(), proposalAndVote: daoTransaction.nullable() }),
});
export type DaoRequest = z.infer<typeof record>;
const stored = z.strictObject({ version: z.literal(1), requests: z.array(record) });

export type DaoRequests = {
  /** The open request of `kind` for the agent (and the proposal, for a vote), if one is kept. */
  open(kind: DaoRequest["kind"], organization: string, agent: string, proposal?: string): DaoRequest | undefined;
  /** Keeps `request`; false, keeping nothing, when `max` are kept. Resolves once it's on disk. */
  add(request: DaoRequest): Promise<boolean>;
  /** Forgets `request`: its state is final. */
  drop(request: DaoRequest): Promise<void>;
};

/**
 * The DAO requests this server follows, at most `max` (the platform files at most 256 a day per deployment). With a
 * `path`, kept in one owner-only file replaced whole on every change (`writeAtomic`), so a vote that takes days survives
 * a restart; without one, in memory, and a restart forgets them: the member files again, for a new vote.
 */
export async function createDaoRequests(path?: string, { max = 256 } = {}): Promise<DaoRequests> {
  return store(path ? await load(path) : [], path, max);
}
/** The DAO requests in memory only: a restart forgets them. */
export const memoryDaoRequests = ({ max = 256 } = {}) => store([], undefined, max);

function store(loaded: DaoRequest[], path: string | undefined, max: number): DaoRequests {
  let records = loaded;
  let writing = Promise.resolve();
  const commit = (change: (current: DaoRequest[]) => DaoRequest[] | null) => {
    const done = writing.then(async () => {
      const next = change(records);
      if (!next) return false;
      if (path) await writeAtomic(path, JSON.stringify({ version: 1, requests: next }));
      records = next;
      return true;
    });
    writing = done.then(() => {}, () => {});
    return done;
  };
  return {
    open: (kind, organization, agent, proposal) => records.find(request => request.kind === kind && request.organization === organization
      && request.agent === agent && (kind === "consent" || request.proposal === proposal)),
    add: request => commit(current => current.length >= max ? null : [...current, record.parse(request)]),
    drop: request => commit(current => current.filter(other => other.id !== request.id)).then(() => {}),
  };
}

async function load(path: string): Promise<DaoRequest[]> {
  let text: string;
  try {
    if ((await stat(path)).mode & 0o077) throw new Error(`${path} is readable by others: it must be 0600`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try { return stored.parse(JSON.parse(text)).requests; } catch { throw new Error(`${path} doesn't hold the server's DAO requests`); }
}

/** The platform's public check page for a DAO request: the exact text the DAO's key signs and its hash recomputed. */
export const checkUrlOf = (host: string, hash: string) => `https://${host}/confirm/dao/${encodeURIComponent(hash)}`;
