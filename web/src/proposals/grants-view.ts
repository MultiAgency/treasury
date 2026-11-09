// The agent's grants as the Policy page shows them (#142): which are live and which ended, what waits on a revocation's
// outcome, and what the owner may do. Pure, so it's tested without a browser.
// With its extensions: test/grants-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { waitingOn } from "./freeze-view.ts";

export type Grant = { grant_id: string; label: string; issued_at: string; expires_at: string; revoked_at: string | null };

/** A grant is live until it is revoked or reaches its expiry; the rest are history, newest first. */
export function splitGrants(grants: readonly Grant[], now: number): { live: Grant[]; ended: Grant[] } {
  const isLive = (grant: Grant) => !grant.revoked_at && Date.parse(grant.expires_at) > now;
  const newest = (a: Grant, b: Grant) => Date.parse(b.issued_at) - Date.parse(a.issued_at);
  return { live: grants.filter(isLive).sort(newest), ended: grants.filter(grant => !isLive(grant)).sort(newest) };
}

/** What an earlier revocation waits on, from the platform's own record (so it is found after a reload, too). */
export const waitingRevocation = (input: Parameters<typeof waitingOn>[1]) => waitingOn("grant_revoke", input);

export type RevokeControls =
  | { kind: "ready"; label: string }
  | { kind: "needs-owner-scope" }
  | { kind: "needs-member" };

/** Whether a grant may be revoked from here: a wallet owner needs owner actions allowed; a DAO member needs filing roles. */
export function revokeControls({ ownerScope, signer, canPropose }: { ownerScope: boolean; signer: "wallet" | "dao"; canPropose: boolean }): RevokeControls {
  if (signer === "wallet" && !ownerScope) return { kind: "needs-owner-scope" };
  if (signer === "dao" && !canPropose) return { kind: "needs-member" };
  return { kind: "ready", label: signer === "dao" ? "Propose to revoke" : "Revoke" };
}

/** How long a DAO's vote has, in words, so the member knows what they are asking for before they file. */
export const DAO_WINDOW_WORDS = "about 5 minutes (290 seconds)";
