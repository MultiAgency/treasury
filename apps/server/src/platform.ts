import { appClient, type AppBase } from "@multiagency/sdk";
import type { Credential } from "./credential.ts";

/** What the server asks the platform. Every call goes through here; tests replace it with a fake. */
export type Platform = {
  /** The agent's owner and identity, as a consent must name them. Needs only the credential, no consent. */
  identity(agent: string): ReturnType<ReturnType<typeof appClient>["identity"]>;
};

/**
 * The platform through `appClient`, under the deployment's credential as it stands now: the credential module checks
 * its file on every call and reads it again when it has changed. Each call has a timeout: a fetch that's aborted is a
 * lost answer, which the SDK reports by kind (`unavailable` for a read). Only the SDK's own headers are sent:
 * `/apps/v1` refuses any request carrying an `Origin` or `Cookie` header, so nothing from a browser request is forwarded.
 */
export function createPlatform({ origin, credential, timeoutMs, fetch: send = fetch }: {
  origin: string; credential: Credential; timeoutMs: number; fetch?: typeof fetch;
}): Platform {
  const timed: typeof fetch = (input, init) =>
    send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  let current: { secret: Awaited<ReturnType<Credential["get"]>>; client: ReturnType<typeof appClient> } | undefined;
  const client = async () => {
    const secret = await credential.get();
    if (current?.secret !== secret) current = { secret, client: appClient({ base: origin as AppBase, credential: secret.reveal(), fetch: timed }) };
    return current.client;
  };
  return {
    identity: async agent => (await client()).identity(agent),
  };
}
