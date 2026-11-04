import type { Audit } from "./audit.ts";
import { liveConsents } from "./consent.ts";
import type { DaoRequests, StoredDaoRequest } from "./dao-requests.ts";
import { failure, log } from "./log.ts";
import type { ConsentRecord, Platform } from "./platform.ts";
import { recordResult, revokeAll } from "./revoke.ts";

/**
 * What one read of an open DAO request found:
 * - `stored`: the DAO's consent passed and is stored; the request is closed;
 * - `relayed`: the DAO's vote passed and was relayed to its proposal (`proposalState`); the request is closed;
 * - `pending`: no vote has passed yet, or the platform couldn't complete it now; the request stays open;
 * - `ended`: it can't complete any more (`expired`: past its deadline, `stopped`: a DAO stop ended it, `gone`: the
 *   platform no longer keeps it); the request is closed.
 */
export type Settled =
  | { result: "stored"; consent: ConsentRecord }
  | { result: "relayed"; proposalState: string }
  | { result: "pending" }
  | { result: "ended"; why: "expired" | "stopped" | "gone" };

type SettleDeps = { platform: Platform; daoRequests: DaoRequests; audit: Audit };
/** Reads an open DAO request once, and completes it if its vote passed (`createSettle`). */
export type Settle = (open: StoredDaoRequest) => Promise<Settled>;

/**
 * One `settle` for the whole server, shared by the routes and the background reader: reads of the same request already
 * in flight share one, so a passed vote is relayed, and recorded, once, however many pages and passes ask at once.
 */
export function createSettle(deps: SettleDeps): Settle {
  const reading = new Map<string, Promise<Settled>>();
  return open => {
    const pending = reading.get(open.id) ?? settleOnce(open, deps).finally(() => reading.delete(open.id));
    reading.set(open.id, pending);
    return pending;
  };
}

/**
 * Reads an open DAO request once, and completes it if its vote passed: the platform stores a consent, or relays a
 * vote, only when someone reads it after the vote, and only until what the DAO signed expires. So both the routes and
 * the background reader call this. What the vote did is recorded for the DAO (`who`), whoever's read found it; a
 * stored consent also revokes the DAO's older consents for the agent, since it voted for this one.
 *
 * A consent request a stop ended (409) is closed. A vote's 409 isn't final: the platform answers it both for a relay
 * the agent refused for now (read again relays the same signature) and for a consent that ended, and only its message
 * tells them apart. So a vote stays open until it's relayed or its deadline passes (410).
 */
async function settleOnce(open: StoredDaoRequest, { platform, daoRequests, audit }: SettleDeps): Promise<Settled> {
  const dao = open.filed.dao, { agent } = open;
  const read = open.kind === "consent" ? await platform.daoConsents.state(open.id) : await platform.daoVotes.state(open.id);
  if (read.ok) {
    if (read.value.state === "pending") return { result: "pending" };
    await daoRequests.close(open.id);
    if (read.value.state === "relayed") {
      await recordResult(audit, { who: dao, action: "dao-vote-relayed", agent, subject: (open as { proposal: string }).proposal, stage: "result", answer: { ok: true } });
      return { result: "relayed", proposalState: read.value.proposalState };
    }
    const { consent } = read.value as { consent: ConsentRecord };
    await recordResult(audit, { who: dao, action: "dao-consent-stored", agent, subject: consent.id, stage: "result", answer: { ok: true } });
    const listed = await platform.consents.list(open.organization);
    if (listed.ok) await revokeAll(liveConsents(listed.value.consents, consent).filter(older => older.id !== consent.id), dao, agent, { platform, audit });
    else log("platform_consents_failed", { agent, ...failure(listed) });
    return { result: "stored", consent };
  }
  const status = read.kind === "refused" ? read.status : undefined;
  const ended = status === 410 ? "expired" : status === 404 ? "gone" : status === 409 && open.kind === "consent" ? "stopped" : undefined;
  if (ended) {
    await daoRequests.close(open.id, ended === "gone" ? undefined : ended);
    return { result: "ended", why: ended };
  }
  log(`platform_dao_${open.kind}_state_failed`, { agent, request: open.id, ...failure(read) });
  return { result: "pending" };
}
