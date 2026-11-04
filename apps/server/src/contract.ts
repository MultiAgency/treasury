/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { AppSigner, appConsentSubmission, proposalSignature, proposalView } from "@multiagency/sdk";
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
/**
 * What a DAO member may have this app do for the DAO's agent, by the DAO's roles (the SDK's `accessOf`): file proposals
 * for the DAO's vote (`canPropose`), file and vote in one transaction (`canVote`), ask for execution (`canExecute`), and
 * change the DAO's policy (`canManage`). Never sign: a member never signs as the DAO.
 */
export const member = z.strictObject({ canPropose: z.boolean(), canVote: z.boolean(), canExecute: z.boolean(), canManage: z.boolean() });
/**
 * The agent's identity. `signer` says who signs as its owner: the owner's wallet, or a DAO by its vote (then `owner` is
 * the DAO, and `member` is what the signed-in member may do; null for a wallet owner). Both default for an answer from
 * before DAO-owned agents.
 */
export const agent = z.strictObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), host: z.string(),
  signer: AppSigner.default("wallet"), member: member.nullable().default(null) });
/** The agent's identity as the owner check read it from the platform. */
export type Identity = z.infer<typeof agent>;
/** The consent text for the owner's wallet: sign `message` with NEP-413 for `recipient` (the platform's host) with `nonce`. */
export const consentText = z.strictObject({ message: z.string(), nonce: z.string(), recipient: z.string() });
/**
 * What the browser sends back after the owner signs: the text as given, its nonce, the key and the signature. The
 * SDK's own submission schema, with the nonce held to the canonical base64 of 32 bytes that this server issued.
 */
export const consentSubmission = appConsentSubmission.extend({ nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
/** One proposal, as the platform shows it. The list is the SDK's own `proposalList`. */
export const proposalRead = z.object({ proposal: proposalView });
/**
 * The owner's signed verdict on a proposal: `proposalText(proposal, verdict)` of the proposal the page shows, signed
 * by the wallet for the platform's host. The SDK's schema, with the nonce held to the canonical base64 of 32 bytes.
 */
export const verdictSubmission = proposalSignature.extend({ nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
/**
 * What an execute answers, with the proposal as last read. `final`: the proposal ended; `stopped` may still have run a
 * swap, so show its operations. `pending`: it may still run, or the answer was lost: offer no Execute, read it again
 * later; the proposal is null when even that read went unanswered. `not_executable`: refused before anything was
 * claimed, nothing sent, still approved; it may be tried again later.
 */
export const executeResult = z.discriminatedUnion("result", [
  z.object({ result: z.literal("final"), proposal: proposalView }),
  z.object({ result: z.literal("pending"), proposal: proposalView.nullable() }),
  z.object({ result: z.literal("not_executable"), proposal: proposalView }),
]);
/** What a disconnect answers: how many of the agent's live consents it revoked. */
export const revoked = z.strictObject({ revoked: z.number().int().nonnegative() });
/** The agent's live consent for this deployment, if any: what the owner granted and until when (ms since the epoch). */
const consentShown = z.strictObject({ id: z.string(), scopes: z.array(z.string()), expiresAt: z.number() });
export const consent = z.strictObject({ consent: consentShown.nullable() });

/** A transaction a DAO member's wallet signs, exactly as the platform answered it: never one this server builds. */
export const daoTransaction = z.looseObject({
  receiverId: z.string(),
  actions: z.array(z.looseObject({ type: z.literal("FunctionCall"), params: z.record(z.string(), z.unknown()) })),
});
/**
 * A DAO request waiting for its vote. `description` is what the DAO's proposal says, and `checkUrl` the platform's public
 * page (`/confirm/dao/<hash>`) showing the exact text the DAO's key signs and its hash recomputed: show the member both.
 * `transaction` is the one this member files: with `votes`, it files the proposal and votes for it in one transaction
 * (a member whose role may vote); otherwise it only files it. Null when the platform answered neither for this member.
 * It must pass before `votingUntil` (ms since the epoch).
 */
export const daoRequest = z.strictObject({
  id: z.string(), hash: z.string(), description: z.string(), votingUntil: z.number(), checkUrl: z.string(),
  transaction: daoTransaction.nullable(), votes: z.boolean(),
});
/**
 * A DAO's consent, as the server follows it. `none`: no request open; `pending`: waiting for the DAO's vote, read again
 * later (never file again for it); `signed`: the vote passed and the consent is stored; `expired`: the vote didn't pass
 * in time (file again for a new vote); `ended`: the DAO stopped its agent, which ends requests filed before (file again);
 * `gone`: the platform no longer has the request (file again).
 */
export const daoConsent = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("pending"), request: daoRequest }),
  z.strictObject({ state: z.literal("signed"), consent: consentShown }),
  z.strictObject({ state: z.enum(["expired", "ended", "gone"]) }),
]);
/** The DAO's vote on a proposal: a member asks the DAO to approve or reject it. */
export const voteSubmission = z.strictObject({ verdict: z.enum(["approve", "reject"]) });
/**
 * The DAO's vote on a proposal, as the server follows it: as `daoConsent`, with `relayed` once the vote passed and the
 * platform relayed it to the proposal, which now reads `proposalState`.
 */
export const daoVote = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.literal("pending"), verdict: z.enum(["approve", "reject"]), request: daoRequest }),
  z.strictObject({ state: z.literal("relayed"), verdict: z.enum(["approve", "reject"]), proposalState: z.string() }),
  z.strictObject({ state: z.enum(["expired", "ended", "gone"]) }),
]);

/**
 * Every failure the server answers. None carries the platform's error text, which is logged on the server instead.
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account doesn't own this agent, or no such agent exists: the same answer for both,
 *   so a signed-in stranger can't tell which agents exist;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, `rate_limited`, a sign-in code, or a consent code: `not_created`, `already_connected`, `not_this_consent`, `agent_changed`,
 *   `consent_refused`, a proposal code: `no_proposal`, `not_this_text`, `not_open`, `expired`, `not_approved`,
 *   `not_connected`, `signature_invalid`, or the platform's `invalidated`, `withdrawn`, `policy_not_in_force`; for a DAO-owned
 *   agent: `dao_owner` (a route for wallet owners: the DAO signs by vote), `not_dao`, `not_permitted` (the member's
 *   roles don't allow it), `vote_open` (a vote on the other verdict is open), `dao_refused`, `too_many_requests`);
 * - `unavailable` (503): the platform or the chain didn't answer, or the server is misconfigured. Trying again later
 *   may work.
 */
export const serverFailure = z.discriminatedUnion("kind", [
  z.strictObject({ ok: z.literal(false), kind: z.literal("not_signed_in") }),
  z.strictObject({ ok: z.literal(false), kind: z.literal("not_owner") }),
  z.strictObject({ ok: z.literal(false), kind: z.literal("refused"), code: z.string() }),
  z.strictObject({ ok: z.literal(false), kind: z.literal("unavailable") }),
]);
export type ServerFailure = z.infer<typeof serverFailure>;
export type Answer<T> = { ok: true; value: T } | ServerFailure;
