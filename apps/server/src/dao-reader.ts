import type { DaoRequests } from "./dao-requests.ts";
import type { Settle, Settled } from "./dao-settle.ts";

/** What one read of an open request found, for the log: never a consent's or a vote's content. */
export type ReadEvent = { request: string; kind: "consent" | "vote"; agent: string } & ({ result: Settled["result"] } | { failed: string });

/**
 * Passes over the DAO requests still open (`settle`), so a vote that passed while nobody has the page open is
 * completed before what the DAO signed expires. Each read is a platform call against the credential's hourly quota,
 * which every owner's page shares, so a pass reads at most `limit`. They rotate: the least recently read first, and
 * of those the soonest to expire, so requests still waiting never hold every slot. Requests are read one at a time;
 * one that throws is reported and left open for the next pass.
 */
export function createDaoReader({ daoRequests, settle }: { daoRequests: DaoRequests; settle: Settle }, { limit }: { limit: number }) {
  /** When each open request was last read, by pass: one never read comes first. */
  const lastRead = new Map<string, number>();
  let passes = 0;
  return {
    async pass(): Promise<ReadEvent[]> {
      passes++;
      const open = [...daoRequests.open()];
      for (const id of lastRead.keys()) if (!open.some(request => request.id === id)) lastRead.delete(id);
      const due = open.sort((a, b) => (lastRead.get(a.id) ?? 0) - (lastRead.get(b.id) ?? 0) || a.votingUntil - b.votingUntil).slice(0, limit);
      const events: ReadEvent[] = [];
      for (const request of due) {
        lastRead.set(request.id, passes);
        const about = { request: request.id, kind: request.kind, agent: request.agent };
        try { events.push({ ...about, result: (await settle(request)).result }); }
        catch (error) { events.push({ ...about, failed: error instanceof Error ? error.message : String(error) }); }
      }
      return events;
    },
  };
}

/**
 * Reads the open DAO requests every `everyMs` until `signal` aborts: no pass starts after it, and one in flight
 * finishes first. Each request read is logged.
 */
export async function runDaoReader({ read, everyMs, log, sleep, signal }: {
  read: () => Promise<ReadEvent[]>;
  everyMs: number;
  log: (event: ReadEvent) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}) {
  while (!signal.aborted) {
    for (const event of await read()) log(event);
    if (!signal.aborted) await sleep(everyMs, signal);
  }
}
