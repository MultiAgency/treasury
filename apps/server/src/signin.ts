import { generateNonce, verifyNep413Signature } from "near-kit";
import type { KeyLookup } from "./keys.ts";

export type Challenge = { message: string; recipient: string; nonce: string };
export type SignedChallenge = { accountId: string; publicKey: string; signature: string; nonce: string };
export type SignInResult =
  | { ok: true; account: string }
  | { ok: false; kind: "refused"; code: "rate_limited" | "unknown_challenge" | "expired" | "bad_signature" | "not_full_access" }
  | { ok: false; kind: "unavailable" };

/**
 * Owner sign-in with a NEP-413 signature over a challenge this server issued, addressed to this server's own host.
 * The signature is checked first, with no RPC call; only then does the chain say whether the key is a full-access key
 * of the signing account. Each challenge is single-use: it's spent by the first attempt, whatever that attempt's outcome.
 */
export function createSignIn({ recipient, keyLookup, ttlMs, perMinute, now = Date.now }: {
  /** This server's host: the NEP-413 recipient, never the platform's. */
  recipient: string;
  keyLookup: KeyLookup;
  ttlMs: number;
  perMinute: number;
  now?: () => number;
}) {
  const message = `Sign in to the Treasury app at ${recipient}`;
  const issued = new Map<string, number>();
  const asked = new Map<string, number[]>();
  const prune = (at: number) => {
    for (const [nonce, expiresAt] of issued) if (expiresAt <= at) issued.delete(nonce);
    for (const [client, times] of asked) {
      const recent = times.filter(time => time > at - 60_000);
      if (recent.length) asked.set(client, recent); else asked.delete(client);
    }
  };
  return {
    /** A fresh challenge for `client` (its address), at most `perMinute` a minute. */
    challenge(client: string): { ok: true; value: Challenge } | { ok: false; kind: "refused"; code: "rate_limited" } {
      const at = now();
      prune(at);
      const times = asked.get(client) ?? [];
      if (times.length >= perMinute) return { ok: false, kind: "refused", code: "rate_limited" };
      asked.set(client, [...times, at]);
      const nonce = Buffer.from(generateNonce()).toString("base64");
      issued.set(nonce, at + ttlMs);
      return { ok: true, value: { message, recipient, nonce } };
    },
    async verify(signed: SignedChallenge): Promise<SignInResult> {
      const at = now();
      const expiresAt = issued.get(signed.nonce);
      issued.delete(signed.nonce);
      if (expiresAt === undefined) return { ok: false, kind: "refused", code: "unknown_challenge" };
      if (expiresAt <= at) return { ok: false, kind: "refused", code: "expired" };
      const valid = await verifyNep413Signature(
        { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature },
        { message, recipient, nonce: new Uint8Array(Buffer.from(signed.nonce, "base64")) },
        { maxAge: ttlMs },
      );
      if (!valid) return { ok: false, kind: "refused", code: "bad_signature" };
      const key = await keyLookup(signed.accountId, signed.publicKey);
      if (key === "unavailable") return { ok: false, kind: "unavailable" };
      if (key !== "full") return { ok: false, kind: "refused", code: "not_full_access" };
      return { ok: true, account: signed.accountId };
    },
  };
}
export type SignIn = ReturnType<typeof createSignIn>;
