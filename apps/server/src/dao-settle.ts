import type { Audit } from "./audit.ts";
import { liveConsents } from "./consent.ts";
import type { DaoRequests, StoredDaoRequest, StoredDaoVote } from "./dao-requests.ts";
import { failure, log } from "./log.ts";
import type { ConsentRecord, Platform } from "./platform.ts";
import { recordResult, revokeAll } from "./revoke.ts";

/**
 * What one read of an open DAO request found:
 * - `stored`: the DAO's consent passed and is stored; the request is closed;
 * - `relayed`: the DAO's vote passed and was relayed to its proposal (`proposalState`); the request is closed;
 * - `pending`: no vote has passed yet, or the platform couldn't complete it now; the request stays open;
 * - `ended`: it can't complete any more (`expired`: past its deadline, `stopped`: a DAO stop ended it, `changed`: the
 *   agent isn't the DAO's with the identity its consent names any more, `gone`: the platform no longer keeps it); the
 *   request is closed.
 */
export type Settled =
  | { result: "stored"; consent: ConsentRecord }
  | { result: "relayed"; proposalState: string }
  | { result: "pending" }
  | { result: "ended"; why: "expired" | "stopped" | "changed" | "gone" };

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
 * A consent request's 409 is final, for one of two reasons the platform tells apart only in its message: a DAO stop
 * ended it, or the agent isn't the DAO's with the identity the consent names any more (`whyConsentEnded`). A vote's
 * 409 isn't final: the platform answers it both for a relay the agent refused for now (read again relays the same
 * signature) and for a consent that ended. So a vote stays open until it's relayed or its deadline passes (410).
 */
async function settleOnce(open: StoredDaoRequest, { platform, daoRequests, audit }: SettleDeps): Promise<Settled> {
  const dao = open.filed.dao, { agent } = open;
  const read = open.kind === "consent" ? await platform.daoConsents.state(open.id) : await platform.daoVotes.state(open.id);
  if (read.ok) {
    if (read.value.state === "pending") return { result: "pending" };
    await daoRequests.close(open.id);
    if (read.value.state === "relayed") {
      const { proposal, verdict } = open as StoredDaoVote;
      await recordResult(audit, { who: dao, action: "dao-vote-relayed", agent, subject: proposal, verdict, request: open.id, stage: "result", answer: { ok: true } });
      return { result: "relayed", proposalState: read.value.proposalState };
    }
    const { consent } = read.value as { consent: ConsentRecord };
    await recordResult(audit, { who: dao, action: "dao-consent-stored", agent, subject: consent.id, request: open.id, stage: "result", answer: { ok: true } });
    const listed = await platform.consents.list(open.organization);
    if (listed.ok) await revokeAll(liveConsents(listed.value.consents, consent).filter(older => older.id !== consent.id), dao, agent, { platform, audit });
    else log("platform_consents_failed", { agent, ...failure(listed) });
    return { result: "stored", consent };
  }
  const status = read.kind === "refused" ? read.status : undefined;
  const ended = status === 410 ? "expired" : status === 404 ? "gone"
    : status === 409 && open.kind === "consent" ? await whyConsentEnded(open, platform) : undefined;
  if (ended) {
    await daoRequests.close(open.id, ended === "gone" ? undefined : ended);
    return { result: "ended", why: ended };
  }
  log(`platform_dao_${open.kind}_state_failed`, { agent, request: open.id, ...failure(read) });
  return { result: "pending" };
}

/**
 * Why the platform refused a consent request with 409: `changed` if the agent, read anew, isn't the DAO's with the
 * identity the consent names (or no longer exists); otherwise a DAO stop ended it. Undefined while the agent can't be
 * read, so the request stays open and is read again.
 */
async function whyConsentEnded(open: Extract<StoredDaoRequest, { kind: "consent" }>, platform: Platform) {
  const { answer } = await platform.identity(open.agent, { fresh: true });
  if (answer.ok) return answer.value.owner === open.filed.dao && answer.value.agentId === open.agentId ? "stopped" as const : "changed" as const;
  if (answer.kind === "refused" && answer.status === 404) return "changed" as const;
  log("platform_identity_failed", { agent: open.agent, request: open.id, ...failure(answer) });
  return undefined;
}
