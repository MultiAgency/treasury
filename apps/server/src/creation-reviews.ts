import type { z } from "zod";
import type { creation } from "./contract.ts";

type Creation = z.output<typeof creation>;
/**
 * Immutable, unsigned review bytes only. Submission/outcome holds always come from the platform's durable records. One
 * past its expiry is still answered until the next `keep` prunes it, so its reader can say it expired rather than lost.
 */
export function creationReviews({ limit = 1_024, now = () => Date.now() }: { limit?: number; now?: () => number } = {}) {
  const saved = new Map<string, Creation>();
  const key = (owner: string, agent: string, id: string) => JSON.stringify([owner, agent, id]);
  const prune = () => {
    for (const [id, value] of saved) if (!(Date.parse(value.expiresAt) > now())) saved.delete(id);
  };
  return {
    keep(owner: string, agent: string, value: Creation) {
      prune();
      if (!(Date.parse(value.expiresAt) > now())) return;
      const id = key(owner, agent, value.correlationId);
      if (saved.has(id)) return; // A correlation id's signing material never changes.
      while (saved.size >= limit) saved.delete(saved.keys().next().value!);
      saved.set(id, structuredClone(value));
    },
    get(owner: string, agent: string, id: string): Creation | undefined {
      const value = saved.get(key(owner, agent, id));
      return value && structuredClone(value);
    },
  };
}
export type CreationReviews = ReturnType<typeof creationReviews>;
