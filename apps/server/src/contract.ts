/**
 * The server's API as schemas: what each route takes and answers. The proposals page imports this module too, so the
 * two can't drift apart. Every answer is `{ ok: true, value }` or a failure decided by `kind`, never by message text.
 */
import { appConsentSubmission, ASSETS, ownerAction, ownerOutputs, proposalId, proposalSignature, proposalView, RecordingSchema } from "@multiagency/sdk";
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
 * The agent's open DAO requests (#130): its consent, and its verdicts on proposals, each as `daoRequest` shows it and
 * which it is (a vote names its proposal). Soonest deadline first. A wallet owner's agent has none.
 */
export const daoAgentRequest = daoRequest.extend({ kind: z.enum(["consent", "vote"]), proposal: proposalId.optional() });
export const daoAgentRequests = z.strictObject({ requests: z.array(daoAgentRequest) });
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

/** The signed-in account, and its own Treasury agents under its Organization: created, or set up within its time (`agentsOf`). */
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
/** The exact readable owner intent; opaque provider text is shown whole, never reconstructed by the app. */
const nep413Intent = z.looseObject({ standard: z.literal("nep413"), payload: z.looseObject({ message: z.string(), recipient: z.string(), nonce: z.string() }) });
/**
 * An agent's creation, prepared under its setup consent and followed by `correlationId` until `expiresAt`: a wallet
 * owner reviews a readable intent here or signs on the platform's confirm page (`confirm.url`); for a DAO, a member files `dao.transaction`, the
 * proposal (with a vote on it, for a member whose role votes), and the DAO's vote must pass before it expires.
 */
