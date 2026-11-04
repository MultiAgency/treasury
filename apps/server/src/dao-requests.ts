import { proposalId } from "@multiagency/sdk";
import { z } from "zod";
import { daoTransactions } from "./contract.ts";
import type { Filed } from "./dao-offer.ts";
import { createRecords } from "./records.ts";

const common = {
  organization: z.string().min(1),
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** The platform's request ID: the NEP-413 hash the DAO's vote signs. */
  id: z.string().regex(/^[a-f0-9]{64}$/),
  /** What the DAO's proposal says, as the platform wrote it, and the time by which its vote must pass (ms). */
  description: z.string(),
  votingUntil: z.number(),
  filed: z.strictObject({ dao: z.string(), next: z.number().int().nonnegative(), transactions: daoTransactions }),
};
/** A DAO's consent to this app, or its vote on one of this app's Treasury proposals. */
const storedDaoRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("consent"), ...common }),
  z.strictObject({ kind: z.literal("vote"), ...common, proposal: proposalId, verdict: z.enum(["approve", "reject"]) }),
]);
/** A DAO request this server filed and hasn't seen end: what it needs to show it again and to read its state. */
export type StoredDaoRequest = z.infer<typeof storedDaoRequest> & { filed: Filed };
export type StoredDaoVote = Extract<StoredDaoRequest, { kind: "vote" }>;

/**
 * The DAO requests this server has filed and not yet seen end, in one owner-only file (`createRecords`): a request is
 * stored before it's shown, since the platform answers its transactions only once. At most one consent request is open
 * per Organization and agent, at most one vote per proposal (two opposite votes would only race), and at most `max`
 * requests in all.
 */
export async function createDaoRequests(path: string, { max = 256 } = {}) {
  const { all, commit } = await createRecords(path, "requests", storedDaoRequest, "the DAO requests this server filed");
  const records = () => all() as readonly StoredDaoRequest[];
  /**
   * Why each agent's last consent request ended without a consent, until another is filed: whichever read saw it end
   * (a page's or the background reader's), the page can say why. Kept in memory only: a restart forgets the reason,
   * never a request.
   */
  const endings = new Map<string, "expired" | "stopped">();
  const agentKey = (organization: string, agent: string) => `${organization} ${agent}`;
  /** Whether `b` would duplicate the open `a`: the same agent's consent, or a vote on the same proposal. */
  const sameSubject = (a: StoredDaoRequest, b: StoredDaoRequest) => a.kind === b.kind && a.organization === b.organization && a.agent === b.agent
    && (a.kind === "consent" || a.proposal === (b as StoredDaoVote).proposal);
  return {
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
      if (added && record.kind === "consent") endings.delete(agentKey(record.organization, record.agent));
      return added;
    },
    /** Forgets a request that has ended: completed, refused, or past its vote; a consent request's `why`, if it ended without one, is kept. */
    async close(id: string, why?: "expired" | "stopped") {
      const closing = records().find(record => record.id === id);
      await commit(current => current.filter(record => record.id !== id));
      if (closing?.kind === "consent" && why) endings.set(agentKey(closing.organization, closing.agent), why);
    },
    /** Why the agent's last consent request ended without a consent, if it did and none has been filed since. */
    ended: (organization: string, agent: string) => endings.get(agentKey(organization, agent)),
  };
}
export type DaoRequests = Awaited<ReturnType<typeof createDaoRequests>>;
