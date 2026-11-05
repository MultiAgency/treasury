/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { appConsentSubmission, ownerOutputs, proposalSignature, proposalView, RecordingSchema } from "@multiagency/sdk";
import { ActivitySnapshotEventSchema, RunErrorEventSchema, RunFinishedEventSchema, RunStartedEventSchema } from "@ag-ui/core/schemas";
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
 * What the signed-in account may do with the agent, as the platform's `accessOf` reads it: a wallet owner may do
 * everything and signs for itself; a DAO's member never signs, and the rest comes from its roles in the DAO's policy.
 */
export const access = z.strictObject({ canSign: z.boolean(), canPropose: z.boolean(), canVote: z.boolean(), canExecute: z.boolean(), canManage: z.boolean() });
export type Access = z.infer<typeof access>;
/** The agent's identity as the platform answers it: what a consent names. */
export const identity = z.strictObject({ agent: z.string(), owner: z.string(), agentId: z.string().nullable(), host: z.string() });
export type Identity = z.infer<typeof identity>;
/**
 * The agent as the owner check admitted the signed-in account to it: its identity, who signs as its owner (`wallet`,
 * or `dao`: every signature is the DAO's vote), the account admitted (the owner, or one of the DAO's members) and its
 * access. Presenting `access` never authorizes: each route checks it again.
 */
export const agent = identity.extend({ signer: z.enum(["wallet", "dao"]), account: z.string(), access });
export type Admitted = z.infer<typeof agent>;
/** The consent text for the owner's wallet: sign `message` with NEP-413 for `recipient` (the platform's host) with `nonce`. */
export const consentText = z.strictObject({ message: z.string(), nonce: z.string(), recipient: z.string() });
/**
 * What the browser sends back after the owner signs: the text as given, its nonce, the key and the signature. The
 * SDK's own submission schema, with the nonce held to the canonical base64 of 32 bytes that this server issued.
 */