export const creation = z.strictObject({
  correlationId: z.string(), expiresAt: z.string(),
  intent: nep413Intent.extend({ payload: nep413Intent.shape.payload.extend({ message: z.string().min(1), recipient: z.string().min(1), nonce: signIn.shape.nonce }) }).optional(),
  /** Binding reviewed with the immutable intent, checked again against fresh identity and setup consent before signing. */
  review: z.strictObject({ agent: agentName, owner: accountId, host: z.string().min(1), publicKey: signIn.shape.publicKey }).optional(),
  confirm: z.strictObject({ url: z.string(), expiresAt: z.string() }).optional(),
  dao: z.strictObject({ transaction: memberTransaction }).optional(),
}).refine(value => [value.intent, value.confirm, value.dao].filter(Boolean).length === 1 && Boolean(value.intent) === Boolean(value.review), "One supported signing form is required");
/** Where a creation stands, retaining the platform's optional phase and provider outcome alongside legacy stage. */
const ownerStatusShape = ownerOutputs["owner/status"].shape;
export const creationStatus = z.strictObject({
  stage: ownerStatusShape.stage,
  failureCode: ownerStatusShape.failureCode,
  phase: ownerStatusShape.phase,
  status: ownerStatusShape.status,
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
/** The policy's revisions and the mandate digest (`policyHistory`, #134). */
export const policyHistoryRead = ownerOutputs.policyHistory;
/**
 * A policy edit (`policy_update`): the revision and digest the owner reviewed, and the fields to change, as the SDK takes
 * them. The page sends the whole editable part; the platform refuses an edit that changes nothing.
 */
type PolicyOption = Extract<(typeof ownerAction.options)[number], { shape: { type: z.ZodLiteral<"policy_update"> } }>;
const policyUpdate = ownerAction.options.find((option): option is PolicyOption => option.shape.type.value === "policy_update")!;
export const policyUpdateRequest = z.strictObject({ expectedPolicy: policyUpdate.shape.expectedPolicy, changes: policyUpdate.shape.changes });
/** The agent's account: its wallet (the NEAR account that holds its balances), and the grants its executor holds. */
export const accountRead = ownerOutputs.account;
export const heldRead = ownerOutputs.held;
/** The owner's actions for the agent and where each stands (#136): a grant, a freeze, … as the platform records them. */
export const ownerActionsRead = ownerOutputs["owner/actions"];
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
export const fundingChanged = z.strictObject({});
/** Per asset, the provider's balances against the chain and against recorded executions (raw units as decimal strings). */
export const booksRead = ownerOutputs.reconcileBooks;
/**
 * The agent's diversified book (#221), from one `overview` read: each holding's class, chain, route and venues, what the
 * platform can propose, every venue's exposure and cap with where the cap came from (`mandate`, the profile's
 * `profile-default`, or `absent`), the stablecoin split with each coin's peg level, and each phase with the reasons it
 * can't run. An app-side cap only holds back: nothing here claims the platform enforces these numbers.
 */
const assetClass = z.enum(["volatile", "stable", "rwa"]);
const intentsRoute = z.enum(["native", "omft", "bridged"]);
const capSource = z.enum(["mandate", "profile-default", "absent"]);
export const diversificationRead = z.strictObject({
  source: z.enum(["mandate", "profile-defaults", "absent"]),
  profile: z.enum(["conservative", "balanced", "growth"]).nullable(),
  holdings: z.array(z.strictObject({
    asset: z.string(), symbol: z.string(),
    class: assetClass.nullable(), chain: z.string().nullable(), route: intentsRoute.nullable(),
    venues: z.array(z.string()), usd: z.number().nullable(), proposable: z.boolean(),
  })),
  venues: z.array(z.strictObject({
    id: z.string(), label: z.string(), kind: z.enum(["account", "bridge"]),
    exposureUsd: z.number().nullable(), capPct: z.number().nullable(), capSource,
  })),
  stablecoins: z.array(z.strictObject({
    symbol: z.string(), usd: z.number(), price: z.number().nullable(), sharePct: z.number().nullable(),
    targetPct: z.number().nullable(), peg: z.union([z.literal(0), z.literal(2), z.literal(3)]),
  })),
  phases: z.array(z.strictObject({
    phase: z.union([z.literal(1), z.literal(2), z.literal(3)]), title: z.string(), on: z.boolean(), reasons: z.array(z.string()),
  })),
  notes: z.array(z.string()),
});
export type DiversificationRead = z.output<typeof diversificationRead>;
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
/**
 * A token the app server issues to an owner's agent (#139): how long it lasts (1 to 30 days) and a name to tell it by. The
 * secret is answered once, with the view; later reads show only the view.
 */
export const tokenRequest = z.strictObject({ days: z.number().int().min(1).max(30), label: z.string().trim().max(40).optional() });
export const tokenView = z.strictObject({ id: z.string(), label: z.string(), createdAt: z.string(), expiresAt: z.string(), lastUsedAt: z.string().nullable() });
export const tokenIssued = z.strictObject({ token: z.string(), view: tokenView });
export const tokensRead = z.array(tokenView);
/**
 * What a consent text is asked for with. A wallet owner's text carries `owner` whatever the body says (#135); `{ owner: true }`
 * is what an older page sent at connect, and still how a connection without `owner` is asked to add it.
 */
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
const managedAsset = z.enum(Object.values(ASSETS) as [string, ...string[]]);
/**
 * A strategy as the platform takes one (its `Strategy`): every managed asset's target in basis points, adding up to
 * 10 000; the smallest swap worth making and the most a swap may cost; autopilot's interval and ceiling a run; and the
 * cash its swaps may not take it under (platform#23). The platform saves the strategy whole, so a save without the
 * floor removes it: the page sends the saved one's floor with every save it makes over it.
 */
export const strategyInput = z.strictObject({
  targetBps: z.record(managedAsset, z.number().int().min(0).max(10_000))
    .refine(targets => Object.values(targets).reduce((sum, bps) => sum + bps, 0) === 10_000, "targets must add up to 10 000 bps"),
  minLegUsd: z.number().int().min(1),
  maxCostBps: z.number().int().min(1).max(1_000),
  autopilot: z.strictObject({ everyMin: z.number().int().min(5).max(1_440), maxUsd: z.number().int().min(0).max(1_000_000) }),
  cashFloor: z.strictObject({
    usd: z.number().int().min(1),
    assets: z.array(managedAsset).min(1).refine(list => new Set(list).size === list.length, "cash floor assets must not repeat"),
  }).optional(),
});
/** A strategy saved over the one the owner saw, by its digest: refused if it has changed since. */
export const strategySaveRequest = z.strictObject({ strategy: strategyInput, expectedDigest: enableRequest.shape.expectedDigest });
/** The saved strategy's digest, which a grant then binds. */
export const strategySaved = z.strictObject({ digest: z.string() });
/** The longest reasons a strategy proposal may give. */
export const MAX_PROPOSAL_REASONS = 2_000;
/**
 * A strategy an agent proposed and the owner hasn't answered (#206): who proposed it (Ballast's `mandate` compiler, or
 * `token:<id>`), why, and the digest of the saved strategy it was compared against, which adopting it saves over.
 */
export const strategyProposal = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  source: z.string().regex(/^(mandate|token:[a-f0-9]{16})$/),
  strategy: strategyInput,
  reasons: z.string().min(1).max(MAX_PROPOSAL_REASONS),
  against: enableRequest.shape.expectedDigest,
  createdAt: z.number().int(),
});
export const strategyProposalsRead = z.array(strategyProposal);

