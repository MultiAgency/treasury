// Fakes for the server's outside services: the platform and the chain. Tests run the server in-process against these.
import { generateKey } from "near-kit";
import type { Platform } from "../src/platform.ts";
import type { Challenge } from "../src/signin.ts";

export const HOST = "treasury.test";
export const ORIGIN = `https://${HOST}`;

/** A platform that knows a fixed set of agents and their owners, and records every call it's asked. */
export function fakePlatform(owners: Record<string, string>) {
  const calls: string[] = [];
  const platform: Platform = {
    async identity(agent) {
      calls.push(`identity ${agent}`);
      const owner = owners[agent];
      return owner
        ? { ok: true, value: { agent, owner, agentId: `id-${agent}`, created: true, host: "platform.test", deployment: "treasury" } }
        : { ok: false, kind: "refused", status: 404, error: "No such agent" };
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
