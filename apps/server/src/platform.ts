import { appClient, type AppBase } from "@multiagency/sdk";
import type { Credential } from "./credential.ts";

type IdentityAnswer = Awaited<ReturnType<ReturnType<typeof appClient>["identity"]>>;

/** What the server asks the platform. Every call goes through here; tests replace it with a fake. */
export type Platform = {
  /**
   * The agent's owner and identity, as a consent must name them. Needs only the credential, no consent. A successful
   * answer is reused for up to a minute unless `fresh` is asked for; a failure is never reused.
   */
  identity(agent: string, options?: { fresh?: boolean }): Promise<IdentityAnswer>;
  /** Drops the agent's reused identity, so the next read asks the platform: for when a later call on it is refused. */
  forget(agent: string): void;
};

/**
 * The platform through `appClient`, under the deployment's credential as it stands now: the credential module checks
 * its file on every call and reads it again when it has changed. Each call has a timeout: a fetch that's aborted is a
 * lost answer, which the SDK reports by kind (`unavailable` for a read). Only the SDK's own headers are sent:
 * `/apps/v1` refuses any request carrying an `Origin` or `Cookie` header, so nothing from a browser request is forwarded.
 *
 * A successful identity is reused for `cacheMs` (a minute), per agent. The platform allows each credential 1,200 calls
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
  const identities = new Map<string, { answer: IdentityAnswer & { ok: true }; until: number }>();
  // Reads in flight, so requests that miss together share one platform call.
  const reading = new Map<string, Promise<IdentityAnswer>>();
  const read = (agent: string) => {
    const pending = (async () => {
      const answer = await (await client()).identity(agent);
      if (answer.ok) identities.set(agent, { answer, until: now() + cacheMs });
      else identities.delete(agent);
      return answer;
    })().finally(() => { if (reading.get(agent) === pending) reading.delete(agent); });
    reading.set(agent, pending);
    return pending;
  };
  return {
    async identity(agent, { fresh = false } = {}) {
      if (fresh) return read(agent);
      const kept = identities.get(agent);
      if (kept && kept.until > now()) return kept.answer;
      return reading.get(agent) ?? read(agent);
    },
    forget: agent => { identities.delete(agent); reading.delete(agent); },
  };
}
