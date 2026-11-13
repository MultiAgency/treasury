import { proposalId } from "@multiagency/sdk";
import { z } from "zod";
import { daoTransactions } from "./contract.ts";
import type { Filed } from "./dao-offer.ts";
import { createRecords } from "./records.ts";

const base = {
  organization: z.string().min(1),
  /** The platform's request ID: the NEP-413 hash the DAO's vote signs. */
  id: z.string().regex(/^[a-f0-9]{64}$/),
  /** What the DAO's proposal says, as the platform wrote it, and the time by which its vote must pass (ms). */
  description: z.string(),
  votingUntil: z.number(),
  filed: z.strictObject({ dao: z.string(), next: z.number().int().nonnegative(), transactions: daoTransactions }),
};
const common = { ...base, agent: z.string().regex(/^[a-z0-9-]{1,32}$/) };
/**
 * Why a consent or setup request ended without completing: its vote didn't pass in time, a DAO stop ended it, the DAO
 * voted it down, the agent isn't the DAO's with the identity the consent names any more, or the platform refused to
 * set it up after the vote (the DAO's Treasury agent is already created, or its key changed).
 */
export type DaoEnding = "expired" | "stopped" | "rejected" | "changed" | "refused";
/** Endings kept in memory at once. */
const MAX_ENDINGS = 1_024;
/**
 * A DAO's consent to this app, its vote on one of this app's Treasury proposals, or its setup of its Organization's
 * Treasury agent, which names no agent until the platform reserves one.
 */
const storedDaoRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("setup"), ...base }),
  /** A consent names the agent's identity (`agentId`) as it was when filed. */
  z.strictObject({ kind: z.literal("consent"), ...common, agentId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("vote"), ...common, proposal: proposalId, verdict: z.enum(["approve", "reject"]) }),
]);
/** A DAO request this server filed and hasn't seen end: what it needs to show it again and to read its state. */
export type StoredDaoRequest = z.infer<typeof storedDaoRequest> & { filed: Filed };
export type StoredDaoVote = Extract<StoredDaoRequest, { kind: "vote" }>;
export type StoredDaoSetup = Extract<StoredDaoRequest, { kind: "setup" }>;
/** A request that concerns one agent: a consent or a vote. */
export type StoredAgentRequest = Exclude<StoredDaoRequest, StoredDaoSetup>;

/**
 * The DAO requests this server has filed and not yet seen end, in one owner-only file (`createRecords`): a request is
 * stored before it's shown, since the platform answers its transactions only once. At most one setup is open per
 * Organization, one consent request per Organization and agent, one vote per proposal (two opposite votes would only
 * race), and at most `max` requests in all.
 */
export async function createDaoRequests(path: string, { max = 256 } = {}) {
  const { all, commit } = await createRecords(path, "requests", storedDaoRequest, "the DAO requests this server filed");
  const records = () => all() as readonly StoredDaoRequest[];
  /**
   * Why each agent's last consent request, each Organization's last setup, and the last vote on each proposal ended
   * without completing, until another is filed: whichever read saw it end (a page's or the background reader's), the
   * page can say why. Kept in memory only: a restart forgets the reason, never a request. At most `MAX_ENDINGS`, the
   * oldest forgotten first, since proposals keep coming.
   */
  const endings = new Map<string, DaoEnding>();
  const agentKey = (organization: string, agent: string) => `${organization} ${agent}`;
  const voteKey = (organization: string, agent: string, proposal: string) => `${agentKey(organization, agent)} vote ${proposal}`;
  /** Where a request's ending is kept: a setup names no agent, a vote names its proposal, and no agent's name has a space. */
  const endingKey = (record: StoredDaoRequest) => record.kind === "setup" ? `${record.organization} setup`
    : record.kind === "vote" ? voteKey(record.organization, record.agent, record.proposal) : agentKey(record.organization, record.agent);
  /** Whether `b` would duplicate the open `a`: the same Organization's setup, the same agent's consent, or a vote on the same proposal. */
  const sameSubject = (a: StoredDaoRequest, b: StoredDaoRequest) => a.kind === b.kind && a.organization === b.organization
    && (a.kind === "setup" || (a.agent === (b as StoredAgentRequest).agent && (a.kind === "consent" || a.proposal === (b as StoredDaoVote).proposal)));
  return {
    /** The open setup for the Organization, if any. */
    setup: (organization: string) => records().find((record): record is StoredDaoSetup => record.kind === "setup" && record.organization === organization),
    /** The open consent request for the agent under the Organization, if any. */
    consent: (organization: string, agent: string) =>
      records().find(record => record.kind === "consent" && record.organization === organization && record.agent === agent),
    /** The open vote on the agent's proposal under the Organization, if any. */
    vote: (organization: string, agent: string, proposal: string) =>
      records().find((record): record is StoredDaoVote => record.kind === "vote" && record.organization === organization && record.agent === agent && record.proposal === proposal),
    /** Every open request, for the reader that completes them. */
    open: records,
    /** Whether another request can be kept: checked before filing, since one the platform filed must be followed. */
    hasRoom: () => records().length < max,
    /** Stores a new request; false, storing nothing, while one for the same subject is open or `max` are kept. */
    async add(record: StoredDaoRequest) {
      const added = await commit(current => current.length >= max || (current as readonly StoredDaoRequest[]).some(open => sameSubject(open, record)) ? null : [...current, record]);
      if (added) endings.delete(endingKey(record));
      return added;
    },
    /** Forgets a request that has ended: completed, refused, or past its vote; its `why`, if it ended without completing, is kept. */
    async close(id: string, why?: DaoEnding) {
      const closing = records().find(record => record.id === id);
      await commit(current => current.filter(record => record.id !== id));
      if (!closing || !why) return;
      endings.delete(endingKey(closing));
      while (endings.size >= MAX_ENDINGS) endings.delete(endings.keys().next().value!);
      endings.set(endingKey(closing), why);
    },
    /** Why the agent's last consent request ended without a consent, if it did and none has been filed since. */
    ended: (organization: string, agent: string) => endings.get(agentKey(organization, agent)),
    /** Why the last vote on the agent's proposal ended without a verdict, if it did and none has been filed on it since. */
    voteEnded: (organization: string, agent: string, proposal: string) => endings.get(voteKey(organization, agent, proposal)),
    /** Why the Organization's last setup ended without reserving its agent, if it did and none has been filed since. */
    setupEnded: (organization: string) => endings.get(`${organization} setup`),
  };
}
export type DaoRequests = Awaited<ReturnType<typeof createDaoRequests>>;
