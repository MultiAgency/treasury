/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { z } from "zod";

export const agentName = z.string().regex(/^[a-z0-9-]{1,32}$/);

export const challenge = z.strictObject({ message: z.string(), recipient: z.string(), nonce: z.string() });
export const signIn = z.strictObject({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/),
  signature: z.string().min(1).max(200),
  nonce: z.string().min(1).max(64),
});
export const session = z.strictObject({ account: z.string() });
export const agent = z.strictObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), host: z.string() });

/**
 * The server's own failures, beside the platform's (`session`, `forbidden`, `refused`, `unavailable`):
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account isn't this agent's owner;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, or a sign-in code).
 */
export type ServerFailure =
  | { ok: false; kind: "not_signed_in" }
  | { ok: false; kind: "not_owner" }
  | { ok: false; kind: "refused"; code: string; error?: string }
  | { ok: false; kind: "session" | "forbidden" | "unavailable"; error?: string };
export type Answer<T> = { ok: true; value: T } | ServerFailure;
