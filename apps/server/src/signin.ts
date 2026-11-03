import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv6 } from "node:net";
import { verifyNep413Signature } from "near-kit";
import type { KeyLookup } from "./keys.ts";

export type Challenge = { message: string; recipient: string; nonce: string };
export type SignedChallenge = { accountId: string; publicKey: string; signature: string; nonce: string };
export type SignInResult =
  | { ok: true; account: string }
  | { ok: false; kind: "refused"; code: "rate_limited" | "unknown_challenge" | "expired" | "bad_signature" | "not_full_access" }
  | { ok: false; kind: "unavailable" };

/**
 * Whom the rate limit counts a request against: an IPv4 address, or an IPv6 address's /64, since one host is usually
 * given a whole /64. An IPv4-mapped IPv6 address counts as its IPv4 address.
 */
export function clientKey(address: string) {
  const plain = address.split("%")[0]!;
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
  // Requests per client in the last minute, for challenges and for sign-in attempts, each limited to `perMinute`.
  const challenges = new Map<string, number[]>(), attempts = new Map<string, number[]>();
  // A full pass at most every 10 seconds, so a flood of requests costs linear time, not quadratic.
  let prunedAt = -Infinity;
  const prune = (at: number) => {
    if (at - prunedAt < 10_000) return;
    prunedAt = at;
    for (const [nonce, expiresAt] of spent) if (expiresAt <= at) spent.delete(nonce);
    for (const asked of [challenges, attempts]) {
      for (const [client, times] of asked) {
        const recent = times.filter(time => time > at - 60_000);
        if (recent.length) asked.set(client, recent); else asked.delete(client);
      }
    }
  };
  /** Counts a request from `address`'s client in `asked`, unless it has had `perMinute` in the last minute. */
  const allow = (asked: Map<string, number[]>, address: string) => {
    const at = now(), client = clientKey(address);
    prune(at);
    const times = (asked.get(client) ?? []).filter(time => time > at - 60_000);
    if (times.length >= perMinute) return false;
    asked.set(client, [...times, at]);
    return true;
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
      if (!allow(challenges, address)) return { ok: false, kind: "refused", code: "rate_limited" };
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
      if (!allow(attempts, address)) return { ok: false, kind: "refused", code: "rate_limited" };
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
      prune(now());
      spent.set(signed.nonce, expiresAt);
      const key = await keyLookup(signed.accountId, signed.publicKey);
      if (key === "unavailable") return { ok: false, kind: "unavailable" };
      if (key !== "full") return { ok: false, kind: "refused", code: "not_full_access" };
      return { ok: true, account: signed.accountId };
    },
  };
}
export type SignIn = ReturnType<typeof createSignIn>;
