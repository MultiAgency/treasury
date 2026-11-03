// Fakes for the server's outside services: the platform and the chain. Tests run the server in-process against these.
import { parseConsentMessage } from "@multiagency/sdk";
import { generateKey } from "near-kit";
import type { ConsentRecord, IdentityAnswer, Platform } from "../src/platform.ts";
import type { Challenge } from "../src/signin.ts";

export const HOST = "treasury.test";
export const ORIGIN = `https://${HOST}`;

/**
 * A platform that knows a fixed set of agents and their owners, and records every call it's asked. `failing` makes
 * the platform answer a failure for an agent instead, `foreign` names agents another deployment's identity covers, and
 * `stale` gives an agent's previous owner, as a reused answer from before a transfer would: a read that isn't fresh
 * answers it as cached, and `recreated` gives an agent's earlier ID the same way. `unborn` names agents not created yet. Consents are kept as the platform keeps them, under the
 * Organization the signed text names; `consentAnswers` queues answers that `consents.submit` gives before storing.
 */
export function fakePlatform(owners: Record<string, string>, { failing = {}, foreign = [], stale = {}, unborn = [], recreated = {} }: {
  failing?: Record<string, IdentityAnswer>; foreign?: string[]; stale?: Record<string, string>; unborn?: string[]; recreated?: Record<string, string>;
} = {}) {
  const calls: string[] = [];
  const consents: ConsentRecord[] = [];
  const consentAnswers: Awaited<ReturnType<Platform["consents"]["submit"]>>[] = [];
  const answer = (agent: string, owner: string | undefined): IdentityAnswer => failing[agent] ?? (owner
    ? { ok: true, value: { agent, owner, agentId: unborn.includes(agent) ? null : `id-${agent}`, created: !unborn.includes(agent), host: "platform.test",
      deployment: foreign.includes(agent) ? "elsewhere" : "treasury" } }
    : { ok: false, kind: "refused", status: 404, error: "No such agent" });
  const platform: Platform = {
    async identity(agent, { fresh = false } = {}) {
      if (!fresh && stale[agent]) return { answer: answer(agent, stale[agent]), cached: true };
      if (!fresh && recreated[agent]) {
        const current = answer(agent, owners[agent]);
        return { answer: current.ok ? { ok: true, value: { ...current.value, agentId: recreated[agent] } } : current, cached: true };
      }
      calls.push(`identity ${agent}${fresh ? " (fresh)" : ""}`);
      return { answer: answer(agent, owners[agent]), cached: false };
    },
    consents: {
      async list(organization) {
        calls.push(`consents.list ${organization}`);
        return { ok: true, value: { consents: consents.filter(consent => consent.organization === organization) } };
      },
      async submit(submission) {
        calls.push(`consents.submit ${submission.nonce}`);
        const queued = consentAnswers.shift();
        if (queued) return queued;
        const text = parseConsentMessage(submission.message)!;
        const { type: _type, version: _version, expiresAt, ...rest } = text;
        const consent = { ...rest, id: `c${consents.length + 1}`.padEnd(64, "0"), expiresAt: Date.parse(expiresAt), createdAt: 0,
          publicKey: submission.publicKey, revoked: false, revokedAt: null };
        consents.push(consent);
        return { ok: true, value: { consent } };
      },
      async revoke(id) {
        calls.push(`consents.revoke ${id}`);
        const consent = consents.find(consent => consent.id === id);
        if (!consent) return { ok: false, kind: "refused", status: 404, error: "No such consent" };
        Object.assign(consent, { revoked: true, revokedAt: 1 });
        return { ok: true, value: { revoked: true } };
      },
    },
  };
  return { platform, calls, consents, consentAnswers };
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
