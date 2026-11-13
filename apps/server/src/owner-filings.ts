import type { Filed } from "./dao-offer.ts";

/**
 * A DAO owner action as its member was handed it to file (a freeze, an unfreeze, a grant, a revocation, a policy edit,
 * a creation): the DAO's next proposal number read while it was prepared, and both transactions the platform answered,
 * which it answers only once.
 */
export type OwnerFiling = { organization: string; agent: string; correlationId: string; expiresAt: string; filed: Filed };

/** How long a filing is kept past its vote's deadline, so a page still open can say how the vote ended. */
const KEEP_ENDED_MS = 3_600_000;

/**
 * The DAO owner actions this server prepared and whose vote may still be open, so the DAO's proposal for one can be
 * found again (`offerFor`) by any member: its number, where to vote on it, who approved, or, unfiled, the transaction
 * that member's roles may file. Kept in memory only, as creation reviews are: these votes last minutes, so a restart
 * forgets at most that the proposal could be linked to, never the action, which the platform holds.
 */
export function ownerFilings({ limit = 1_024, now = () => Date.now() }: { limit?: number; now?: () => number } = {}) {
  const saved = new Map<string, OwnerFiling>();
  const key = (organization: string, agent: string, id: string) => JSON.stringify([organization, agent, id]);
  const prune = () => {
    for (const [id, value] of saved) if (!(Date.parse(value.expiresAt) + KEEP_ENDED_MS > now())) saved.delete(id);
  };
  return {
    /** Keeps what the platform just answered for the action, in place of anything kept under its ID before. */
    keep(filing: OwnerFiling) {
      prune();
      const id = key(filing.organization, filing.agent, filing.correlationId);
      saved.delete(id);
      while (saved.size >= limit) saved.delete(saved.keys().next().value!);
      saved.set(id, structuredClone(filing));
    },
    /** Forgets the action's filing: one prepared now that couldn't be kept must not be answered from an earlier one. */
    forget(organization: string, agent: string, id: string) { saved.delete(key(organization, agent, id)); },
    get(organization: string, agent: string, id: string): OwnerFiling | undefined {
      prune();
      const value = saved.get(key(organization, agent, id));
      return value && structuredClone(value);
    },
  };
}
export type OwnerFilings = ReturnType<typeof ownerFilings>;