/**
 * The treasury assistant (#219). A question with the conversation's earlier turns, text only: the page never sends a tool
 * result back, so it can't forge one. The answer cites its sources by ID, and carries the drafts it made: forms the page
 * opens in its existing review flows, never anything sent.
 */
export const assistantTurn = z.strictObject({ role: z.enum(["user", "assistant"]), text: z.string().max(1_200) });
export const assistantRequest = z.strictObject({ question: z.string().trim().min(1).max(2_000), history: z.array(assistantTurn).max(8).default([]) });
const draftChange = z.strictObject({ field: z.string(), from: z.string(), to: z.string() });
export const assistantDraft = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("strategy"), targets: z.record(z.string(), z.number()), schedule: z.strictObject({ everyMin: z.number().optional(), maxUsd: z.number().optional() }).optional(),
    changes: z.array(draftChange), legs: z.array(z.strictObject({ sell: z.string(), buy: z.string(), usd: z.number() })).optional(), note: z.string() }),
  z.strictObject({ kind: z.literal("policy"), changes: z.array(draftChange), note: z.string(),
    fields: z.strictObject({ budget: z.strictObject({ daily_usd: z.string().nullable(), weekly_usd: z.string().nullable(), monthly_usd: z.string().nullable() }).optional(),
      owner_approval: z.boolean().optional(), max_actions_per_hour: z.number().nullable().optional(), swap: z.boolean().optional() }) }),
  z.strictObject({ kind: z.literal("rebalance"), legs: z.array(z.strictObject({ sell: z.string(), buy: z.string(), usd: z.number() })).optional(), note: z.string() }),
  z.strictObject({ kind: z.literal("grant"), note: z.string() }),
  z.strictObject({ kind: z.literal("freeze"), reason: z.string(), note: z.string() }),
]);
export const assistantAnswer = z.strictObject({
  answer: z.string(),
  sources: z.array(z.strictObject({ id: z.string(), label: z.string(), read: z.string(), at: z.string() })),
  drafts: z.array(assistantDraft),
  model: z.string(),
  stopped: z.enum(["refused", "truncated", "tool_budget"]).optional(),
});
/** Whether this server answers questions, and with which model. */
export const assistantStatus = z.strictObject({ available: z.boolean(), model: z.string().nullable() });
/**
 * A strategy proposed by an agent's token (#206): the strategy, why, and the digest of the saved strategy it was read
 * against (`GET …/strategy`), which adopting it saves over.
 */
export const strategyProposalRequest = z.strictObject({ strategy: strategyInput, reasons: strategyProposal.shape.reasons, expectedDigest: enableRequest.shape.expectedDigest });
export const strategyProposed = z.strictObject({ id: strategyProposal.shape.id });
/** A grant is asked for the saved strategy the owner saw, by its digest: refused if it has changed since. */
export const grantRequest = enableRequest;
/**
 * A grant prepared for the owner: for a wallet owner, the intent their wallet signs here (or, for one the platform
 * holds, its confirm page); for a DAO, the transaction a member files for the DAO's vote. It expires at `expiresAt`.
 */
export const grantPrepared = z.strictObject({
  correlationId: z.string(), expiresAt: z.string(),
  intent: nep413Intent.optional(),
  confirm: z.strictObject({ url: z.string(), expiresAt: z.string() }).optional(),
  dao: z.strictObject({ transaction: memberTransaction }).optional(),
  /** A policy edit's terms before and after, for a DAO member to compare before filing (the DAO's proposal names only the fields). */
  policy: z.strictObject({ current: z.looseObject({}), requested: z.looseObject({}) }).optional(),
});
/** A wallet owner's signed intent, as their wallet answers it: the intent, with the key that signed and its signature. */
export const grantSubmission = z.strictObject({ signedData: nep413Intent.extend({ public_key: z.string(), signature: z.string() }) });
/** An owner action prepared for the owner (#133): the same three forms a grant comes in, whichever action it is. */
export const ownerActionPrepared = grantPrepared;
/** A wallet owner's signed intent for any owner action: the same shape as a grant's. */
export const ownerActionSubmission = grantSubmission;
/** What the platform recorded for a submitted grant: its status, and a failure code once one is known. */
export const grantSubmitted = z.strictObject({ status: z.string(), failureCode: z.string().nullable() });
/** Where an owner action stands (a creation or a grant), as the platform's `owner/status` answers it. */
export const ownerActionStatus = creationStatus;
/** A proposal found by the `requestId` it was proposed with. */
export const requestRead = z.strictObject({ proposal: proposalView });
/**
 * An operation by its `correlationId`, from its `activity` row: `status` is null until an outcome is recorded, and
 * `refused` names a refusal. Never `owner/status`, which answers `unknown` for any swap.
 */
