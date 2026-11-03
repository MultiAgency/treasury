/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { appConsentSubmission } from "@multiagency/sdk";
import { z } from "zod";

export const agentName = z.string().regex(/^[a-z0-9-]{1,32}$/);
/** A NEAR account ID, by the platform's own rule (`src/contract/app-consent.ts:17`). */
export const accountId = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const challenge = z.strictObject({ message: z.string(), recipient: z.string(), nonce: z.string() });
export const signIn = z.strictObject({
  accountId,
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  signature: z.string().min(1).max(200),
  // Exactly the canonical base64 of 32 bytes: base64 decoding is lenient, and a spent nonce is matched by its text.
  nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export const session = z.strictObject({ account: z.string() });
export const agent = z.strictObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), host: z.string() });
/** The agent's identity as the owner check read it from the platform. */
export type Identity = z.infer<typeof agent>;
/** The consent text for the owner's wallet: sign `message` with NEP-413 for `recipient` (the platform's host) with `nonce`. */
export const consentText = z.strictObject({ message: z.string(), nonce: z.string(), recipient: z.string() });
/**
 * What the browser sends back after the owner signs: the text as given, its nonce, the key and the signature. The
 * SDK's own submission schema, with the nonce held to the canonical base64 of 32 bytes that this server issued.
 */
export const consentSubmission = appConsentSubmission.extend({ nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
/** The agent's live consent for this deployment, if any: what the owner granted and until when (ms since the epoch). */
export const consent = z.strictObject({ consent: z.strictObject({ id: z.string(), scopes: z.array(z.string()), expiresAt: z.number() }).nullable() });

/**
 * Every failure the server answers. None carries the platform's error text, which is logged on the server instead.
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account doesn't own this agent, or no such agent exists: the same answer for both,
 *   so a signed-in stranger can't tell which agents exist;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, `rate_limited`, a sign-in code, or a consent code: `not_created`, `already_connected`, `not_this_consent`, `agent_changed`,
 *   `consent_refused`);
 * - `unavailable` (503): the platform or the chain didn't answer, or the server is misconfigured. Trying again later
 *   may work.
 */
export type ServerFailure =
  | { ok: false; kind: "not_signed_in" }
  | { ok: false; kind: "not_owner" }
  | { ok: false; kind: "refused"; code: string }
  | { ok: false; kind: "unavailable" };
export type Answer<T> = { ok: true; value: T } | ServerFailure;
