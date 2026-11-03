/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { z } from "zod";

export const agentName = z.string().regex(/^[a-z0-9-]{1,32}$/);
/** A NEAR account ID, by the platform's own rule (`src/contract/app-consent.ts:17`). */
export const accountId = z.string().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const challenge = z.strictObject({ message: z.string(), recipient: z.string(), nonce: z.string() });
export const signIn = z.strictObject({
  accountId,
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  signature: z.string().min(1).max(200),
  nonce: z.string().min(1).max(64),
});
export const session = z.strictObject({ account: z.string() });
export const agent = z.strictObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), host: z.string() });

/**
 * Every failure the server answers. None carries the platform's error text, which is logged on the server instead.
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account doesn't own this agent, or no such agent exists: the same answer for both,
 *   so a signed-in stranger can't tell which agents exist;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, or a sign-in code);
 * - `unavailable` (503): the platform or the chain didn't answer, or the server is misconfigured. Trying again later
 *   may work.
 */
export type ServerFailure =
  | { ok: false; kind: "not_signed_in" }
  | { ok: false; kind: "not_owner" }
  | { ok: false; kind: "refused"; code: string }
  | { ok: false; kind: "unavailable" };
export type Answer<T> = { ok: true; value: T } | ServerFailure;
