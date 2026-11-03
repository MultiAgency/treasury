import { appClient, type AppBase } from "@multiagency/sdk";
import type { Credential } from "./credential.ts";

export type IdentityAnswer = Awaited<ReturnType<ReturnType<typeof appClient>["identity"]>>;
/** An identity answer, and whether it was reused rather than read from the platform for this request. */
export type IdentityRead = { answer: IdentityAnswer; cached: boolean };

/** What the server asks the platform. Every call goes through here; tests replace it with a fake. */
export type Platform = {
  /**
   * The agent's owner and identity, as a consent must name them. Needs only the credential, no consent. A successful
   * answer is reused for up to a minute unless `fresh` is asked for. A failure is never reused, a 404 included: an agent
   * set up a moment later must be reachable at once, and the per-account request limit bounds repeated lookups.
   */
  identity(agent: string, options?: { fresh?: boolean }): Promise<IdentityRead>;
};


/**
 * The platform through `appClient`, under the deployment's credential as it stands now: the credential module checks
 * its file on every call and reads it again when it has changed. Each call has a timeout: a fetch that's aborted is a
 * lost answer, which the SDK reports by kind (`unavailable` for a read). Only the SDK's own headers are sent:
 * `/apps/v1` refuses any request carrying an `Origin` or `Cookie` header, so nothing from a browser request is forwarded.
 *
 * A successful identity is reused for `cacheMs` (a minute), per agent, and reads that miss together share one
 * call. Only the newest read started for an agent may change what's kept, so an older read that answers late can't
 * overwrite a newer one. The platform allows each credential 1,200 calls
 * an hour (`hourlyLimit(1_200)` in its `app-routes.ts`), about 20 a minute for the whole deployment, owners' pages,
 * `watch` and proposals together, so reading it on every request would spend that on ownership checks alone.
 */
export function createPlatform({ origin, credential, timeoutMs, cacheMs = 60_000, now = Date.now, fetch: send = fetch }: {
  origin: string; credential: Credential; timeoutMs: number; cacheMs?: number; now?: () => number; fetch?: typeof fetch;
}): Platform {
  const timed: typeof fetch = (input, init) =>
    send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  let current: { secret: Awaited<ReturnType<Credential["get"]>>; client: ReturnType<typeof appClient> } | undefined;
  const client = async () => {
    const secret = await credential.get();
    if (current?.secret !== secret) current = { secret, client: appClient({ base: origin as AppBase, credential: secret.reveal(), fetch: timed }) };
    return current.client;
  };
  const kept = new Map<string, { answer: IdentityAnswer; until: number }>();
  const reading = new Map<string, Promise<IdentityAnswer>>();
  const newest = new Map<string, number>();
  let started = 0;
  const read = (agent: string) => {
    const generation = ++started;
    newest.set(agent, generation);
    const pending = (async () => {
      const answer = await (await client()).identity(agent);
      if (newest.get(agent) === generation) {
        if (answer.ok) kept.set(agent, { answer, until: now() + cacheMs });
        else kept.delete(agent);
      }
      return answer;
    })().finally(() => { if (reading.get(agent) === pending) reading.delete(agent); });
    reading.set(agent, pending);
    return pending;
  };
  return {
    async identity(agent, { fresh = false } = {}) {
      if (!fresh) {
        const reuse = kept.get(agent);
        if (reuse && reuse.until > now()) return { answer: reuse.answer, cached: true };
      }
      return { answer: await ((!fresh && reading.get(agent)) || read(agent)), cached: false };
    },
  };
}
