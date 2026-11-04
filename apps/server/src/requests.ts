import { randomBytes } from "node:crypto";
import { proposalCreateInput, proposalId } from "@multiagency/sdk";
import { z } from "zod";
import { createRecords } from "./records.ts";

/** What `proposals/create` is asked, apart from its `requestId`. */
export type Body = Omit<z.input<typeof proposalCreateInput>, "requestId">;
/**
 * A proposal request, stored before it's first sent. `body` is the exact JSON sent, which every resend repeats: the
 * platform compares `JSON.stringify({ legs, expiresAt, note })` with what it stored, so a rebuilt body could differ.
 * `proposalId` is the proposal it made, once an answer said.
 */
export type StoredRequest = { organization: string; agent: string; requestId: string; body: string; proposalId: string | null };

const storedRequest = z.strictObject({
  organization: z.string().min(1), agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), body: z.string(), proposalId: proposalId.nullable(),
});

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
    /** Stores a new request under a new `requestId` that names the agent; null, storing nothing, when `max` are kept. */
    async add(organization: string, agent: string, body: Body): Promise<StoredRequest | null> {
      const record: StoredRequest = { organization, agent, requestId: `${agent}_${randomBytes(12).toString("hex")}`, body: JSON.stringify(body), proposalId: null };
      return await commit(current => current.length >= max ? null : [...current, record]) ? record : null;
    },
    /** Records the proposal `request` made. */
    settle: (request: StoredRequest, id: string) => commit(current => current.map(record => same(record, request) ? { ...record, proposalId: id } : record)).then(() => {}),
    /** Forgets `request`: the platform stored nothing for it, or its proposal has ended. */
    drop: (request: StoredRequest) => commit(current => current.filter(record => !same(record, request))).then(() => {}),
    /** The input `proposals/create` is sent for `request`: its `requestId`, then its stored body as it was stored. */
    input: (request: StoredRequest) => ({ requestId: request.requestId, ...JSON.parse(request.body) }) as z.input<typeof proposalCreateInput>,
  };
}
export type Requests = Awaited<ReturnType<typeof createRequests>>;

