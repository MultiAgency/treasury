import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv6 } from "node:net";
import { verifyNep413Signature } from "near-kit";
import type { KeyLookup } from "./keys.ts";
import { createRateLimit } from "./ratelimit.ts";

export type Challenge = { message: string; recipient: string; nonce: string };
export type SignedChallenge = { accountId: string; publicKey: string; signature: string; nonce: string };
export type SignInResult =
  | { ok: true; account: string }
  | { ok: false; kind: "refused"; code: "rate_limited" | "unknown_challenge" | "expired" | "bad_signature" | "not_full_access" }
  | { ok: false; kind: "unavailable" };

/**
 * Whom the rate limit counts a request against: an IPv4 address, or an IPv6 address's /64, since one host is usually
 * given a whole /64. An IPv4-mapped IPv6 address counts as its IPv4 address, and a port some proxies append
 * (`1.2.3.4:5678`, `[2001:db8::1]:443`) is dropped.
 */
export function clientKey(address: string) {
  const unported = /^\[([^\]]+)\](?::\d+)?$/.exec(address)?.[1] ?? /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address)?.[1] ?? address;
  const plain = unported.split("%")[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  if (mapped) return mapped[1]!;
  if (!isIPv6(plain)) return plain;
  const [head, tail] = plain.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":").flatMap(group => group.includes(".") ? ["0", "0"] : [group]) : []);
  const left = groups(head), right = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${all.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/**
 * Owner sign-in with a NEP-413 signature over a challenge this server issued, addressed to this server's own host.
 *
 * Challenges are stateless, so issuing one stores nothing and no flood of requests can crowd out an owner's. A nonce
 * is near-kit's layout (an 8-byte big-endian issue time, then random bytes) with the random part's second half replaced
 * by an HMAC under a key this process makes at startup: 8 bytes issue time, 8 random, 16 HMAC. Verifying checks the
 * HMAC and the expiry, then the signature with no RPC call; only then is the nonce recorded as spent, until it
 * expires, so the spent list grows only with valid signatures. Then the chain says whether the key is a full-access key
 * of the signing account. A restart voids outstanding challenges, as it does sessions.
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
  const key = randomBytes(32);
  const mac = (signed: Buffer) => createHmac("sha256", key).update(signed).digest().subarray(0, 16);
  const spent = new Map<string, number>();
  // Challenges and sign-in attempts per client, each limited to `perMinute`.
  const challenges = createRateLimit({ limit: perMinute, now }), attempts = createRateLimit({ limit: perMinute, now });
  // Spent nonces are dropped once expired, in a pass at most every 10 seconds.
  let sweptAt = -Infinity;
  const sweep = (at: number) => {
    if (at - sweptAt < 10_000) return;
    sweptAt = at;
    for (const [nonce, expiresAt] of spent) if (expiresAt <= at) spent.delete(nonce);
  };
  /** The nonce's expiry when this process issued it, else nothing. */
  const issuedHere = (nonce: Buffer) => {
    if (nonce.length !== 32) return undefined;
    const signed = nonce.subarray(0, 16);
    return timingSafeEqual(mac(signed), nonce.subarray(16)) ? Number(nonce.readBigUInt64BE(0)) + ttlMs : undefined;
  };
  return {
    /** A fresh challenge for `address`, at most `perMinute` a minute per client (`clientKey`). */
    challenge(address: string): { ok: true; value: Challenge } | { ok: false; kind: "refused"; code: "rate_limited" } {
      if (!challenges(clientKey(address))) return { ok: false, kind: "refused", code: "rate_limited" };
      const signed = Buffer.alloc(16);
      signed.writeBigUInt64BE(BigInt(now()), 0);
      randomBytes(8).copy(signed, 8);
      return { ok: true, value: { message, recipient, nonce: Buffer.concat([signed, mac(signed)]).toString("base64") } };
    },
    /**
     * Signs `address`'s client in with `signed`, at most `perMinute` attempts a minute per client, so a challenge that
     * a bad signature leaves usable can't be tried without limit.
     */
    async verify(address: string, signed: SignedChallenge): Promise<SignInResult> {
      if (!attempts(clientKey(address))) return { ok: false, kind: "refused", code: "rate_limited" };
      const nonce = Buffer.from(signed.nonce, "base64");
      // Only the canonical text: lenient decoding gives many texts for one nonce, and `spent` is keyed by the text.
      if (nonce.toString("base64") !== signed.nonce) return { ok: false, kind: "refused", code: "unknown_challenge" };
      const expiresAt = issuedHere(nonce);
      if (expiresAt === undefined || spent.has(signed.nonce)) return { ok: false, kind: "refused", code: "unknown_challenge" };
      if (expiresAt <= now()) return { ok: false, kind: "refused", code: "expired" };
      const valid = await verifyNep413Signature(
        { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature },
        { message, recipient, nonce: new Uint8Array(nonce) },
        { nonceValidation: "none" }, // The HMAC and expiry above are this nonce's checks.
      );
      if (!valid) return { ok: false, kind: "refused", code: "bad_signature" };
      // Checked again with no await between check and record, so two concurrent uses of one signature can't both pass.
      // Recorded before the chain lookup, whatever its answer, so each nonce costs at most one RPC call.
      if (spent.has(signed.nonce)) return { ok: false, kind: "refused", code: "unknown_challenge" };
      sweep(now());
      spent.set(signed.nonce, expiresAt);
      const key = await keyLookup(signed.accountId, signed.publicKey);
      // The chain didn't answer: the nonce is released so the same signature can be tried again, within the attempt limit.
      if (key === "unavailable") { spent.delete(signed.nonce); return { ok: false, kind: "unavailable" }; }
      if (key !== "full") return { ok: false, kind: "refused", code: "not_full_access" };
      return { ok: true, account: signed.accountId };
    },
  };
}
export type SignIn = ReturnType<typeof createSignIn>;
