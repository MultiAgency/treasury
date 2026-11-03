// Fakes for the server's outside services: the platform and the chain. Tests run the server in-process against these.
import { generateKey } from "near-kit";
import type { IdentityAnswer, Platform } from "../src/platform.ts";
import type { Challenge } from "../src/signin.ts";

export const HOST = "treasury.test";
export const ORIGIN = `https://${HOST}`;

/**
 * A platform that knows a fixed set of agents and their owners, and records every call it's asked. `failing` makes
 * the platform answer a failure for an agent instead, `foreign` names agents another deployment's identity covers, and
 * `stale` gives an agent's previous owner, as a reused answer from before a transfer would: a read that isn't fresh
 * answers it as cached.
 */
export function fakePlatform(owners: Record<string, string>, { failing = {}, foreign = [], stale = {} }: {
  failing?: Record<string, IdentityAnswer>; foreign?: string[]; stale?: Record<string, string>;
} = {}) {
  const calls: string[] = [];
  const answer = (agent: string, owner: string | undefined): IdentityAnswer => failing[agent] ?? (owner
    ? { ok: true, value: { agent, owner, agentId: `id-${agent}`, created: true, host: "platform.test", deployment: foreign.includes(agent) ? "elsewhere" : "treasury" } }
    : { ok: false, kind: "refused", status: 404, error: "No such agent" });
  const platform: Platform = {
    async identity(agent, { fresh = false } = {}) {
      if (!fresh && stale[agent]) return { answer: answer(agent, stale[agent]), cached: true };
      calls.push(`identity ${agent}${fresh ? " (fresh)" : ""}`);
      return { answer: answer(agent, owners[agent]), cached: false };
    },
  };
  return { platform, calls };
}

/** A wallet for `accountId` with a fresh key, which signs a challenge as a wallet would (NEP-413). */
export function wallet(accountId: string) {
  const key = generateKey();
  return {
    accountId,
    publicKey: key.publicKey.toString(),
    sign(challenge: Challenge, overrides: Partial<{ message: string; recipient: string }> = {}) {
      const signed = key.signNep413Message!(accountId, {
        message: overrides.message ?? challenge.message,
        recipient: overrides.recipient ?? challenge.recipient,
        nonce: new Uint8Array(Buffer.from(challenge.nonce, "base64")),
      });
      return { accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce };
    },
  };
}
