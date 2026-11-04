import { accessOf, type DaoPolicy } from "@multiagency/sdk";
import { Near } from "near-kit";
import { z } from "zod";
import type { Secret } from "./config.ts";
import type { Access } from "./contract.ts";
import { rpcHeaders } from "./keys.ts";

/**
 * What the server reads of a DAO's policy: the roles' kinds and permissions (the shape `accessOf` takes) and how long a
 * proposal stays open. Anything else the view answers is kept as is; a view that isn't a policy is `unavailable`.
 */
const policySchema = z.looseObject({
  proposal_bond: z.string(),
  proposal_period: z.string().regex(/^\d+$/),
  roles: z.array(z.looseObject({
    name: z.string(),
    kind: z.union([z.string(), z.strictObject({ Group: z.array(z.string()) }), z.strictObject({ Member: z.string() })]),
    permissions: z.array(z.string()),
    vote_policy: z.record(z.string(), z.looseObject({ threshold: z.unknown() })),
  })),
  default_vote_policy: z.looseObject({ threshold: z.unknown() }),
});
/** A DAO's policy, with its proposal period in nanoseconds (Sputnik's `U64`, a decimal string). */
export type Policy = DaoPolicy & { proposal_period: string };

/** Sputnik's proposal statuses (`sputnikdao2/src/proposals.rs`). A `Removed` proposal is deleted, so it's never read. */
const proposalSchema = z.looseObject({
  id: z.number().int().nonnegative(),
  kind: z.unknown(),
  status: z.enum(["InProgress", "Approved", "Rejected", "Removed", "Expired", "Moved", "Failed"]),
  /** Nanoseconds since the epoch (`U64`). */
  submission_time: z.string().regex(/^\d+$/),
});
export type DaoProposal = z.infer<typeof proposalSchema>;
/** The DAO's proposals from a number on, and the number its next proposal will get (`get_last_proposal_id`). */
export type ProposalsFrom = { next: number; proposals: DaoProposal[] };

/** Proposals are read this many at a time, as the platform reads them (`src/chain.ts`). */
const PROPOSALS_PER_READ = 100;
/** At most this many pages from a number: a DAO that took more proposals than that during one vote isn't read further. */
const PAGES_PER_READ = 10;

/** What the server reads of DAOs on chain; each read is `unavailable` when the chain didn't answer in time. */
export type DaoChain = {
  /** A DAO's policy, read at most a minute ago: a member the DAO removes loses access within that. */
  policy(dao: string): Promise<Policy | "unavailable">;
  /** A DAO's proposals numbered `from` or later (at most 1,000), read at most a few seconds ago. */
  proposals(dao: string, from: number): Promise<ProposalsFrom | "unavailable">;
  /** The number the DAO's next proposal will get, read now: a request filed after this read is answered at it or later. */
  next(dao: string): Promise<number | "unavailable">;
};

/** The part of near-kit the reads use. */
export type ChainView = { view(contractId: string, methodName: string, args: object, options: { finality: "final" }): Promise<unknown> };

/**
 * DAOs read through the server's RPC (as the key check is), at final finality: a policy reused for at most
 * `policyMaxAgeMs` (a minute, as the platform does), proposals for `proposalsMaxAgeMs`. Reads that miss together share
 * one call, a failure is never reused, and a slow RPC answers `unavailable` after `timeoutMs`.
 */
export function chainDaos({ rpcUrl, apiKey, timeoutMs, policyMaxAgeMs = 60_000, proposalsMaxAgeMs = 5_000, now = Date.now, view }: {
  rpcUrl: string; apiKey: Secret | undefined; timeoutMs: number; policyMaxAgeMs?: number; proposalsMaxAgeMs?: number; now?: () => number; view?: ChainView;
}): DaoChain {
  const near = view ?? new Near({ network: { networkId: "mainnet", rpcUrl }, headers: rpcHeaders(rpcUrl, apiKey), retryConfig: { maxRetries: 1, initialDelayMs: 250 } });
  const read = async <S extends z.ZodType>(schema: S, dao: string, method: string, args: object): Promise<z.output<S> | "unavailable"> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const answer = await Promise.race([near.view(dao, method, args, { finality: "final" }), timeout]);
      if (answer === "timeout") return "unavailable";
      const parsed = schema.safeParse(answer);
      return parsed.success ? parsed.data : "unavailable";
    } catch {
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
  };
  const next = (dao: string) => read(z.number().int().nonnegative(), dao, "get_last_proposal_id", {});
  return {
    next,
    policy: reused({ ms: policyMaxAgeMs, now }, async (dao: string) => await read(policySchema, dao, "get_policy", {}) as Policy | "unavailable"),
    proposals: reused({ ms: proposalsMaxAgeMs, now }, async (dao: string, from: number): Promise<ProposalsFrom | "unavailable"> => {
      const last = await next(dao);
      if (last === "unavailable") return last;
      const proposals: DaoProposal[] = [];
      for (let index = from, pages = 0; index < last && pages < PAGES_PER_READ; index += PROPOSALS_PER_READ, pages++) {
        const page = await read(z.array(proposalSchema), dao, "get_proposals", { from_index: index, limit: Math.min(last - index, PROPOSALS_PER_READ) });
        if (page === "unavailable") return page;
        proposals.push(...page);
      }
      return { next: last, proposals };
    }),
  };
}

/**
 * `read`, with a successful answer reused per arguments for `age.ms`, and reads that miss together sharing one call.
 * `unavailable` is never reused.
 */
function reused<A extends unknown[], T>(age: { ms: number; now: () => number }, read: (...args: A) => Promise<T | "unavailable">) {
  const kept = new Map<string, { value: T; until: number }>();
  const reading = new Map<string, Promise<T | "unavailable">>();
  return async (...args: A): Promise<T | "unavailable"> => {
    const key = JSON.stringify(args), reuse = kept.get(key);
    if (reuse && reuse.until > age.now()) return reuse.value;
    const pending = reading.get(key) ?? read(...args).then(value => {
      if (value !== "unavailable") kept.set(key, { value, until: age.now() + age.ms });
      return value;
    }).finally(() => reading.delete(key));
    reading.set(key, pending);
    return pending;
  };
}

/**
 * Fixed DAOs: a policy and proposals per DAO, for tests, and for the platform's stack until it publishes its chain
 * (MultiAgency/platform#18). A DAO missing from `policies` has no readable policy, and one missing from `proposals` no
 * readable proposals. Both may be changed while in use.
 */
export function standInDaos(policies: Record<string, Policy>, proposals: Record<string, DaoProposal[]> = {}): DaoChain {
  return {
    next: async dao => proposals[dao]?.length ?? "unavailable",
    policy: async dao => policies[dao] ?? "unavailable",
    proposals: async (dao, from) => {
      const all = proposals[dao];
      if (!all) return "unavailable";
      return { next: all.length, proposals: all.filter(proposal => proposal.id >= from).slice(0, PROPOSALS_PER_READ * PAGES_PER_READ) };
    },
  };
}

/**
 * What `account` may do for an agent the DAO `dao` owns, by the platform's own reading of its roles: null unless one of
 * its Group roles names the account. Everyone's rights admit no one. Members never sign as the DAO (`canSign` false).
 */
export const memberAccess = (account: string, dao: string, policy: DaoPolicy): Access | null =>
  accessOf(account, { account: dao, policy, signer: dao });
