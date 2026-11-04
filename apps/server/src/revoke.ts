import type { Audit, AuditEntry } from "./audit.ts";
import { failure, log } from "./log.ts";
import type { ConsentRecord, Platform } from "./platform.ts";

/** Records a result; a record that can't be written is logged instead, since its attempt is already on record. */
export const recordResult = async (audit: Audit, entry: Extract<AuditEntry, { stage: "result" }>) => {
  try { await audit.append(entry); } catch (error) { log("audit_failed", { ...entry, error: String(error) }); }
};

/** How many consents one call revokes; more are left for the next, which revokes the rest. */
export const REVOKES_PER_REQUEST = 5;

/**
 * Revokes `consents`, at most `REVOKES_PER_REQUEST`, each recorded before and after for `who`. One whose attempt can't
 * be recorded is skipped, so nothing reaches the platform unrecorded. Answers how many were revoked and whether all were.
 */
export async function revokeAll(consents: readonly ConsentRecord[], who: string, agent: string, { platform, audit }: { platform: Platform; audit: Audit }) {
  let revoked = 0, complete = consents.length <= REVOKES_PER_REQUEST;
  for (const consent of consents.slice(0, REVOKES_PER_REQUEST)) {
    try { await audit.append({ who, action: "revoke", agent, subject: consent.id, stage: "attempt" }); }
    catch (error) { log("audit_failed", { action: "revoke", agent, subject: consent.id, error: String(error) }); complete = false; continue; }
    const answer = await platform.consents.revoke(consent.id);
    if (answer.ok) revoked++;
    else { complete = false; log("platform_revoke_failed", { agent, consent: consent.id, ...failure(answer) }); }
    await recordResult(audit, { who, action: "revoke", agent, subject: consent.id, stage: "result",
      answer: answer.ok ? { ok: true } : { ok: false, kind: answer.kind, ...("status" in answer && { status: answer.status }) } });
  }
  return { revoked, complete };
}