export const operationRead = z.strictObject({ correlationId: z.string(), at: z.string(), kind: z.string(), status: z.string().nullable(), refused: z.string().nullable() });

/**
 * The stabilization agent's report (#220), as the audit log recorded it: the forward level and its reasons, the
 * projection's figures, every stress scenario most severe first, and what the agent would do. `derisk` is the
 * recommendation (its size, and why it isn't proposed when it isn't), never a promise that one was: only the record's
 * own `requestId` in the log says a proposal was made, and only the owner can approve it.
 */
const riskProjectionRead = z.strictObject({
  usable: z.boolean(), reasons: z.array(z.string()),
  projectedDrawdownPct: z.number(), expectedShortfallPct: z.number(), breachProbabilityPct: z.number(),
  runwayMonths: z.number(), monthsToFloor: z.number(), volatileSharePct: z.number(),
});
const riskScenarioRead = z.strictObject({
  id: z.string(), label: z.string(), valueUsd: z.number(), lossUsd: z.number(), drawdownPct: z.number(),
  stableUsd: z.number(), runwayMonths: z.number(), floorUsd: z.number(), floorBreached: z.boolean(), unfundedUsd: z.number(), tradable: z.boolean(),
});
const riskRecommendationRead = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("hold-buys"), reason: z.string() }),
  z.strictObject({ action: z.literal("de-risk"), asset: z.string(), into: z.string(), sizeUsd: z.number(), reason: z.string(), blocked: z.string().nullable() }),
  z.strictObject({ action: z.literal("pause-autopilot"), reason: z.string() }),
  z.strictObject({ action: z.literal("recommend-freeze"), reason: z.string() }),
]);
export const riskReport = z.strictObject({
  /** The time the assessment was recorded, and the log's sequence number for it. */
  at: z.string(), seq: z.number().int(),
  /** The forward level only: the policy checks trades at the higher of it and Ballast's own. */
  level: z.number().int().min(0).max(4),
  reason: z.string(),
  projection: riskProjectionRead,
  scenarios: z.array(riskScenarioRead),
  recommendations: z.array(riskRecommendationRead),
  derisk: z.strictObject({ sizeUsd: z.number(), blocked: z.string().nullable() }).nullable(),
  /** Whether the de-risk sell in this record was proposed under its recorded `requestId`, for the owner to approve. */
  proposed: z.boolean(),
});
export type RiskReport = z.infer<typeof riskReport>;
/** The agent's latest recorded risk assessment, or null when none has been recorded yet. */
export const riskRead = z.strictObject({ risk: riskReport.nullable() });

/**
 * Every failure the server answers. None carries the platform's error text, which is logged on the server instead.
 * - `not_signed_in` (401): no live session;
 * - `not_owner` (403): the session's account doesn't own this agent, or no such agent exists: the same answer for both,
 *   so a signed-in stranger can't tell which agents exist;
 * - `refused` with a `code`: the request itself was refused (`origin`, `content_type`, `bad_request`, `not_found`,
 *   `too_large`, `rate_limited`, `platform_rate_limited` (the platform's limit on the deployment's calls: nothing was done), `not_permitted` (a DAO member whose roles don't allow this), a sign-in code, or a consent code: `not_created`, `already_connected`, `not_this_consent`, `agent_changed`,
 *   `consent_refused`, `owner_stopped` (the owner's wallet stop came after the text's nonce: a new text, and a new
 *   signature; a setup's too), a setup code: `not_this_setup`, `already_set_up`, `setup_unavailable`, `setup_refused`,
 *   `not_set_up`, `already_created`, `creation_refused`, `no_creation`, `not_a_dao`, a proposal code: `no_proposal`, `not_this_text`, `not_open`, `expired`, `not_approved`,
 *   `not_connected`, `signature_invalid`, or the platform's `invalidated`, `withdrawn`, `policy_not_in_force`, a new proposal's `nothing_to_propose`, `too_many_proposals`, `not_proposable`, `request_conflict`, a read's `not_found`, a funding code: `dao_funding_fixed`, `funding_refused`, an autopilot code: `autopilot_refused`, `autopilot_not_stopped`, a strategy code: `strategy_refused`, or a grant code: `strategy_changed`, `autopilot_on`, `approve_only`, `grant_pending`, `owner_not_allowed`, `grant_refused`, `no_grant`);
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
