import { randomBytes } from "node:crypto";
import { proposalCreateInput, proposalId } from "@multiagency/sdk";
import { z } from "zod";
import { createRecords } from "./records.ts";

/** What `proposals/create` is asked, apart from its `requestId`. */
export type Body = Omit<z.input<typeof proposalCreateInput>, "requestId">;
/** What `watch` tells the builder's channel (#131). `proposed` goes with a new proposal; the others report a change. */
export const NOTICE_KINDS = ["proposed", "holding", "resumed", "expiring", "expired", "approved_not_executed"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
/** The notices a proposal of its own can raise, each at most once: recorded on its request. */
export const PROPOSAL_NOTICES = ["expiring", "expired", "approved_not_executed"] as const;
export type ProposalNotice = (typeof PROPOSAL_NOTICES)[number];
/** Why `watch` holds an agent, as a `holding` notice names it. */
export const HOLD_REASONS = ["unresolved-operations", "autopilot-on", "policy-not-in-force", "consent-ended"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * A proposal request, stored before it's first sent. `body` is the exact JSON sent, which every resend repeats: the
 * platform compares `JSON.stringify({ legs, expiresAt, note })` with what it stored, so a rebuilt body could differ.
 * `proposalId` is the proposal it made, once an answer said. `notified` lists the notices already sent for it, so a
 * restart doesn't send one again (a file written before #131 has none).
 */
export type StoredRequest = { organization: string; agent: string; requestId: string; body: string; proposalId: string | null; notified: ProposalNotice[] };

const storedRequest = z.strictObject({
  organization: z.string().min(1), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), body: z.string(), proposalId: proposalId.nullable(),
  notified: z.array(z.enum(PROPOSAL_NOTICES)).default([]),
});

/** A new `requestId` for one of `agent`'s requests: its name, then 24 random hex digits. */
export const newRequestId = (agent: string) => `${agent}_${randomBytes(12).toString("hex")}`;

/**
 * The proposal requests `watch` has made and not yet seen end, kept in one owner-only file (`createRecords`): a request
 * is sent only once it's stored. At most `max` are kept.
 */
export async function createRequests(path: string, { max = 256 } = {}) {
  const { all, commit } = await createRecords(path, "requests", storedRequest, "watch's stored requests");
  const same = (a: StoredRequest, b: StoredRequest) => a.organization === b.organization && a.agent === b.agent && a.requestId === b.requestId;
  return {
    /** The agent's stored requests under the Organization. */
    of: (organization: string, agent: string): readonly StoredRequest[] =>
      all().filter(record => record.organization === organization && record.agent === agent),
    /**
     * Stores a new request under a new `requestId` that names the agent (`newRequestId`), or under one made for it
     * beforehand; null, storing nothing, when `max` are kept.
     */
    async add(organization: string, agent: string, body: Body, requestId = newRequestId(agent)): Promise<StoredRequest | null> {
      const record: StoredRequest = { organization, agent, requestId, body: JSON.stringify(body), proposalId: null, notified: [] };
      return await commit(current => current.length >= max ? null : [...current, record]) ? record : null;
    },
    /** Records the proposal `request` made. */
    settle: (request: StoredRequest, id: string) => commit(current => current.map(record => same(record, request) ? { ...record, proposalId: id } : record)).then(() => {}),
    /** Records that `notice` was sent for `request`, before it is sent: a restart doesn't send it again. */
    mark: (request: StoredRequest, notice: ProposalNotice) => commit(current => current.map(record =>
      same(record, request) && !record.notified.includes(notice) ? { ...record, notified: [...record.notified, notice] } : record)).then(() => {}),
    /** Forgets `request`: the platform stored nothing for it, or its proposal has ended. */
    drop: (request: StoredRequest) => commit(current => current.filter(record => !same(record, request))).then(() => {}),
    /** The input `proposals/create` is sent for `request`: its `requestId`, then its stored body as it was stored. */
    input: (request: StoredRequest) => ({ requestId: request.requestId, ...JSON.parse(request.body) }) as z.input<typeof proposalCreateInput>,
  };
}
export type Requests = Awaited<ReturnType<typeof createRequests>>;

const storedHold = z.strictObject({ organization: z.string().min(1), agent: z.string().regex(/^[a-z0-9-]{1,32}$/), reason: z.enum(HOLD_REASONS) });

/** Why `watch` last told the builder an agent is held: one record per held agent, none for one that isn't. */
export type Holds = {
  get(organization: string, agent: string): HoldReason | null;
  set(organization: string, agent: string, reason: HoldReason | null): Promise<void>;
};

/** The holds kept in their own owner-only file, beside the requests': a restart doesn't announce the same hold again. */
export async function createHolds(path: string): Promise<Holds> {
  const { all, commit } = await createRecords(path, "holds", storedHold, "watch's stored holds");
  const other = (organization: string, agent: string) => (record: z.output<typeof storedHold>) => !(record.organization === organization && record.agent === agent);
  return {
    get: (organization, agent) => all().find(record => !other(organization, agent)(record))?.reason ?? null,
    async set(organization, agent, reason) {
      await commit(current => [...current.filter(other(organization, agent)), ...(reason ? [{ organization, agent, reason }] : [])]);
    },
  };
}

/** Holds kept in memory only: for a `watch` with no file for them (a test), or none to keep. */
export function memoryHolds(): Holds {
  const held = new Map<string, HoldReason>();
  return {
    get: (organization, agent) => held.get(`${organization}/${agent}`) ?? null,
    async set(organization, agent, reason) { if (reason) held.set(`${organization}/${agent}`, reason); else held.delete(`${organization}/${agent}`); },
  };
}