export const consentSubmission = appConsentSubmission.extend({ nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
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
/**
 * A transaction a DAO member's wallet signs and sends as is, built by the platform, never by this server or the page:
 * `add_proposal`, and with a vote `act_proposal`.
 */
export const memberTransaction = z.strictObject({
  receiverId: z.string(),
  actions: z.array(z.strictObject({ type: z.literal("FunctionCall"),
    params: z.looseObject({ methodName: z.string(), args: z.looseObject({}), gas: z.string(), deposit: z.string() }) })).min(1),
});
export type MemberTransaction = z.infer<typeof memberTransaction>;
/** What the platform answers for a member to file: the proposal, and the same with a vote on it (null when it couldn't). */
export const daoTransactions = z.strictObject({ proposal: memberTransaction, proposalAndVote: memberTransaction.nullable() });
export type DaoTransactions = z.infer<typeof daoTransactions>;
/**
 * What a member is offered for a DAO request waiting for its vote (`dao-offer.ts`): `filed`, vote on proposal
 * `proposal` in Trezu (`vote`); `approved`, wait for the server to complete it; `failed`, finalize it again in Trezu;
 * `file`, the transaction to file, or null for a member who may not file. A request whose proposal ended isn't shown.
 */
export const daoOffer = z.discriminatedUnion("state", [
  z.strictObject({ state: z.enum(["filed", "approved", "failed"]), proposal: z.number(), vote: z.string() }),
  z.strictObject({ state: z.literal("file"), transaction: memberTransaction.nullable() }),
]);
/**
 * A DAO request waiting for its vote: what the DAO's proposal says, the platform's check page for the exact text and
 * hash the DAO signs, the time its vote must pass by (ms), and the member's offer; null when the DAO couldn't be read.
 */
export const daoRequest = z.strictObject({ id: z.string(), description: z.string(), votingUntil: z.number(), check: z.string(),
  verdict: z.enum(["approve", "reject"]).optional(), offer: daoOffer.nullable() });
/**
 * What filing a DAO request answers (its consent, or its vote on a proposal): the request, filed now or already open
 * for the same subject. An open vote may carry the other verdict: a member who disagrees votes against it in Trezu.
 */
export const daoFiled = z.strictObject({ request: daoRequest });
/**
 * One proposal, as the platform shows it, and for a DAO-owned agent the DAO's vote on it while one waits (`vote`).
 * The list is the SDK's own `proposalList`.
 */
export const proposalRead = z.object({ proposal: proposalView, vote: daoRequest.nullable().optional() });
/**
 * The agent's live consent for this deployment, if any: what the owner granted and until when (ms since the epoch).
 * For a DAO-owned agent, also its consent request waiting for the vote (`request`), and, when one just ended without
 * a consent, why (`ended`: its vote didn't pass in time, a DAO stop ended it, or the DAO voted it down).
 */
export const consent = z.strictObject({
  consent: z.strictObject({ id: z.string(), scopes: z.array(z.string()), expiresAt: z.number() }).nullable(),
  request: daoRequest.nullable().optional(),
  ended: z.enum(["expired", "stopped", "rejected", "changed"]).optional(),
});

/** The signed-in account, and its own Treasury agents: set up or created under its Organization (`agentsOf`). */
export const setups = z.strictObject({ account: z.string(), agents: z.array(agentName) });
/**
 * A DAO's Treasury setup, for a member: the member's access by the DAO's roles, the agents its consents name (set up
 * or created), its setup request while one waits for the vote, and, when one just ended without an agent, why (`ended`).
 */
export const daoSetup = z.strictObject({
  account: z.string(),
  access,
  agents: z.array(agentName),
  request: daoRequest.nullable(),
  ended: z.enum(["expired", "rejected", "refused"]).optional(),
});
/** A setup the platform stored: the Organization's Treasury agent, reserved and waiting for its creation. */
export const setupDone = z.strictObject({ agent: agentName });
/**
 * An agent's creation, prepared under its setup consent and followed by `correlationId` until `expiresAt`: a wallet
 * owner signs it on the platform's confirm page (`confirm.url`); for a DAO, a member files `dao.transaction`, the
 * proposal (with a vote on it, for a member whose role votes), and the DAO's vote must pass before it expires.
 */
export const creation = z.strictObject({
  correlationId: z.string(), expiresAt: z.string(),
  confirm: z.strictObject({ url: z.string(), expiresAt: z.string() }).optional(),
  dao: z.strictObject({ transaction: memberTransaction }).optional(),
});
/** Where a creation stands, as the platform's `owner/status` answers it. */
export const creationStatus = z.strictObject({
  stage: z.enum(["submitted", "submitting", "expired", "failed", "voting", "unknown"]),
  failureCode: z.string().nullable().optional(),
});

/**
 * The owner reads (#61), as the page parses them: the SDK's own output schemas, except that an amount the SDK reads as
 * `bigint` crosses the wire as its exact decimal string (`send` writes every `bigint` so). A float or `Number()` would
 * lose a wNEAR balance past 2^53 raw units, about 0.000000009 wNEAR. A request's fields (`record`) may hold such
 * strings too.
 */
const rawAmount = z.string().regex(/^-?\d+$/);
const overviewShape = ownerOutputs.overview.shape;
export const overviewRead = ownerOutputs.overview.extend({
  book: z.array(overviewShape.book.element.extend({ public: rawAmount, confidential: rawAmount })),
  unmanaged: z.array(overviewShape.unmanaged.element.extend({ amount: rawAmount })),
});
export const activityRead = ownerOutputs.activity;
/** The agent's account: its wallet (the NEAR account that holds its balances), and the grants its executor holds. */
export const accountRead = ownerOutputs.account;
export const heldRead = ownerOutputs.held;
export const unresolvedRead = ownerOutputs.unresolved;
/** The autopilot's recorded runs, and one run's recording (the platform's strict recording format). */
export const runsRead = ownerOutputs["autopilot/evidence"];
export const recordingRead = RecordingSchema;
/** The account linked to fund the agent (`treasury/get`), or null: its balances are decimal strings already. */
export const treasuryRead = z.strictObject({ treasury: ownerOutputs["treasury/get"] });
/** A deposit address is asked for by asset: USDC, or NEAR, which funds the agent as wNEAR. */
export const depositRequest = z.strictObject({ asset: z.enum(["USDC", "NEAR"]) });
/** A one-time deposit address (`deposit`): pay it once, before it expires, with its memo if it names one. */
export const depositRead = z.strictObject({ deposit: ownerOutputs.deposit });
/** A wallet owner's changes to the agent's funding account. Each answers nothing; the page reads the account again. */
export const linkRequest = z.strictObject({ accountId });
export const unlinkRequest = z.strictObject({});
export const confidentialRequest = z.strictObject({ confidential: z.boolean() });
export const fundingChanged = z.strictObject({});
/** Per asset, the provider's balances against the chain and against recorded executions (raw units as decimal strings). */
export const booksRead = ownerOutputs.reconcileBooks;
/** A sweep is a preview of the public balances (`execute: false`) or their shielding (`execute: true`). */
export const sweepRequest = z.strictObject({ execute: z.boolean() });
/** What a sweep's activity shows: the public balances it found (raw units as decimal strings), and each shield it sent. */
export const sweepActivity = z.strictObject({
  exposed: z.array(z.strictObject({ asset: z.string(), symbol: z.string(), decimals: z.number(), public: rawAmount })),
  shields: z.array(z.strictObject({ asset: z.string(), status: z.string(), correlationId: z.string(), failureCode: z.string().nullable() })),
});
/** The activity type a sweep's snapshots carry. */
export const SWEEP_ACTIVITY = "treasury.sweep";
/**
 * A sweep as it ran, as AG-UI 1.0 events in arrival order, delivered whole: `RUN_STARTED`, an `ACTIVITY_SNAPSHOT` of
 * `treasury.sweep` (`sweepActivity`) after each event the platform's stream gave, then `RUN_FINISHED` when it ended
 * normally, or `RUN_ERROR` (`code`: the failure's kind) when it failed. A run with no terminal event is truncated: the
 * platform's stream was lost after it began, so a shield may have gone out, and nothing is sent again.
 */
export const sweepRun = z.strictObject({
  events: z.array(z.discriminatedUnion("type", [RunStartedEventSchema, ActivitySnapshotEventSchema, RunFinishedEventSchema, RunErrorEventSchema])),
});
/** A rebalance the owner asks for, under a `requestId` the page names (the platform's own format): answered as the proposal. */
export const rebalanceRequest = z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const rebalanceMade = z.strictObject({ proposal: proposalView });
/** What a consent text is asked for with: `owner` too, at a wallet owner's explicit choice. */
export const consentRequest = z.strictObject({ owner: z.literal(true).optional() });
/** The saved strategy, its digest, whether the held grant binds it, and whether the schedule may be turned on (and why not). */
export const strategyRead = ownerOutputs["strategy/get"];
/** The schedule: on or off, every how many minutes, its ceiling a run, and its last and next runs. */
export const autopilotRead = ownerOutputs["autopilot/get"];
/** The schedule is turned on for the strategy the owner saw, by its digest: refused if it has changed since. */
export const enableRequest = z.strictObject({ expectedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) });
/** What a run now reported, in the agent's words: what it executed or why it didn't. */
export const tickRead = z.strictObject({ summary: z.string() });
export const autopilotChanged = z.strictObject({});
/** A proposal found by the `requestId` it was proposed with. */
export const requestRead = z.strictObject({ proposal: proposalView });
/**
 * An operation by its `correlationId`, from its `activity` row: `status` is null until an outcome is recorded, and
 * `refused` names a refusal. Never `owner/status`, which answers `unknown` for any swap.
 */
export const operationRead = z.strictObject({ correlationId: z.string(), at: z.string(), kind: z.string(), status: z.string().nullable(), refused: z.string().nullable() });

/**
 * Every failure the server answers. None carries the platform's error text, which is logged on the server instead.
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account doesn't own this agent, or no such agent exists: the same answer for both,
 *   so a signed-in stranger can't tell which agents exist;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, `rate_limited`, `not_permitted` (a DAO member whose roles don't allow this), a sign-in code, or a consent code: `not_created`, `already_connected`, `not_this_consent`, `agent_changed`,
 *   `consent_refused`, a setup code: `not_this_setup`, `already_set_up`, `setup_unavailable`, `setup_refused`,
 *   `not_set_up`, `already_created`, `no_creation`, `not_a_dao`, a proposal code: `no_proposal`, `not_this_text`, `not_open`, `expired`, `not_approved`,
 *   `not_connected`, `signature_invalid`, or the platform's `invalidated`, `withdrawn`, `policy_not_in_force`, a new proposal's `nothing_to_propose`, `too_many_proposals`, `not_proposable`, `request_conflict`, a read's `not_found`, a funding code: `dao_funding_fixed`, `funding_refused`, or an autopilot code: `autopilot_refused`, `autopilot_not_stopped`);
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
