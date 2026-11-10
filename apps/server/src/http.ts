import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import { PROTOCOL_VERSION } from "@ag-ui/core/schemas";
import { accessOf, mayCall, proposalId, proposalList, type OwnerInputs, type ProposalView } from "@multiagency/sdk";
import { verifyNep413Signature } from "near-kit";
import { z } from "zod";
import { createAgentTokens, memoryTokenRecords, type AgentTokens, type StoredAgentToken } from "./agent-tokens.ts";
import type { BallastSettings } from "./ballast.ts";
import { buildHedge } from "./hedge.ts";
import type { Intents } from "./intents.ts";
import { diversificationView } from "./diversification.ts";
import { sha256, type Audit } from "./audit.ts";
import { checkConsent, consentFor, consentText, liveConsents, organizationOf, withOwner } from "./consent.ts";
import { offerFor } from "./dao-offer.ts";
import type { DaoRequests, StoredAgentRequest, StoredDaoRequest } from "./dao-requests.ts";
import { createSettle, type Settle } from "./dao-settle.ts";
import { awaiting, holdsEach, statusPhase } from "./owner-action.ts";
import { changesNothing } from "./policy-edit.ts";
import { memberAccess, type DaoChain } from "./dao.ts";
import type { KeyLookup } from "./keys.ts";
import type { Page } from "./page.ts";
import { checkVerdict, outcomeOf, type Verdict } from "./proposals.ts";
import * as contract from "./contract.ts";
import type { Admitted } from "./contract.ts";
import type { ConsentRecord, IdentityAnswer, Platform, PreparedAnswer, ProposalAnswer, ProposalListAnswer, SweepRun } from "./platform.ts";
import { failure, log } from "./log.ts";
import { createRateLimit, type RateLimit } from "./ratelimit.ts";
import { agentsOf, checkSetup, DAO_SETUP_MS, setupConsents, setupFor, setupText } from "./setup.ts";
import { recordResult, revokeAll } from "./revoke.ts";
import { riskReportOf, type LatestRisk } from "./risk.ts";
import type { Sessions } from "./sessions.ts";
import { createStrategyProposals, memoryProposalRecords, type StrategyProposals } from "./strategy-proposals.ts";
import type { SignIn } from "./signin.ts";
import type { Assistant } from "./assistant/assistant.ts";
import type { ChainRecord } from "./chain.ts";

export const COOKIE = "__Host-treasury_session";
/**
 * What an agent's token may call (#139): the owner's reads of the agent, and a proposal for the owner to decide. Never a
 * verdict, an execution, an owner action, funding, a sweep, a change to the strategy or autopilot, or a consent: those stay
 * in the owner's session and wallet. Every other route refuses a token, whatever it carries.
 */
const TOKEN_ROUTES = ["GET /api/agents/:agent/overview", "GET /api/agents/:agent/activity", "GET /api/agents/:agent/unresolved",
  "GET /api/agents/:agent/strategy", "GET /api/agents/:agent/autopilot", "GET /api/agents/:agent/proposals", "GET /api/agents/:agent/proposals/:id",
  "POST /api/agents/:agent/proposals", "POST /api/agents/:agent/strategy-proposals"] as const;
const BEARER = /^Bearer (\S+)$/;
const MAX_BODY = 16 * 1024;

export type Deps = {
  platform: Platform; signIn: SignIn; sessions: Sessions;
  /** This server's own origin: the only `Origin` accepted on writes. */
  publicOrigin: string;
  /** This app's deployment: an agent whose identity names another is refused as a misconfiguration. */
  deployment: string;
  /** How many reverse proxies to trust for the client's address (`X-Forwarded-For`); 0 uses the connection's. */
  trustedProxyHops: number;
  /**
   * Owner-route requests a signed-in account may make a minute. Each may cost a call against the platform's per-credential
   * quota, which every owner shares, so one account can't spend it for the rest.
   */
  ownerRequestsPerMinute: number;
  /** Where relayed owner actions are recorded: each attempt before the platform is asked, and its result. */
  audit: Audit;
  /**
   * New consents a signed-in account may relay a day. The platform caps a deployment's live consents at 1,024, every
   * owner's together; this server revokes an agent's older consents once a new one is stored.
   */
  consentsPerDay: number;
  /** DAO requests (consents and votes) a signed-in member may file a day: the platform allows a deployment 256, shared. */
  daoFilingsPerDay: number;
  /** Whether a key is a full-access key of an account, as the chain answers: an owner's verdict must be signed with one. */
  keyLookup: KeyLookup;
  /** What the server reads of DAOs on chain: who a DAO's members are and what their roles allow, and its proposals. */
  daos: DaoChain;
  /** The DAO requests this server filed and hasn't seen end. */
  daoRequests: DaoRequests;
  /**
   * Reads an open DAO request and completes it if its vote passed: by default the server's own (`createSettle`); the
   * background reader passes the one it shares, so their reads of the same request at once share one.
   */
  settle?: Settle;
  /** The tokens issued to owners' agents (#139); without it, tokens last as long as the process. */
  agentTokens?: AgentTokens;
  /** The strategies agents proposed and the owner hasn't answered (#206); without it, they last as long as the process. */
  strategyProposals?: StrategyProposals;
  /**
   * The Ballast settings `watch` runs for an agent, when it does: the diversification read reports its venue and class
   * caps from the compiled mandate these name. Absent, the read shows the profile's defaults or no caps at all (#221).
   */
  ballastSettings?: (organization: string, agent: string) => BallastSettings | undefined;
  /**
   * The latest stabilization record for an agent (#220), read from the audit log: the owner's risk report. Without it,
   * the route answers that no assessment has been recorded.
   */
  latestRisk?: LatestRisk;
  /**
   * NEAR Intents' token list and dry-run quotes (#221): the hedge read's live prices and quotes. Without it, the read says
   * NEAR Intents isn't connected and every move is blocked for want of a quote.
   */
  intents?: Intents;
  /**
   * Calls a single token may make an hour, apart from the account's own: a token is a credential the owner hands to software,
   * and each of its calls is a call against the platform's hourly budget, which every owner shares.
   */
  tokenRequestsPerHour?: number;
  /** Calls every token together may make an hour: the part of the platform's budget that software may spend. */
  tokenBudgetPerHour?: number;
  /** The proposals page, served at every GET and HEAD outside `/api/`; without it, the server answers only its API. */
  page?: Page;
  /** The treasury assistant (#219); without it, questions are refused as `assistant_not_configured`. */
  assistant?: Assistant;
  /** The audit log's records, read for the assistant's decision and audit-trail tools. */
  auditLog?: () => Promise<readonly ChainRecord[]>;
};
/**
 * What a handler reads: the dependencies, the limits the server keeps across requests, and the DAO filings in flight
 * per agent, so two members' clicks file once.
 */
type Context = Deps & { settle: Settle; tokens: AgentTokens; strategyProposals: StrategyProposals; consentsToday: RateLimit; daoFilingsToday: RateLimit; filing: Map<string, Promise<Filing>>;
  /** The account's owner-route requests a minute (`ownerRequestsPerMinute`), shared with the setup routes, which reach the platform too. */
  requests: RateLimit };

/**
 * Who may call a route: anyone, a signed-in session, or the signed-in owner of the route's `:agent`. `owner` may use an
 * identity the platform answered within the last minute: for routes that forward to the platform, which checks the
 * owner again on every forwarded call (a consent is live only while its signer owns the agent). `owner-fresh` reads it
 * anew: for routes that answer from this server's own records, which nothing else re-checks, and for writes that build
 * on the agent's identity, where a stale one would be refused anyway.
 */
export type Access = "public" | "session" | "owner" | "owner-fresh";
/** A call as its handler sees it. `identity` is the agent's, as the owner check read it (see `Access`), on owner routes only. */
type Call = { req: IncomingMessage; body: unknown; token: string | undefined; account: string | undefined; params: Record<string, string>; identity?: Admitted;
  /** Who the audit trail names: the account, or `token:<id>` for a call by an agent's token (`account` is then the token's issuer). */
  actor?: string; viaToken?: StoredAgentToken };
/**
 * What a route answers: JSON, or (`csv`) a download: the text as the platform produced it, named for the browser to save.
 * The body of a download is never read as JSON, so it carries no value.
 */
type Reply = { status: number; body: contract.Answer<unknown>; cookie?: string; csv?: { filename: string; text: string } };
/**
 * What an agent route needs of the account's access, beyond being admitted, as the platform's own rule for the
 * procedure it stands for (`mayCall`, so it can't drift from what the platform enforces): `read` a read; `sign` relaying
 * the owner's own signature (`owner/submit`: a wallet owner, never a DAO's member); `file` preparing what the owner
 * signs (`owner/prepare`: the owner, or a DAO member who may file its proposals, which the DAO contract checks too);
 * `execute` asking for a proposal's execution.
 */
export type Need = "read" | "sign" | "file" | "execute" | "deposit" | "link" | "sweep" | "propose" | "enable" | "stop" | "tick" | "save";
const NEEDS: Record<Need, string> = { read: "proposals/get", sign: "owner/submit", file: "owner/prepare", execute: "proposals/execute",
  deposit: "deposit", link: "treasury/link", sweep: "sweep", propose: "proposals/create",
  enable: "autopilot/enable", stop: "autopilot/stop", tick: "autopilot/tick", save: "strategy/save" };
type Route = { method: "GET" | "POST" | "DELETE"; path: string; handle(call: Call, context: Context): Promise<Reply> }
  & ({ access: "public" } | { access: "session" } | { access: "owner" | "owner-fresh"; needs: Need });

const ok = (value: unknown, status = 200): Reply => ({ status, body: { ok: true, value } });
const fail = (status: number, body: contract.ServerFailure): Reply => ({ status, body });
const refused = (status: number, code: string) => fail(status, { ok: false, kind: "refused", code });
const notOwner = () => fail(403, { ok: false, kind: "not_owner" });
const unavailable = () => fail(503, { ok: false, kind: "unavailable" });
/**
 * The platform's own limit on this deployment's calls (its 429 JSON answer, `rate_limited`): nothing was done, and it
 * isn't this account's doing, so it reads apart from this server's per-account `rate_limited`. A 429 that isn't the
 * platform's answer (a proxy's page) proves nothing about the request and stays `unavailable`.
 */
const platformLimited = () => refused(429, "platform_rate_limited");


const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

const cookieFor = (token: string, maxMs: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxMs / 1000)}`;
const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/**
 * The client's address for the challenge rate limit. With no trusted proxies, the connection's own address. Behind
 * `hops` trusted proxies, the address the outermost of them saw: the `hops`-th entry from the right of
 * `X-Forwarded-For`, since anything left of it can be written by the client itself.
 */
export function clientAddress(req: IncomingMessage, hops: number) {
  const direct = req.socket.remoteAddress ?? "unknown";
  if (hops === 0) return direct;
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map(part => part.trim()).filter(Boolean);
  const address = forwarded[forwarded.length - hops];
  if (address) return address;
  // Every such client shares the proxy's own bucket: the proxy isn't forwarding as configured.
  log("proxy_address_missing", { hops, forwarded: forwarded.length });
  return direct;
}

/** A consent as the browser sees it: what was granted and until when. */
const shown = ({ id, scopes, expiresAt }: ConsentRecord) => ({ id, scopes, expiresAt });
/** The platform's answer as the audit trail records it: its kind and status, and the code the browser was given. */
const audited = (answer: { ok: true } | { ok: false; kind: string; status?: number }, reply: Reply) =>
  answer.ok ? { ok: true as const } : { ok: false as const, kind: answer.kind, ...(answer.status !== undefined && { status: answer.status }),
    ..."code" in reply.body && { code: reply.body.code }, ...(!reply.body.ok && reply.body.kind === "not_owner" && { code: "not_owner" }) };
/** The platform's refusal codes for a proposal call that the page may act on, with the status the browser gets. */
const PROPOSAL_CODES: Record<string, number> = { signature_invalid: 400, invalidated: 409, withdrawn: 409, not_open: 409, expired: 409,
  not_approved: 409, policy_not_in_force: 409, nothing_to_propose: 409, too_many_proposals: 409, not_proposable: 409, request_conflict: 409 };
/** How long a rebalance the owner asks for stays open for approval: as long as one `watch` proposes. */
const REBALANCE_HOURS = 24;
/**
 * A failed proposal call as the browser gets it: no such proposal, the platform's own code where the page can act on
 * it, `not_connected` when no live consent covers the agent (the platform's 403), and `unavailable` for anything else,
 * logged. The platform's text is never forwarded.
 */
function proposalFailure(answer: Exclude<ProposalAnswer | ProposalListAnswer, { ok: true }>, agent: string): Reply {
  if (answer.kind === "refused" && answer.status === 404) return refused(404, "no_proposal");
  if (answer.kind === "refused" && answer.code && PROPOSAL_CODES[answer.code]) return refused(PROPOSAL_CODES[answer.code]!, answer.code);
  if (answer.kind === "forbidden") return refused(409, "not_connected");
  log("platform_proposal_failed", { agent, ...failure(answer as { kind: string }), ..."code" in answer && answer.code !== undefined && { code: answer.code } });
  return unavailable();
}
/**
 * A failed owner read as the browser gets it: `not_connected` when no live consent covers the agent (the platform's
 * 403), and `unavailable` for anything else, logged. The platform's text is never forwarded.
 */
function readFailure(answer: { ok: false; kind: string }, agent: string, read: string): Reply {
  if (answer.kind === "forbidden") return refused(409, "not_connected");
  log("platform_read_failed", { agent, read, ...failure(answer) });
  return unavailable();
}
/** An ID from the address for a read: a run's tick, a proposal's `requestId`, an operation's `correlationId`. */
const readId = (value: string | undefined) => value !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
/**
 * Prepares an owner action the owner signs or the DAO votes on (#133), shaped on the grant's route so the next action
 * (#142's revocation) is another call of this. Relayed once, recorded before and after (`audit`), refused while another
 * freeze or unfreeze is awaiting its outcome (they hold each other), and for a wallet owner only under a connection that
 * allows owner actions. Which form comes back (intent, confirm page, DAO transaction) is the platform's choice.
 */
type OwnerActionInput = Parameters<Platform["owner"]["prepare"]>[2]["action"];
const ownerActionRoute = (path: string, audited_: "freeze" | "unfreeze" | "grant-revoke" | "policy-update", action: (body: unknown) => OwnerActionInput | undefined): Route => ({
  method: "POST", path, access: "owner-fresh", needs: "file",
  async handle({ body, account, identity }, { platform, audit }) {
    const { agent, owner, signer, access } = identity!, organization = organizationOf(owner);
    const asked = action(body);
    if (asked === undefined) return refused(400, "bad_request");
    // An edit that would leave the policy as it is is refused before anything is prepared.
    if (asked.type === "policy_update") {
      const current = await relay(() => platform.reads.overview(organization, agent), agent);
      if (!current.ok) return readFailure(current, agent, "overview");
      if (current.value.policy.policy && changesNothing(current.value.policy.policy, asked.changes)) return refused(409, "no_change");
    }
    const actions = await relay(() => platform.reads.ownerActions(organization, agent), agent);
    if (!actions.ok) return readFailure(actions, agent, "owner/actions");
    const now = Date.now();
    // Held while another of its kind awaits its outcome (`awaiting` says when a prepared one doesn't).
    if (actions.value.some(other => holdsEach(asked.type, other.type) && awaiting(other, now))) return refused(409, "action_pending");
    if (signer === "wallet") {
      const allowed = await ownerAllowed(platform, organization, identity!, agent);
      if (allowed === "unavailable") return unavailable();
      if (!allowed) return refused(409, "owner_not_allowed");
    }
    await audit.append({ who: account!, action: audited_, agent, stage: "attempt" });
    const prepared = await relay(() => platform.owner.prepare(organization, agent, { action: asked, signer }), agent);
    const reply = preparedReply(prepared, { signer, access, agent, what: "owner_action", refusal: "action_refused" });
    await recordResult(audit, { who: account!, action: audited_, agent, ...(prepared.ok && { subject: prepared.value.correlationId }), stage: "result", answer: audited(prepared, reply) });
    return reply;
  },
});
const bare = (type: "agent_freeze" | "agent_unfreeze") => (body: unknown) => parse(z.strictObject({}), body) === undefined ? undefined : { type } as const;
const revocation = (body: unknown) => { const input = parse(z.strictObject({ grantId: z.string().min(1).max(200) }), body); return input && { type: "grant_revoke", grantId: input.grantId } as const; };
const policyEdit = (body: unknown) => { const input = parse(contract.policyUpdateRequest, body); return input && { type: "policy_update" as const, ...input }; };

/** A route answering one of the agent's owner reads as the platform answers it (#61). */
const readRoute = (path: string, read: "account" | "overview" | "activity" | "held" | "unresolved" | "runs" | "policyHistory"): Route => ({
  method: "GET", path, access: "owner", needs: "read",
  async handle({ identity }, { platform }) {
    const { agent, owner } = identity!;
    const call = platform.reads[read] as (organization: string, agent: string) => Promise<{ ok: true; value: unknown } | { ok: false; kind: string }>;
    const answer = await relay(() => call(organizationOf(owner), agent), agent);
    return answer.ok ? ok(answer.value) : readFailure(answer, agent, read);
  },
});

/** What a deposit address is asked for by: the asset the page names, as the platform takes it. NEAR is wrapped, so it funds wNEAR. */
const DEPOSIT_ASSETS = { USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", NEAR: "nep141:wrap.near" } as const;
/**
 * A wallet owner's change to the agent's funding account, relayed once and recorded before the platform is asked and
 * after: link an account or unlink it. A DAO agent's funding account is the DAO, fixed at setup, and the platform
 * refuses these under a DAO's consent: a member is refused here (`dao_funding_fixed`)
 * whatever their roles, since one with every DAO permission passes `mayCall`. The platform's refusal is
 * `funding_refused` (its text is logged, never forwarded); after a lost answer the page reads the account again before
 * anything else.
 */
const fundingChange = <B extends z.ZodType>(path: string, action: "link" | "unlink", body: B,
  change: (platform: Platform, organization: string, agent: string, input: z.output<B>) => Promise<{ ok: true } | { ok: false; kind: string; status?: number }>): Route => ({
  method: "POST", path, access: "owner-fresh", needs: "link",
  async handle({ body: sent, account, identity }, { platform, audit }) {
    const { agent, owner, signer } = identity!;
    if (signer === "dao") return refused(409, "dao_funding_fixed");
    const input = parse(body, sent);
    if (input === undefined) return refused(400, "bad_request");
    await audit.append({ who: account!, action, agent, stage: "attempt" });
    const answer = await relay(() => change(platform, organizationOf(owner), agent, input), agent);
    const reply = answer.ok ? ok({}) : answer.kind === "forbidden" ? refused(409, "not_connected")
      : answer.kind === "refused" ? refused(409, "funding_refused") : answer.kind === "rate_limited" ? platformLimited() : unavailable();
    if (!answer.ok && answer.kind !== "forbidden") log("platform_funding_failed", { agent, action, ...failure(answer) });
    await recordResult(audit, { who: account!, action, agent, stage: "result", answer: audited(answer, reply) });
    return reply;
  },
});

/** A failed sweep's `RUN_ERROR` message, for a person, by the failure's kind; its `code` is the kind itself. */
const SWEEP_FAILED: Record<string, string> = {
  refused: "The platform refused the sweep.",
  forbidden: "No live consent covers this agent.",
  provider: "The provider refused the sweep.",
  busy: "The agent is busy with another operation.",
  unresolved: "An earlier operation's outcome isn't proven yet.",
};
/**
 * A sweep as AG-UI 1.0 events (`contract.sweepRun`): the run's start, a snapshot of its activity after each event the
 * platform gave, and its end. A stream the SDK reports `unknown` (lost after it began) gets no terminal event: the run
 * is truncated, and a truncated run is never reported as finished or failed.
 */
function sweepEvents(agent: string, { events, ended }: SweepRun) {
  const threadId = `sweep-${agent}`, runId = randomUUID(), messageId = `${runId}-activity`;
  const plan = events.find(event => event.type === "plan");
  const shields: z.output<typeof contract.sweepActivity>["shields"] = [];
  const activity = [];
  for (const event of events) {
    if (event.type === "shield") shields.push({ asset: event.asset, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode ?? null });
    const content: z.output<typeof contract.sweepActivity> = {
      exposed: (plan?.type === "plan" ? plan.exposed : []).map(({ asset, symbol, decimals, public: amount }) => ({ asset, symbol, decimals, public: String(amount) })),
      shields: [...shields],
    };
    activity.push({ type: EventType.ACTIVITY_SNAPSHOT, messageId, activityType: contract.SWEEP_ACTIVITY, content });
  }
  const end = !ended ? [{ type: EventType.RUN_FINISHED, threadId, runId }]
    : ended.kind === "unknown" ? []
    : [{ type: EventType.RUN_ERROR, message: SWEEP_FAILED[ended.kind] ?? "The sweep failed.", code: ended.kind }];
  return [{ type: EventType.RUN_STARTED, threadId, runId, protocolVersion: PROTOCOL_VERSION }, ...activity, ...end];
}

/**
 * An autopilot action, sent once and recorded before the platform is asked and after: turned on for the digest the
 * owner saw, turned off, or run once now. The platform's refusal is `autopilot_refused` (its text logged); a lost answer
 * is `unavailable`, and the page reads the schedule again before anything else, since a run now may have run.
 */
const autopilotAction = <B extends z.ZodType>(path: string, action: "autopilot-on" | "autopilot-off" | "run-now", needs: Need, body: B,
  send: (platform: Platform, organization: string, agent: string, input: z.output<B>) => Promise<{ ok: true; value: unknown } | { ok: false; kind: string; status?: number }>,
  shown: (value: unknown) => unknown): Route => ({
  method: "POST", path, access: "owner-fresh", needs,
  async handle({ body: sent, account, identity }, { platform, audit }) {
    const { agent, owner } = identity!;
    const input = parse(body, sent ?? {});
    if (input === undefined) return refused(400, "bad_request");
    await audit.append({ who: account!, action, agent, stage: "attempt" });
    const answer = await relay(() => send(platform, organizationOf(owner), agent, input), agent);
    const reply = answer.ok ? ok(shown(answer.value)) : answer.kind === "forbidden" ? refused(409, "not_connected")
      : answer.kind === "refused" ? refused(409, "autopilot_refused") : answer.kind === "rate_limited" ? platformLimited() : unavailable();
    if (!answer.ok && answer.kind !== "forbidden") log("platform_autopilot_failed", { agent, action, ...failure(answer) });
    await recordResult(audit, { who: account!, action, agent, stage: "result", answer: audited(answer, reply) });
    return reply;
  },
});

/**
 * Saves a strategy over the one the owner saw, by its digest, recorded before the platform is asked and after: the
 * owner's own save, or a proposal adopted (`strategy-adopt`, by its ID). A refusal is told apart by reading the strategy
 * anew, never by the platform's text: changed since the owner saw it (`strategy_changed`), or refused (`strategy_refused`).
 */
async function saveStrategy({ platform, audit }: Context, { agent, owner }: Admitted,
  record: { who: string; action: "strategy-save" | "strategy-adopt"; subject?: string }, input: OwnerInputs["strategy/save"]): Promise<Reply> {
  const organization = organizationOf(owner);
  await audit.append({ ...record, agent, stage: "attempt" });
  const saved = await relay(() => platform.autopilot.save(organization, agent, input), agent);
  let reply: Reply;
  if (saved.ok) reply = ok({ digest: saved.value.digest });
  else if (saved.kind === "forbidden") reply = refused(409, "not_connected");
  else if (saved.kind === "refused") {
    const now = await relay(() => platform.autopilot.strategy(organization, agent), agent);
    reply = now.ok && now.value.digest !== input.expectedDigest ? refused(409, "strategy_changed") : refused(409, "strategy_refused");
  } else reply = unavailable();
  if (!saved.ok && saved.kind !== "forbidden") log("platform_strategy_failed", { agent, ...failure(saved) });
  await recordResult(audit, { ...record, agent, stage: "result", answer: audited(saved, reply) });
  return reply;
}

/**
 * Where an owner action stands (a creation, or a grant), by the correlation ID its preparation answered: the platform's
 * 404 is `missing`, its 403 `forbidden`, anything else `unavailable`, logged.
 */
async function ownerStatus(identity: Admitted, id: string | undefined, status: Platform["creation"]["status"], codes: { missing: string; forbidden: string }): Promise<Reply> {
  const { agent, owner } = identity;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id ?? "")) return refused(400, "bad_request");
  const read = await relay(() => status(organizationOf(owner), agent, id!), agent);
  if (read.ok) return ok({ stage: read.value.stage,
    ...(read.value.phase !== undefined && { phase: read.value.phase }),
    ...(read.value.status !== undefined && { status: read.value.status }),
    ...(read.value.failureCode !== undefined && { failureCode: read.value.failureCode }) });
  log("platform_owner_status_failed", { agent, ...failure(read) });
  return read.kind === "refused" && read.status === 404 ? refused(404, codes.missing) : read.kind === "forbidden" ? refused(409, codes.forbidden) : unavailable();
}

/**
 * An owner action the platform prepared, as the page takes it (#133, and the grant before it): for a wallet owner the
 * intent their wallet signs here, or the platform's confirm page where they sign; for a DAO the transaction a member
 * files for its vote, the file-and-vote one when the member may vote too. Which form an action takes is the platform's
 * choice, so each is handled and none assumed. A refusal is `refusal`; an answer in none of the forms is unavailable.
 */
function preparedReply(prepared: PreparedAnswer | { ok: false; kind: "unavailable" }, { signer, access, agent, what, refusal }: {
  signer: "wallet" | "dao"; access: contract.Access; agent: string; what: string; refusal: string }): Reply {
  if (prepared.ok) {
    const { correlationId, expiresAt, intent, confirm, dao } = prepared.value;
    const transaction = dao && parse(contract.memberTransaction, access.canVote && dao.proposalAndVote ? dao.proposalAndVote : dao.proposal);
    const reply = signer === "wallet" && intent?.standard === "nep413" ? ok({ correlationId, expiresAt, intent })
      : signer === "wallet" && confirm ? ok({ correlationId, expiresAt, confirm: { url: confirm.url, expiresAt: confirm.expiresAt } })
      : signer === "dao" && transaction ? ok({ correlationId, expiresAt, dao: { transaction }, ...(prepared.value.policy && { policy: { current: prepared.value.policy.current, requested: prepared.value.policy.requested } }) }) : unavailable();
    if (reply.status !== 200) log(`platform_${what}_unreadable`, { agent, correlationId });
    return reply;
  }
  log(`platform_${what}_failed`, { agent, ...failure(prepared) });
  return prepared.kind === "forbidden" ? refused(409, signer === "wallet" ? "owner_not_allowed" : "not_connected")
    : prepared.kind === "refused" ? refused(409, refusal) : prepared.kind === "rate_limited" ? platformLimited() : unavailable();
}

/** Whether a wallet owner's live consent allows owner actions (`owner`): without it the platform refuses what the app prepares. */
async function ownerAllowed(platform: Platform, organization: string, identity: Admitted, agent: string): Promise<boolean | "unavailable"> {
  const listed = await platform.consents.list(organization);
  if (!listed.ok) { log("platform_consents_failed", { agent, ...failure(listed) }); return "unavailable"; }
  return liveConsents(listed.value.consents, identity).some(consent => withOwner(consent.scopes));
}

/**
 * The text for the owner's wallet, with a NEP-413 nonce the platform issued for it: once the owner's wallet stop covers
 * the agent, the platform stores only a text signed with a nonce it issued after the stop (`owner_stopped` otherwise).
 * Unanswered, the owner is shown no text, never one with a nonce of this server's.
 */
async function withPlatformNonce(platform: Platform, who: string, text: (nonce: string) => unknown): Promise<Reply> {
  const issued = await relay(() => platform.consents.nonce(), who);
  if (issued.ok) return ok(text(issued.value.nonce));
  log("platform_nonce_failed", { who, ...failure(issued) });
  return issued.kind === "rate_limited" ? platformLimited() : unavailable();
}

/** A platform call whose throw is a lost answer: logged, and answered as `unavailable`, so a result is always recorded. */
async function relay<Answer>(call: () => Promise<Answer>, agent: string): Promise<Answer | { ok: false; kind: "unavailable" }> {
  try { return await call(); } catch (error) { log("platform_call_threw", { agent, error: String(error) }); return { ok: false, kind: "unavailable" }; }
}
/**
 * The agents "Your treasuries" lists for an owner (`agentsOf`): a lapsed setup's agent only once created, as its
 * identity answers; the platform's 404 means it isn't. Null when an identity can't be read: unavailable, never a guess.
 */
async function treasuriesOf(consents: readonly ConsentRecord[], owner: string, platform: Platform): Promise<string[] | null> {
  const { listed, lapsed } = agentsOf(consents, owner);
  const created = await Promise.all(lapsed.map(async agent => {
    const answer = await relay(async () => (await platform.identity(agent)).answer, agent);
    if (answer.ok) return answer.value.agentId !== null;
    if (answer.kind === "refused" && answer.status === 404) return false;
    log("platform_identity_failed", { agent, ...failure(answer) });
    return null;
  }));
  return created.includes(null) ? null : [...listed, ...lapsed.filter((_, i) => created[i])].sort();
}
/** Whether the platform's answer may have been lost: then the proposal is read once, never the call sent again. */
const lost = (answer: ProposalAnswer) => !answer.ok && !(answer.kind === "refused" && answer.status !== undefined) && answer.kind !== "forbidden" && answer.kind !== "session";

/**
 * Whether the owner signed `message` for the platform's host with `nonce`, with a full-access key of their own account:
 * checked here, so a bad signature is a stable `signature_invalid` (the gateway's own answer to it reaches the SDK as a
 * lost one) and costs no relay.
 */
async function ownersSignature(signed: { message: string; nonce: string; publicKey: string; signature: string }, identity: Admitted, keyLookup: KeyLookup) {
  const valid = await verifyNep413Signature({ accountId: identity.owner, publicKey: signed.publicKey, signature: signed.signature },
    { message: signed.message, recipient: identity.host, nonce: new Uint8Array(Buffer.from(signed.nonce, "base64")) }, { nonceValidation: "none" });
  if (!valid) return "invalid" as const;
  const key = await keyLookup(identity.owner, signed.publicKey);
  return key === "unavailable" ? "unavailable" as const : key === "full" ? "owners" as const : "invalid" as const;
}

/**
 * Relays the owner's signed verdict on a proposal: read anew and checked to be open, unexpired and exactly the text
 * signed (`checkVerdict`), signed with the owner's own full-access key for the platform's host, and recorded before the
 * platform is asked and after. A lost answer, a thrown call or `already_approved` is settled by one read: the verdict
 * was recorded if the proposal now reads approved (or rejected). The same signed body may be sent again otherwise.
 */
const verdictRoute = (verdict: Verdict): Route => ({
  method: "POST", path: `/api/agents/:agent/proposals/:id/${verdict}`, access: "owner-fresh", needs: "file",
  async handle({ body, account, identity, params }, context) {
    const { platform, audit, keyLookup } = context;
    // A DAO's verdict is its vote, filed from the platform's own text of the proposal: the browser sends nothing.
    if (identity!.signer === "dao") {
      const id = parse(proposalId, params.id);
      if (!id || identity!.agentId === null) return refused(400, "bad_request");
      return fileDao({ kind: "vote", proposal: id, verdict }, account!, { ...identity!, agentId: identity!.agentId }, context);
    }
    const id = parse(proposalId, params.id), signed = parse(contract.verdictSubmission, body);
    if (!id || !signed) return refused(400, "bad_request");
    const organization = organizationOf(identity!.owner), { agent } = identity!;
    const fresh = await relay(() => platform.proposals.get(organization, agent, id), agent);
    if (!fresh.ok) return proposalFailure(fresh, agent);
    const checked = checkVerdict(signed.message, fresh.value, verdict);
    if (!checked.ok) return refused(409, checked.code);
    const signature = await ownersSignature(signed, identity!, keyLookup);
    if (signature === "unavailable") return unavailable();
    if (signature === "invalid") return refused(400, "signature_invalid");
    const signedTextSha256 = sha256(signed.message);
    await audit.append({ who: account!, action: verdict, agent, subject: id, signedTextSha256, stage: "attempt" });
    const answer = await relay(() => platform.proposals[verdict](organization, agent, { id, signed }), agent);
    let reply: Reply;
    if (answer.ok) reply = ok({ proposal: answer.value });
    else if (lost(answer) || (answer.kind === "refused" && answer.code === "already_approved")) {
      const now = await relay(() => platform.proposals.get(organization, agent, id), agent);
      reply = now.ok && now.value.state === (verdict === "approve" ? "approved" : "rejected") ? ok({ proposal: now.value }) : unavailable();
    } else reply = proposalFailure(answer, agent);
    await recordResult(audit, { who: account!, action: verdict, agent, subject: id, signedTextSha256, stage: "result", answer: audited(answer, reply) });
    return reply;
  },
});

/** An execute's answer, with the proposal as last read (null when that read went unanswered). */
const executed = (result: "final" | "pending" | "not_executable", proposal: ProposalView | null) => ok({ result, proposal });

/** Whom a DAO request is shown or filed for: the DAO, the platform's host and the member's access; and its agent, once there is one. */
type DaoTarget = { owner: string; host: string; access: contract.Access; agent?: string; agentId?: string | null };

/**
 * An open DAO request as the page shows it: what the DAO's proposal says, the platform's check page for the exact text
 * and hash the DAO signs, a vote's verdict, and what this member is offered by what the DAO holds now; the offer is
 * null when the DAO couldn't be read. Null when the DAO's proposal for it ended (rejected, expired or moved): the
 * platform keeps such a request pending until its vote window closes, so it's closed here, and a member may ask again.
 */
async function daoView(stored: StoredDaoRequest, target: DaoTarget, { daos, daoRequests }: Context) {
  const [policy, read] = await Promise.all([daos.policy(stored.filed.dao), daos.proposals(stored.filed.dao, stored.filed.next)]);
  if (policy === "unavailable" || read === "unavailable") log("dao_unreadable", { agent: target.agent, dao: stored.filed.dao });
  const offer = policy === "unavailable" || read === "unavailable" ? null : offerFor(stored.filed, read, policy, target.access, Date.now());
  if (offer?.state === "ended") {
    await daoRequests.close(stored.id, offer.outcome === "Expired" ? "expired" : "rejected");
    return null;
  }
  return { id: stored.id, description: stored.description, votingUntil: stored.votingUntil, check: `https://${target.host}/confirm/dao/${stored.id}`,
    ...(stored.kind === "vote" && { verdict: stored.verdict }), offer };
}

/** What a DAO is asked to vote on: its Organization's Treasury setup, its consent to this app, or a verdict on one of the agent's proposals. */
type DaoSubject = { kind: "setup" } | { kind: "consent" } | { kind: "vote"; proposal: string; verdict: Verdict };

/**
 * Files a DAO request for its vote, or answers the one already open for the same subject (the Organization's setup,
 * the agent's consent, or the proposal's vote): each filing is a new platform request, counted against the
 * deployment's DAO requests a day, so it's filed once, and concurrent clicks share one filing. The DAO's next proposal
 * number is read first, so the proposal a member files for it can be found. The filing is recorded before the
 * platform is asked and after, and stored before it's shown: the platform answers its transactions only once. A lost
 * answer isn't filed again, since it may have been filed.
 */
async function fileDao(subject: DaoSubject, account: string, target: DaoTarget, context: Context): Promise<Reply> {
  const key = [target.owner, subject.kind === "setup" ? "setup" : target.agent, subject.kind === "vote" ? subject.proposal : subject.kind].join(" ");
  const pending = context.filing.get(key) ?? filing(subject, account, target, context).finally(() => context.filing.delete(key));
  context.filing.set(key, pending);
  // Callers share the filing, never its view: what each is offered comes from their own roles.
  const outcome = await pending;
  if ("status" in outcome) return outcome;
  // The open request's DAO proposal ended, so it's closed now: this click files a new one. A new request can't end so.
  const view = await daoView(outcome, target, context);
  return view ? ok({ request: view }) : fileDao(subject, account, target, context);
}

/** A filing's outcome, shared by the clicks that wait on it: the request, open or stored now, or the refusal. */
type Filing = StoredDaoRequest | Reply;

async function filing(subject: DaoSubject, account: string, target: DaoTarget, context: Context): Promise<Filing> {
  const { platform, deployment, audit, daos, daoRequests, daoFilingsToday } = context;
  const organization = organizationOf(target.owner), { agent } = target;
  const open = subject.kind === "setup" ? daoRequests.setup(organization) : subject.kind === "consent" ? daoRequests.consent(organization, agent!)
    : daoRequests.vote(organization, agent!, subject.proposal);
  if (open) return open;
  // A request the platform filed is followed only once it's stored, so one that couldn't be kept isn't filed at all.
  if (!daoRequests.hasRoom()) { log("dao_requests_full", { agent, dao: target.owner }); return unavailable(); }
  const next = await daos.next(target.owner);
  if (next === "unavailable") { log("dao_unreadable", { agent, dao: target.owner }); return unavailable(); }
  // Counted only once the platform will be asked: a filing that stopped before then spends none of the member's day.
  if (!daoFilingsToday(account)) return refused(429, "rate_limited");
  const action = `dao-${subject.kind}` as const;
  const message = subject.kind === "setup" ? setupFor({ host: platform.host, deployment, owner: target.owner }, DAO_SETUP_MS)
    : subject.kind === "consent" ? consentFor({ identity: { owner: target.owner, host: target.host, agent: agent!, agentId: target.agentId! }, deployment }) : undefined;
  // A setup's and a consent's text is this server's, by its hash; a vote's is the platform's own text of the proposal it names.
  const recorded = subject.kind === "vote" ? { subject: subject.proposal, verdict: subject.verdict } : { signedTextSha256: sha256(message!) };
  await audit.append({ who: account, action, agent, ...recorded, stage: "attempt" });
  // A thrown call is a lost answer: recorded as such, and not filed again by this click.
  const filed = subject.kind === "setup" ? await relay(() => platform.daoSetups.file(message!), account)
    : subject.kind === "consent" ? await relay(() => platform.daoConsents.file(message!), agent!)
    : await relay(() => platform.daoVotes.file({ organization, agent: agent!, proposal: subject.proposal, verdict: subject.verdict }), agent!);
  if (!filed.ok) log(`platform_${action.replace("-", "_")}_failed`, { agent, dao: target.owner, ...failure(filed) });
  const transactions = filed.ok ? parse(contract.daoTransactions,
    { proposal: filed.value.transactions.proposal, proposalAndVote: filed.value.transactions.proposalAndVote }) : undefined;
  let outcome: Filing;
  if (filed.ok && transactions) {
    const { request } = filed.value;
    const base = { organization, id: request.id, description: request.description, votingUntil: request.votingUntil, filed: { dao: target.owner, next, transactions } };
    const stored: StoredDaoRequest = subject.kind === "setup" ? { kind: "setup", ...base }
      : subject.kind === "consent" ? { kind: "consent", ...base, agent: agent!, agentId: target.agentId! }
      : { kind: "vote", ...base, agent: agent!, proposal: subject.proposal, verdict: subject.verdict };
    // The platform filed it: one that can't be stored now (another filing took the last room, or the disk failed) is
    // logged and recorded by its ID, since nothing here will follow it.
    const kept = await daoRequests.add(stored).catch(error => { log("dao_request_store_failed", { agent, request: request.id, error: String(error) }); return false; });
    if (!kept) log("dao_request_unstored", { agent, request: request.id });
    outcome = kept ? stored : unavailable();
  } else if (filed.ok) {
    log("platform_dao_transactions_unreadable", { agent, request: filed.value.request.id });
    outcome = unavailable();
  } else {
    // 429: the deployment's DAO requests for the day are spent. A setup's 403: this host doesn't set up Treasury
    // agents; its 409: the platform doesn't read the owner as a DAO. A consent's 409: the agent changed since its
    // identity was read; its 403: the agent isn't this DAO's. A vote's 409: the proposal isn't open, or it (or the
    // consent it would be relayed under) expires too soon for a vote; its 403: no live consent of the DAO covers it.
    // Anything else may work later as is.
    const status = filed.kind === "refused" || filed.kind === "rate_limited" ? filed.status : filed.kind === "forbidden" ? 403 : undefined;
    outcome = status === 429 ? refused(429, "rate_limited")
      : subject.kind === "setup" ? (status === 403 ? refused(403, "setup_unavailable") : status === 409 ? refused(409, "not_a_dao") : unavailable())
      : status === 409 ? refused(409, subject.kind === "consent" ? "agent_changed" : "not_open")
      : status === 403 ? (subject.kind === "consent" ? notOwner() : refused(409, "not_connected")) : unavailable();
  }
  await recordResult(audit, { who: account, action, agent, ...recorded, stage: "result", ...(filed.ok && { request: filed.value.request.id }),
    answer: audited(filed, "status" in outcome ? outcome : ok({})) });
  return outcome;
}

/**
 * The agent's connection for a DAO-owned agent: its live consent, and its consent request while one waits for the
 * vote, read from the platform each time (`settle`): a read after the vote passed stores the consent and closes it.
 * One that closed without a consent says why (`ended`).
 */
async function daoConnection(identity: Admitted, live: ConsentRecord | undefined, context: Context): Promise<Reply> {
  const organization = organizationOf(identity.owner);
  const open = context.daoRequests.consent(organization, identity.agent);
  // Why the last request ended without a consent, whichever read saw it, while no consent and no new request replace it.
  const closed = () => {
    const why = live ? undefined : context.daoRequests.ended(organization, identity.agent);
    return ok({ consent: live ? shown(live) : null, request: null, ...(why && { ended: why }) });
  };
  if (!open) return closed();
  const settled = await context.settle(open);
  if (settled.result === "stored") return ok({ consent: shown(settled.consent), request: null });
  if (settled.result === "ended") return closed();
  const view = await daoView(open, identity, context);
  return view ? ok({ consent: live ? shown(live) : null, request: view }) : closed();
}

/** Every route the server answers. Tests walk this table, so a new route is covered by the access tests as it's added. */
export const routes: Route[] = [
  {
    // For the host's health check: the server answers only after its configuration, credential file and audit trail were
    // checked at startup, so a 200 means it's up and listening. It reads nothing and says nothing more.
    method: "GET", path: "/api/health", access: "public",
    async handle() { return ok({ status: "up" }); },
  },
  {
    method: "POST", path: "/api/session/challenge", access: "public",
    async handle({ req }, { signIn, trustedProxyHops }) {
      const issued = signIn.challenge(clientAddress(req, trustedProxyHops));
      return issued.ok ? ok(issued.value) : refused(429, issued.code);
    },
  },
  {
    method: "POST", path: "/api/session", access: "public",
    async handle({ req, body, token }, { signIn, sessions, trustedProxyHops }) {
      const signed = parse(contract.signIn, body);
      if (!signed) return refused(400, "bad_request");
      const result = await signIn.verify(clientAddress(req, trustedProxyHops), signed);
      if (!result.ok) return result.kind === "unavailable" ? unavailable() : refused(result.code === "rate_limited" ? 429 : 401, result.code);
      // A sign-in replaces the session the browser carried, which ends here rather than living on until it expires.
      sessions.end(token);
      return { ...ok({ account: result.account }), cookie: cookieFor(sessions.start(result.account), sessions.maxMs) };
    },
  },
  {
    // Public, so a browser whose session has already ended still gets its cookie cleared.
    method: "DELETE", path: "/api/session", access: "public",
    async handle({ token }, { sessions }) {
      sessions.end(token);
      return { ...ok({}), cookie: clearedCookie };
    },
  },
  {
    // The signed-in account's own Treasury agents under its Organization: created, or set up within its time (`treasuriesOf`).
    method: "GET", path: "/api/setup", access: "session",
    async handle({ account }, { platform, requests }) {
      if (!requests(account!)) return refused(429, "rate_limited");
      const listed = await platform.consents.list(organizationOf(account!));
      if (!listed.ok) { log("platform_consents_failed", { owner: account, ...failure(listed) }); return unavailable(); }
      const agents = await treasuriesOf(listed.value.consents, account!, platform);
      return agents ? ok({ account, agents }) : unavailable();
    },
  },
  {
    // The setup text the owner's wallet signs: a Treasury agent for their own Organization, for the platform's host.
    method: "POST", path: "/api/setup/text", access: "session",
    async handle({ account }, { platform, deployment, requests }) {
      if (!requests(account!)) return refused(429, "rate_limited");
      return withPlatformNonce(platform, account!, nonce => setupText({ host: platform.host, deployment, owner: account! }, nonce));
    },
  },
  {
    /**
     * The owner's signed setup, relayed once it's checked to be exactly the setup this server asks for now: the platform
     * reserves the Organization's Treasury agent and stores a setup consent that lets this server relay only its
     * creation. A lost answer submits the same signed body once more, as the platform asks; a setup found again answers
     * the same agent. It counts as a consent against the account's day, since the platform stores one. Recorded before
     * the platform is asked and after.
     */
    method: "POST", path: "/api/setup", access: "session",
    async handle({ body, account }, { platform, deployment, audit, consentsToday, requests }) {
      if (!requests(account!)) return refused(429, "rate_limited");
      const submission = parse(contract.consentSubmission, body);
      if (!submission) return refused(400, "bad_request");
      const checked = checkSetup(submission.message, { host: platform.host, deployment, owner: account! });
      if (!checked.ok) return refused(400, checked.code);
      if (!consentsToday(account!)) return refused(429, "rate_limited");
      const signedTextSha256 = sha256(submission.message);
      await audit.append({ who: account!, action: "setup", signedTextSha256, stage: "attempt" });
      let stored = await relay(() => platform.setup(submission), account!);
      if (!stored.ok && stored.kind === "unavailable") stored = await relay(() => platform.setup(submission), account!);
      if (!stored.ok) log("platform_setup_failed", { owner: account, ...failure(stored) });
      // 409 `owner_stopped`: the owner's wallet stop came after this text's nonce; a new text, and a new signature. Any
      // other 409: the owner's Treasury agent is already created, or the deployment can set up no more on this host. 403:
      // this host doesn't set agents up. 400: the text or signature wasn't accepted. The platform's limit: nothing was
      // done. Anything else may work later as is.
      const status = !stored.ok && "status" in stored ? stored.status : undefined;
      const reply = stored.ok ? ok({ agent: stored.value.agent })
        : stored.kind === "refused" && stored.code === "owner_stopped" ? refused(409, "owner_stopped")
        : status === 409 ? refused(409, "already_set_up") : status === 403 ? refused(403, "setup_unavailable")
        : status === 400 ? refused(400, "setup_refused") : !stored.ok && stored.kind === "rate_limited" ? platformLimited() : unavailable();
      await recordResult(audit, { who: account!, action: "setup", signedTextSha256, stage: "result",
        ...(stored.ok && { agent: stored.value.agent, subject: stored.value.consent.id }), answer: audited(stored, reply) });
      return reply;
    },
  },
  {
    /**
     * A DAO's Treasury setup, for one of its members: the agents its consents under the DAO's Organization name, set up
     * or created, and its setup while one waits for the vote, read from the platform first (`settle`): a read after the
     * vote passed reserves the agent and closes it. One that closed without an agent says why (`ended`).
     */
    method: "GET", path: "/api/setup/dao/:dao", access: "session",
    async handle({ account, params }, context) {
      const member = await daoMember(account!, params.dao!, context);
      if ("status" in member) return member;
      const organization = organizationOf(member.owner), open = context.daoRequests.setup(organization);
      const settled = open && await context.settle(open);
      const listed = await context.platform.consents.list(organization);
      if (!listed.ok) { log("platform_consents_failed", { dao: member.owner, ...failure(listed) }); return unavailable(); }
      const agents = await treasuriesOf(listed.value.consents, member.owner, context.platform);
      if (!agents) return unavailable();
      if (settled?.result === "reserved" && !agents.includes(settled.agent)) agents.push(settled.agent);
      const request = open && settled?.result === "pending" ? await daoView(open, member, context) : null;
      const ended = !request && !agents.length ? context.daoRequests.setupEnded(organization) : undefined;
      return ok({ account, access: member.access, agents, request, ...(ended && { ended }) });
    },
  },
  {
    /**
     * Files a DAO's Treasury setup for its vote, for a member whose role may file the DAO's proposals: the setup text
     * names the DAO's Organization and is good for the DAO's voting period. Once per DAO at a time (`fileDao`); a DAO
     * whose consents already name an agent isn't set up again.
     */
    method: "POST", path: "/api/setup/dao/:dao", access: "session",
    async handle({ account, params }, context) {
      const member = await daoMember(account!, params.dao!, context);
      if ("status" in member) return member;
      if (!mayCall(member.access, "owner/prepare")) return refused(403, "not_permitted");
      const listed = await context.platform.consents.list(organizationOf(member.owner));
      if (!listed.ok) { log("platform_consents_failed", { dao: member.owner, ...failure(listed) }); return unavailable(); }
      const agents = await treasuriesOf(listed.value.consents, member.owner, context.platform);
      if (!agents) return unavailable();
      if (agents.length) return refused(409, "already_set_up");
      return fileDao({ kind: "setup" }, account!, member, context);
    },
  },
  {
    /**
     * Prepares the agent's creation under its setup consent, which reaches nothing else: a wallet owner signs it on the
     * platform's confirm page, with the key that signed the setup (the platform refuses any other); a DAO's member files
     * the proposal for the DAO's vote, with a vote on it if their role votes. The owner may leave one unsigned: it
     * expires in minutes. The platform's refusal is `creation_refused`, its text logged; one cause is a creation still
     * waiting for its signature or vote. Recorded before the platform is asked and after.
     */
    method: "POST", path: "/api/agents/:agent/creation", access: "owner-fresh", needs: "file",
    async handle({ account, identity }, { platform, audit }) {
      const { agent, owner, signer, access } = identity!;
      if (identity!.agentId !== null) return refused(409, "already_created");
      const organization = organizationOf(owner);
      let input: Parameters<Platform["creation"]["prepare"]>[2];
      if (signer === "wallet") {
        const listed = await platform.consents.list(organization);
        if (!listed.ok) { log("platform_consents_failed", { agent, ...failure(listed) }); return unavailable(); }
        const publicKey = setupConsents(listed.value.consents, owner, agent)[0]?.publicKey;
        if (typeof publicKey !== "string") return refused(409, "not_set_up");
        input = { action: { type: "agent_create", role: "treasury", owner: { type: "near", account_id: owner, public_key: publicKey } }, signer: "wallet" };
      } else input = { action: { type: "agent_create", role: "treasury" }, signer: "dao" };
      await audit.append({ who: account!, action: "create", agent, stage: "attempt" });
      const prepared = await relay(() => platform.creation.prepare(organization, agent, input), agent);
      let reply: Reply;
      if (prepared.ok) {
        const { correlationId, expiresAt, confirm, dao } = prepared.value;
        const transaction = dao && parse(contract.memberTransaction, access.canVote && dao.proposalAndVote ? dao.proposalAndVote : dao.proposal);
        reply = signer === "wallet" && confirm ? ok({ correlationId, expiresAt, confirm: { url: confirm.url, expiresAt: confirm.expiresAt } })
          : signer === "dao" && transaction ? ok({ correlationId, expiresAt, dao: { transaction } }) : unavailable();
        if (reply.status !== 200) log("platform_creation_unreadable", { agent, correlationId });
      } else {
        log("platform_creation_failed", { agent, ...failure(prepared) });
        // 403: no live setup consent covers it, or it names another key: the owner sets up again. A refusal (its text
        // logged): the platform's reason, such as another creation still waiting for its signature or vote.
        reply = prepared.kind === "forbidden" ? refused(409, "not_set_up")
          : prepared.kind === "refused" ? refused(409, "creation_refused") : prepared.kind === "rate_limited" ? platformLimited() : unavailable();
      }
      await recordResult(audit, { who: account!, action: "create", agent, stage: "result",
        ...(prepared.ok && { subject: prepared.value.correlationId }), answer: audited(prepared, reply) });
      return reply;
    },
  },
  {
    // Where the agent's creation stands, by the correlation ID its preparation answered.
    method: "GET", path: "/api/agents/:agent/creation/:id", access: "owner", needs: "read",
    async handle({ identity, params }, { platform }) {
      const reply = await ownerStatus(identity!, params.id, platform.creation.status, { missing: "no_creation", forbidden: "not_set_up" });
      // A settled creation may have changed the agent's identity. Read it fresh so the next page sees the current ID
      // rather than the identity cached from before (`platform.ts`, a minute), without assuming the action succeeded.
      if (reply.body.ok && statusPhase(reply.body.value as z.output<typeof contract.creationStatus>) === "settled") await platform.identity(identity!.agent, { fresh: true });
      return reply;
    },
  },
  {
    method: "GET", path: "/api/agents/:agent", access: "owner", needs: "read",
    async handle({ identity }) {
      const { agent, owner, agentId, host, signer, account, access } = identity!;
      return ok({ agent, owner, agentId, host, signer, account, access });
    },
  },
  {
    // The agent's live consent for this deployment, read from the platform's list for the owner's Organization.
    method: "GET", path: "/api/agents/:agent/consent", access: "owner", needs: "read",
    async handle({ identity }, context) {
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const [live] = liveConsents(listed.value.consents, identity!);
      if (identity!.signer === "dao") return daoConnection(identity!, live, context);
      return ok({ consent: live ? shown(live) : null });
    },
  },
  {
    /**
     * The text the owner's wallet signs to connect the agent, built here from the agent's identity as the platform
     * answers it now, never from the browser. A wallet owner's text always carries `owner` (#135), whether or not the body asks
     * for it; `{ owner: true }` is still accepted, from an older page and for the upgrade. An agent already connected isn't
     * offered another signature, except to add `owner` to a connection without it (asked with `{ owner: true }`): the new
     * consent replaces the old once stored. For a DAO-owned agent, the consent is filed for the DAO's vote instead
     * (`fileDaoConsent`), once per agent at a time, and never with `owner`.
     */
    method: "POST", path: "/api/agents/:agent/consent/text", access: "owner-fresh", needs: "file",
    async handle({ body, account, identity }, context) {
      const { agentId } = identity!;
      const asked = parse(contract.consentRequest, body ?? {});
      if (asked === undefined || (asked.owner && identity!.signer === "dao")) return refused(400, "bad_request");
      if (agentId === null) return refused(409, "not_created");
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const live = liveConsents(listed.value.consents, identity!);
      if (live.length && !(asked.owner && !live.some(consent => withOwner(consent.scopes)))) return refused(409, "already_connected");
      if (identity!.signer === "wallet") {
        return withPlatformNonce(context.platform, identity!.agent, nonce => consentText({ identity: { ...identity!, agentId }, deployment: context.deployment, owner: true }, nonce));
      }
      return fileDao({ kind: "consent" }, account!, { ...identity!, agentId }, context);
    },
  },
  {
    /**
     * The owner's signed consent, relayed once it's checked to be exactly the consent this server asks for now. A lost
     * answer submits the same signed body once more; the owner is never asked to sign again for that. The attempt is
     * recorded before the platform is asked, and its result after. Once stored, the owner's older consents for the
     * agent are revoked, so a reconnect leaves one.
     */
    method: "POST", path: "/api/agents/:agent/consent", access: "owner-fresh", needs: "sign",
    async handle({ body, account, identity }, context) {
      const { platform, deployment, audit, consentsToday } = context;
      const { agent } = identity!;
      if (identity!.agentId === null) return refused(409, "not_created");
      const submission = parse(contract.consentSubmission, body);
      if (!submission) return refused(400, "bad_request");
      const checked = checkConsent(submission.message, { identity: identity!, deployment });
      if (!checked.ok) return refused(400, checked.code);
      if (!consentsToday(account!)) return refused(429, "rate_limited");
      const signedTextSha256 = sha256(submission.message);
      await audit.append({ who: account!, action: "consent", agent, signedTextSha256, stage: "attempt" });
      const submit = () => relay(() => platform.consents.submit(submission), agent);
      let stored = await submit();
      if (!stored.ok && stored.kind === "unavailable") stored = await submit();
      if (!stored.ok) log("platform_consent_failed", { agent, ...failure(stored) });
      // 400: not accepted. 409: the agent changed since the text was built, or the owner's wallet stop came after its
      // nonce (`owner_stopped`); either way a new text, and a new signature. 403: the platform says the signer doesn't own
      // the agent. The platform's limit: nothing was stored. Anything else (a proxy's 429 included) may work later as is.
      const reply = stored.ok ? ok({ consent: shown(stored.value.consent) })
        : stored.kind === "refused" && stored.status === 400 ? refused(400, "consent_refused")
        : stored.kind === "refused" && stored.code === "owner_stopped" ? refused(409, "owner_stopped")
        : stored.kind === "refused" && stored.status === 409 ? refused(409, "agent_changed")
        : stored.kind === "forbidden" ? notOwner() : stored.kind === "rate_limited" ? platformLimited() : unavailable();
      await recordResult(audit, { who: account!, action: "consent", agent, signedTextSha256, stage: "result",
        ...(stored.ok && { subject: stored.value.consent.id }), answer: audited(stored, reply) });
      if (stored.ok) {
        const listed = await platform.consents.list(organizationOf(identity!.owner));
        if (listed.ok) await revokeAll(liveConsents(listed.value.consents, identity!).filter(consent => consent.id !== stored.value.consent.id), account!, agent, context);
        else log("platform_consents_failed", { agent, ...failure(listed) });
      }
      return reply;
    },
  },
  {
    /**
     * Disconnects the agent: turns its autopilot off first, then revokes the owner's live consents for it, found in the
     * platform's list. Once disconnected, the owner has no page here to turn autopilot off, so a schedule that can't be
     * read, or isn't confirmed off, revokes nothing (`unavailable`, or `autopilot_not_stopped`). A consent ID from the
     * browser is never used, since the platform revokes any of the deployment's consents by ID. At most
     * `REVOKES_PER_REQUEST` a request; if any is left or fails, the answer is `unavailable` and trying again is safe.
     */
    method: "POST", path: "/api/agents/:agent/consent/revoke", access: "owner-fresh", needs: "sign",
    async handle({ account, identity }, context) {
      const { platform, audit } = context, { agent, owner } = identity!, organization = organizationOf(owner);
      const listed = await platform.consents.list(organization);
      if (!listed.ok) { log("platform_consents_failed", { agent, ...failure(listed) }); return unavailable(); }
      const live = liveConsents(listed.value.consents, identity!);
      if (live.length) {
        const schedule = await relay(() => platform.autopilot.status(organization, agent), agent);
        if (!schedule.ok) { log("platform_autopilot_failed", { agent, action: "status", ...failure(schedule) }); return unavailable(); }
        if (schedule.value.on) {
          await audit.append({ who: account!, action: "autopilot-off", agent, stage: "attempt" });
          const stopped = await relay(() => platform.autopilot.stop(organization, agent), agent);
          const reply = stopped.ok ? ok({}) : refused(409, "autopilot_not_stopped");
          await recordResult(audit, { who: account!, action: "autopilot-off", agent, stage: "result", answer: audited(stopped, reply) });
          if (!stopped.ok) { log("platform_autopilot_failed", { agent, action: "stop", ...failure(stopped) }); return reply; }
        }
      }
      const { revoked, complete } = await revokeAll(live, account!, agent, context);
      // Disconnected: nothing acts for the agent any more, so the tokens issued for it end with its consent.
      if (complete) await context.tokens.revokeAll(agent);
      return complete ? ok({ revoked }) : unavailable();
    },
  },
  {
    /**
     * A rebalance to the saved strategy, proposed for the owner (or the DAO) to approve, as `watch` proposes one: the
     * strategy's legs, open for a day. The page names the `requestId`, so after a lost answer it finds the proposal by it
     * (`…/requests/:id`) rather than asking again; the platform keeps one proposal per `requestId`. Recorded before the
     * platform is asked and after. Nothing executes until it's approved.
     */
    method: "POST", path: "/api/agents/:agent/proposals", access: "owner-fresh", needs: "propose",
    async handle({ body, account, actor, identity }, { platform, audit }) {
      const { agent, owner } = identity!, who = actor ?? account!;
      const input = parse(contract.rebalanceRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      await audit.append({ who, action: "propose", agent, stage: "attempt" });
      const made = await relay(() => platform.proposals.create(organizationOf(owner), agent, { requestId: input.requestId, legs: "strategy",
        expiresAt: new Date(Date.now() + REBALANCE_HOURS * 3_600_000).toISOString(), note: actor ? "Asked for by the owner's agent" : "Asked for on the proposals page" }), agent);
      const reply = made.ok ? ok({ proposal: made.value }) : proposalFailure(made, agent);
      await recordResult(audit, { who, action: "propose", agent, subject: made.ok ? made.value.id : undefined, stage: "result", answer: audited(made, reply) });
      return reply;
    },
  },
  {
    /**
     * Issues a token for software that acts for the owner (#139), for this agent and a lifetime the owner picks (at most 30
     * days). Answered once: only its hash is kept. Issued by whoever may propose for the agent, from their session; a token
     * can't issue another. Recorded before and after.
     */
    method: "POST", path: "/api/agents/:agent/tokens", access: "owner-fresh", needs: "propose",
    async handle({ body, account, identity }, { audit, tokens }) {
      const { agent } = identity!;
      const input = parse(contract.tokenRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      await audit.append({ who: account!, action: "token-issue", agent, stage: "attempt" });
      const issued = await tokens.issue({ agent, account: account!, days: input.days, ...(input.label && { label: input.label }) }).catch(() => undefined);
      const reply = issued === undefined ? unavailable() : issued === null ? refused(409, "too_many_tokens") : ok({ token: issued.token, view: tokenShown(issued.view) });
      await recordResult(audit, { who: account!, action: "token-issue", agent, ...(issued && { subject: issued.view.id }), stage: "result", answer: reply.body.ok ? { ok: true } : { ok: false, kind: "refused", code: "code" in reply.body ? reply.body.code : "unavailable" } });
      return reply;
    },
  },
  {
    // The agent's live tokens, never their secrets: when each was made, lapses and was last used.
    method: "GET", path: "/api/agents/:agent/tokens", access: "owner", needs: "read",
    handle: async ({ identity }, { tokens }) => ok(tokens.list(identity!.agent).map(tokenShown)),
  },
  {
    // Revokes one token. It holds from the next call, since every call reads the records.
    method: "POST", path: "/api/agents/:agent/tokens/:id/revoke", access: "owner-fresh", needs: "propose",
    async handle({ account, identity, params }, { audit, tokens }) {
      const { agent } = identity!;
      if (!/^[a-f0-9]{16}$/.test(params.id ?? "")) return refused(400, "bad_request");
      await audit.append({ who: account!, action: "token-revoke", agent, subject: params.id, stage: "attempt" });
      const done = await tokens.revoke(agent, params.id!).catch(() => undefined);
      const reply = done === undefined ? unavailable() : done ? ok({}) : refused(404, "no_token");
      await recordResult(audit, { who: account!, action: "token-revoke", agent, subject: params.id, stage: "result", answer: reply.body.ok ? { ok: true } : { ok: false, kind: "refused", code: "code" in reply.body ? reply.body.code : "unavailable" } });
      return reply;
    },
  },
  {
    // What a token may call, from this server's own schemas, so software that holds one needs nothing else to use it.
    method: "GET", path: "/api/agent-api", access: "public",
    handle: async () => ok(agentApi()),
  },
  {
    // The agent's proposals, under the owner's own Organization: an owner reaches only proposals made under their consent.
    method: "GET", path: "/api/agents/:agent/proposals", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const listed = await platform.proposals.list(organizationOf(identity!.owner), identity!.agent);
      return listed.ok ? ok({ proposals: listed.value.proposals }) : proposalFailure(listed, identity!.agent);
    },
  },
  {
    // The DAO requests waiting for a vote on this agent: its consent, and its verdicts on proposals (#130). Answered from
    // this server's own requests, so it costs the platform nothing; the DAO's state is read for each one's offer, as a
    // proposal's read does. Nothing is settled here: the server's pass every minute already does. A wallet owner has none.
    method: "GET", path: "/api/agents/:agent/dao-requests", access: "owner", needs: "read",
    async handle({ identity }, context) {
      if (identity!.signer !== "dao") return ok({ requests: [] });
      const organization = organizationOf(identity!.owner), { agent } = identity!;
      const open = context.daoRequests.open().filter((request): request is StoredAgentRequest => request.kind !== "setup" && request.organization === organization && request.agent === agent);
      const views = await Promise.all(open.map(async request => {
        const view = await daoView(request, identity!, context);
        return view && { ...view, kind: request.kind, ...(request.kind === "vote" && { proposal: request.proposal }) };
      }));
      return ok({ requests: views.filter(view => view !== null).sort((a, b) => a.votingUntil - b.votingUntil) });
    },
  },
  {
    // For a DAO-owned agent, also the DAO's vote on it while one waits, read first (`settle`): a read after the vote
    // passed relays it, so the proposal read next shows its verdict.
    method: "GET", path: "/api/agents/:agent/proposals/:id", access: "owner", needs: "read",
    async handle({ identity, params }, context) {
      const id = parse(proposalId, params.id);
      if (!id) return refused(400, "bad_request");
      const organization = organizationOf(identity!.owner), { agent } = identity!;
      const open = identity!.signer === "dao" ? context.daoRequests.vote(organization, agent, id) : undefined;
      const waiting = open && (await context.settle(open)).result === "pending" ? open : undefined;
      const read = await context.platform.proposals.get(organization, agent, id);
      if (!read.ok) return proposalFailure(read, agent);
      return ok({ proposal: read.value, ...(identity!.signer === "dao" && { vote: waiting ? await daoView(waiting, identity!, context) : null }) });
    },
  },
  readRoute("/api/agents/:agent/account", "account"),
  readRoute("/api/agents/:agent/overview", "overview"),
  {
    // The diversified book (#221): one overview read, the caps from the agent's configured mandate terms when `watch` has
    // them, else marked as the profile's defaults or absent. Nothing here acts: the page only shows it.
    method: "GET", path: "/api/agents/:agent/diversification", access: "owner", needs: "read",
    async handle({ identity }, { platform, ballastSettings }) {
      const { agent, owner } = identity!;
      const organization = organizationOf(owner);
      const answer = await relay(() => platform.reads.overview(organization, agent), agent);
      return answer.ok ? ok(diversificationView(answer.value, ballastSettings?.(organization, agent))) : readFailure(answer, agent, "overview");
    },
  },
  {
    // The hedge plan (#221): NEAR Intents' token list against the registry, and the moves into gold and other chains' assets
    // from the agent's book, each executable or blocked with every reason. One overview read, the token list (cached) and a
    // few dry quotes; nothing here proposes or signs.
    method: "GET", path: "/api/agents/:agent/hedge", access: "owner", needs: "read",
    async handle({ identity, account, actor }, { platform, ballastSettings, intents, latestRisk }) {
      const { agent, owner } = identity!;
      const organization = organizationOf(owner);
      const answer = await relay(() => platform.reads.overview(organization, agent), agent);
      if (!answer.ok) return readFailure(answer, agent, "overview");
      const built = await buildHedge({ intents, latestRisk }, { who: actor ?? account!, organization, agent, overview: answer.value, settings: ballastSettings?.(organization, agent) });
      return ok(built.read);
    },
  },
  {
    /**
     * One hedge move proposed for the owner (or the DAO) to approve, as a rebalance is: the plan is made again here and the
     * swap built from it, so nothing the browser sends but the move's id and a `requestId` it names is trusted, and a move
     * that isn't executable now (not listed on the platform, no fresh quote, over a cap) is refused. The platform keeps one
     * proposal per `requestId`, so after a lost answer the page finds it by `…/requests/:id`. Recorded before the platform is
     * asked and after; nothing executes until the owner approves the exact swap with their own signature.
     */
    method: "POST", path: "/api/agents/:agent/hedge/propose", access: "owner-fresh", needs: "propose",
    async handle({ body, account, actor, identity }, { platform, audit, ballastSettings, intents, latestRisk }) {
      const { agent, owner } = identity!, who = actor ?? account!;
      const input = parse(contract.hedgeProposeRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      const organization = organizationOf(owner);
      const overview = await relay(() => platform.reads.overview(organization, agent), agent);
      if (!overview.ok) return readFailure(overview, agent, "overview");
      const built = await buildHedge({ intents, latestRisk }, { who, organization, agent, overview: overview.value, settings: ballastSettings?.(organization, agent) });
      const move = built.read.plan?.moves.find(m => m.id === input.move), swap = built.legs.get(input.move);
      if (!move || !move.canPropose || !swap) return refused(409, "move_not_available");
      await audit.append({ who, action: "propose", agent, subject: input.move, stage: "attempt" });
      const made = await relay(() => platform.proposals.create(organization, agent, { requestId: input.requestId, legs: [swap],
        expiresAt: new Date(Date.now() + REBALANCE_HOURS * 3_600_000).toISOString(),
        note: `Hedge: move ${move.sizeUsd} USD of ${move.from} into ${move.to} through NEAR Intents`.slice(0, 280) }), agent);
      const reply = made.ok ? ok({ proposal: made.value }) : proposalFailure(made, agent);
      await recordResult(audit, { who, action: "propose", agent, subject: made.ok ? made.value.id : input.move, stage: "result", answer: audited(made, reply) });
      return reply;
    },
  },
  readRoute("/api/agents/:agent/activity", "activity"),
  {
    // The agent's ledger as a CSV download (#136): relayed once as the platform wrote it.
    method: "GET", path: "/api/agents/:agent/activity.csv", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.reads.ledgerCsv(organizationOf(owner), agent), agent);
      return answer.ok ? { status: 200, body: { ok: true, value: null }, csv: { filename: `${agent}-activity.csv`, text: answer.value } } : readFailure(answer, agent, "ledgerCsv");
    },
  },
  {
    // The owner's actions and where each stands (#136), as the platform records them: across devices, never the audit file.
    method: "GET", path: "/api/agents/:agent/owner/actions", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.reads.ownerActions(organizationOf(owner), agent), agent);
      return answer.ok ? ok(answer.value) : readFailure(answer, agent, "owner/actions");
    },
  },
  readRoute("/api/agents/:agent/held", "held"),
  readRoute("/api/agents/:agent/unresolved", "unresolved"),
  readRoute("/api/agents/:agent/runs", "runs"),
  readRoute("/api/agents/:agent/policy-history", "policyHistory"),
  {
    // The stabilization agent's latest assessment (#220), as the audit log recorded it: its level, projection, scenarios
    // and recommendations, with the time and sequence number it was written at. Nothing is computed on request and the
    // platform isn't read: the record is the one a watch tick made, and a replay of the log makes it again. Read anew
    // (`owner-fresh`), since this server's own record is what the answer is.
    method: "GET", path: "/api/agents/:agent/risk", access: "owner-fresh", needs: "read",
    async handle({ identity }, { latestRisk }) {
      const { agent, owner } = identity!;
      if (!latestRisk) return ok({ risk: null });
      const found = await relay(async () => ({ ok: true as const, value: await latestRisk(organizationOf(owner), agent) }), agent);
      return found.ok ? ok({ risk: found.value ? riskReportOf(found.value) : null }) : readFailure(found, agent, "risk");
    },
  },
  {
    // The account linked to fund the agent, with its balances and, for a DAO, its members: null when none is linked.
    method: "GET", path: "/api/agents/:agent/treasury", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.funding.treasury(organizationOf(owner), agent), agent);
      return answer.ok ? ok({ treasury: answer.value }) : readFailure(answer, agent, "treasury/get");
    },
  },
  {
    /**
     * A fresh one-time deposit address for USDC, or for NEAR (wrapped, so wNEAR). Asking again gives another address,
     * so a lost answer is safe to ask again for; an address is never reused. Recorded before the platform is asked and after.
     */
    method: "POST", path: "/api/agents/:agent/deposit", access: "owner-fresh", needs: "deposit",
    async handle({ body, account, identity }, { platform, audit }) {
      const { agent, owner } = identity!;
      const input = parse(contract.depositRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      await audit.append({ who: account!, action: "deposit", agent, stage: "attempt" });
      const answer = await relay(() => platform.funding.deposit(organizationOf(owner), agent, DEPOSIT_ASSETS[input.asset]), agent);
      const reply = answer.ok ? ok({ deposit: answer.value }) : readFailure(answer, agent, "deposit");
      await recordResult(audit, { who: account!, action: "deposit", agent, subject: answer.ok ? answer.value.correlationId : undefined, stage: "result", answer: audited(answer, reply) });
      return reply;
    },
  },
  {
    // Per asset, the provider's balances against the chain and against recorded executions.
    method: "GET", path: "/api/agents/:agent/books", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.reads.books(organizationOf(owner), agent), agent);
      return answer.ok ? ok(answer.value) : readFailure(answer, agent, "reconcileBooks");
    },
  },
  {
    /**
     * A sweep, sent once and read to its end: a preview of the managed public balances, or their shielding into the
     * confidential balance (recorded before the platform is asked and after). Answered as the run's AG-UI events
     * (`contract.sweepRun`), whatever its outcome, so the page decides from what it reported. A call that throws before
     * any event is `unavailable`; no live consent before any event is `not_connected`.
     */
    method: "POST", path: "/api/agents/:agent/sweep", access: "owner-fresh", needs: "sweep",
    async handle({ body, account, identity }, { platform, audit }) {
      const { agent, owner } = identity!;
      const input = parse(contract.sweepRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      if (input.execute) await audit.append({ who: account!, action: "sweep", agent, stage: "attempt" });
      const run = await relay(() => platform.funding.sweep(organizationOf(owner), agent, input.execute), agent);
      const reply = !("events" in run) ? unavailable()
        : !run.events.length && run.ended?.kind === "forbidden" ? refused(409, "not_connected")
        : ok({ events: sweepEvents(agent, run) });
      const ended = "events" in run ? run.ended : run;
      if (ended && ended.kind !== "forbidden") log("platform_sweep_ended", { agent, execute: input.execute, ...failure(ended) });
      if (input.execute) await recordResult(audit, { who: account!, action: "sweep", agent, stage: "result", answer: audited(ended ?? { ok: true }, reply) });
      return reply;
    },
  },
  {
    // The saved strategy, whether the held grant binds it, and whether the schedule may be turned on.
    method: "GET", path: "/api/agents/:agent/strategy", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.autopilot.strategy(organizationOf(owner), agent), agent);
      return answer.ok ? ok(answer.value) : readFailure(answer, agent, "strategy/get");
    },
  },
  {
    /**
     * Saves a strategy over the one the owner saw (`expectedDigest`), sent once and recorded before and after. The
     * platform turns autopilot off and the held grant no longer binds it, so the owner authorizes it next. A strategy
     * changed meanwhile is `strategy_changed`; any other refusal `strategy_refused` (its text logged); after a lost answer
     * the page reads the strategy again before anything else.
     */
    method: "POST", path: "/api/agents/:agent/strategy", access: "owner-fresh", needs: "save",
    async handle({ body, account, identity }, context) {
      const input = parse(contract.strategySaveRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      return saveStrategy(context, identity!, { who: account!, action: "strategy-save" }, input);
    },
  },
  {
    // Whether questions are answered here, and by which model: the page shows the assistant only where they are.
    method: "GET", path: "/api/assistant", access: "session",
    handle: async (_, { assistant }) => ok({ available: Boolean(assistant), model: assistant?.model ?? null }),
  },
  {
    /**
     * A question to the treasury assistant (#219), answered from this agent's records through typed reads, each figure
     * cited by its source. It can draft, never send: a draft is fields for one of the page's review flows. The account's
     * questions an hour and the assistant's platform reads an hour are limited (`rate_limited`, `platform_budget`), and
     * every question, tool call and draft is recorded in the audit log by its hashes. An agent's token can't ask.
     */
    method: "POST", path: "/api/agents/:agent/assistant", access: "owner", needs: "read",
    async handle({ body, identity, account }, { assistant, auditLog, platform, daoRequests, strategyProposals }) {
      if (!assistant) return refused(503, "assistant_not_configured");
      const input = parse(contract.assistantRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      const { agent, owner, signer } = identity!;
      const asked = await assistant.ask({ who: account!, question: input.question, history: input.history,
        scope: { platform, organization: organizationOf(owner), agent, signer, daoRequests, strategyProposals, ...(auditLog && { auditLog }) } });
      if (asked.ok) return ok(asked.value);
      return asked.kind === "unavailable" ? unavailable() : refused(429, asked.kind);
    },
  },
  {
    // The strategies agents proposed for the agent and the owner hasn't answered (#206), from this server's own records.
    method: "GET", path: "/api/agents/:agent/strategy-proposals", access: "owner", needs: "read",
    handle: async ({ identity }, { strategyProposals }) => ok(strategyProposals.open(identity!.agent)),
  },
  {
    /**
     * A strategy proposed by software holding one of the agent's tokens (#206), for the owner to adopt or decline: checked
     * against the Strategy page's bounds and the policy's assets (one `overview` read), then stored and recorded by the
     * token. A token's next proposal supersedes its open one. The owner changes the strategy themselves, so a session's
     * call is refused (`token_only`).
     */
    method: "POST", path: "/api/agents/:agent/strategy-proposals", access: "owner-fresh", needs: "propose",
    async handle({ body, identity, viaToken }, { platform, strategyProposals }) {
      if (!viaToken) return refused(403, "token_only");
      const { agent, owner } = identity!;
      const input = parse(contract.strategyProposalRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      const overview = await relay(() => platform.reads.overview(organizationOf(owner), agent), agent);
      if (!overview.ok) return readFailure(overview, agent, "overview");
      const policy = overview.value.policy.policy;
      if (!policy) return refused(409, "policy_not_in_force");
      const proposed = await strategyProposals.propose({ agent, from: `token:${viaToken.id}`, strategy: input.strategy, reasons: input.reasons,
        against: input.expectedDigest, policyAssets: policy.assets }).catch(() => undefined);
      return proposed === undefined ? unavailable() : proposed.ok ? ok({ id: proposed.id })
        : "full" in proposed ? refused(409, "too_many_proposals") : refused(409, "strategy_not_allowed");
    },
  },
  {
    /**
     * Adopts a proposed strategy: saved over the strategy it was compared against, by that one's digest, as the owner's
     * own save is. The page then asks for the grant that binds it (`/grant`, with the digest answered): saving comes
     * first, since the grant binds the saved strategy's digest. A strategy saved since it was proposed refuses it
     * (`strategy_changed`) and closes it: its source proposes again against the new one.
     */
    method: "POST", path: "/api/agents/:agent/strategy-proposals/:id/adopt", access: "owner-fresh", needs: "save",
    async handle({ account, identity, params }, context) {
      const { agent } = identity!;
      const proposal = context.strategyProposals.find(agent, params.id ?? "");
      if (!proposal) return refused(404, "no_proposal");
      const reply = await saveStrategy(context, identity!, { who: account!, action: "strategy-adopt", subject: proposal.id },
        { strategy: proposal.strategy, expectedDigest: proposal.against });
      const code = "code" in reply.body ? reply.body.code : undefined;
      if (reply.body.ok || code === "strategy_changed")
        await context.strategyProposals.close(agent, proposal.id, reply.body.ok ? "adopted" : "superseded").catch(error => log("strategy_proposal_unclosed", { agent, id: proposal.id, error: String(error) }));
      return reply;
    },
  },
  {
    // Declines a proposed strategy: closed, and recorded. Its source doesn't propose the same strategy again (#206).
    method: "POST", path: "/api/agents/:agent/strategy-proposals/:id/decline", access: "owner-fresh", needs: "save",
    async handle({ account, identity, params }, { audit, strategyProposals }) {
      const { agent } = identity!;
      if (!strategyProposals.find(agent, params.id ?? "")) return refused(404, "no_proposal");
      await audit.append({ who: account!, action: "strategy-decline", agent, subject: params.id, stage: "attempt" });
      const done = await strategyProposals.close(agent, params.id!, "declined").catch(() => undefined);
      const reply = done === undefined ? unavailable() : done ? ok({}) : refused(404, "no_proposal");
      await recordResult(audit, { who: account!, action: "strategy-decline", agent, subject: params.id, stage: "result", answer: reply.body.ok ? { ok: true } : { ok: false, kind: "refused", code: "code" in reply.body ? reply.body.code : "unavailable" } });
      return reply;
    },
  },
  {
    // The schedule: on or off, its interval and ceiling, its last and next runs.
    method: "GET", path: "/api/agents/:agent/autopilot", access: "owner", needs: "read",
    async handle({ identity }, { platform }) {
      const { agent, owner } = identity!;
      const answer = await relay(() => platform.autopilot.status(organizationOf(owner), agent), agent);
      return answer.ok ? ok(answer.value) : readFailure(answer, agent, "autopilot/get");
    },
  },
  {
    /**
     * Prepares a grant binding the saved strategy the owner saw, once it's read again: refused, with nothing prepared,
     * if the strategy changed (`strategy_changed`), autopilot is on (`autopilot_on`, as the owner turns it off first),
     * the host only approves (`approve_only`), or a grant is already waiting for its vote or outcome (`grant_pending`,
     * followed rather than signed twice). A wallet's grant only prepared doesn't wait: nothing signed it. A wallet owner's connection must allow owner actions
     * (`owner_not_allowed`); a DAO's grant is filed for its vote, which must pass before it expires, in minutes.
     * Recorded before the platform is asked and after.
     */
    method: "POST", path: "/api/agents/:agent/grant", access: "owner-fresh", needs: "file",
    async handle({ body, account, identity }, { platform, audit }) {
      const { agent, owner, signer, access } = identity!, organization = organizationOf(owner);
      const input = parse(contract.grantRequest, body);
      if (input === undefined) return refused(400, "bad_request");
      const strategy = await relay(() => platform.autopilot.strategy(organization, agent), agent);
      if (!strategy.ok) return readFailure(strategy, agent, "strategy/get");
      if (strategy.value.digest !== input.expectedDigest) return refused(409, "strategy_changed");
      if (strategy.value.on) return refused(409, "autopilot_on");
      if (!strategy.value.executor) return refused(409, "approve_only");
      const actions = await relay(() => platform.grant.actions(organization, agent), agent);
      if (!actions.ok) return readFailure(actions, agent, "owner/actions");
      const now = Date.now();
      // A grant awaiting its outcome is followed rather than signed twice. A wallet's grant takes effect only by its submit
      // here, so one only prepared holds nothing: its wallet may have refused the signature.
      if (actions.value.some(action => holdsEach("grant_issue", action.type) && awaiting(action, now))) return refused(409, "grant_pending");
      if (signer === "wallet") {
        const allowed = await ownerAllowed(platform, organization, identity!, agent);
        if (allowed === "unavailable") return unavailable();
        if (!allowed) return refused(409, "owner_not_allowed");
      }
      await audit.append({ who: account!, action: "grant", agent, stage: "attempt" });
      const prepared = await relay(() => platform.grant.prepare(organization, agent,
        { action: { type: "grant_issue", label: "treasury", expectedStrategyDigest: input.expectedDigest }, signer }), agent);
      const reply = preparedReply(prepared, { signer, access, agent, what: "grant", refusal: "grant_refused" });
      await recordResult(audit, { who: account!, action: "grant", agent, ...(prepared.ok && { subject: prepared.value.correlationId }), stage: "result", answer: audited(prepared, reply) });
      return reply;
    },
  },
  {
    /**
     * A wallet owner's signature over the grant's intent, relayed once and recorded before and after. After a lost
     * answer the page follows the grant's status rather than sending it again.
     */
    method: "POST", path: "/api/agents/:agent/grant/:id/submit", access: "owner-fresh", needs: "sign",
    async handle({ body, account, identity, params }, { platform, audit }) {
      const { agent, owner } = identity!;
      const input = parse(contract.grantSubmission, body);
      if (input === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(params.id ?? "")) return refused(400, "bad_request");
      await audit.append({ who: account!, action: "grant-submit", agent, subject: params.id, stage: "attempt" });
      const submitted = await relay(() => platform.owner.submit(organizationOf(owner), agent, { correlationId: params.id!, signedData: input.signedData }), agent);
      const reply = submitted.ok ? ok({ status: submitted.value.status, failureCode: submitted.value.failureCode ?? null })
        : submitted.kind === "forbidden" ? refused(409, "owner_not_allowed")
        : submitted.kind === "refused" && submitted.status === 404 ? refused(404, "no_grant")
        : submitted.kind === "refused" ? refused(409, "grant_refused") : submitted.kind === "rate_limited" ? platformLimited() : unavailable();
      if (!submitted.ok) log("platform_grant_submit_failed", { agent, ...failure(submitted) });
      await recordResult(audit, { who: account!, action: "grant-submit", agent, subject: params.id, stage: "result", answer: audited(submitted, reply) });
      return reply;
    },
  },
  {
    // Where a grant stands, by the correlation ID its preparation answered.
    method: "GET", path: "/api/agents/:agent/grant/:id", access: "owner", needs: "read",
    handle: ({ identity, params }, { platform }) => ownerStatus(identity!, params.id, platform.owner.status, { missing: "no_grant", forbidden: "not_connected" }),
  },
  ownerActionRoute("/api/agents/:agent/freeze", "freeze", bare("agent_freeze")),
  ownerActionRoute("/api/agents/:agent/unfreeze", "unfreeze", bare("agent_unfreeze")),
  ownerActionRoute("/api/agents/:agent/grants/revoke", "grant-revoke", revocation),
  ownerActionRoute("/api/agents/:agent/policy", "policy-update", policyEdit),
  {
    /**
     * A wallet owner's signature over an owner action's intent (#133; the grant's has its own route), relayed once and
     * recorded before and after, whichever action it is. After a lost answer the page follows the action's status
     * rather than sending it again.
     */
    method: "POST", path: "/api/agents/:agent/owner/actions/:id/submit", access: "owner-fresh", needs: "sign",
    async handle({ body, account, identity, params }, { platform, audit }) {
      const { agent, owner } = identity!;
      const input = parse(contract.ownerActionSubmission, body);
      if (input === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(params.id ?? "")) return refused(400, "bad_request");
      await audit.append({ who: account!, action: "owner-submit", agent, subject: params.id, stage: "attempt" });
      const submitted = await relay(() => platform.owner.submit(organizationOf(owner), agent, { correlationId: params.id!, signedData: input.signedData }), agent);
      const reply = submitted.ok ? ok({ status: submitted.value.status, failureCode: submitted.value.failureCode ?? null })
        : submitted.kind === "forbidden" ? refused(409, "owner_not_allowed")
        : submitted.kind === "refused" && submitted.status === 404 ? refused(404, "no_action")
        : submitted.kind === "refused" ? refused(409, "action_refused") : submitted.kind === "rate_limited" ? platformLimited() : unavailable();
      if (!submitted.ok) log("platform_owner_submit_failed", { agent, ...failure(submitted) });
      await recordResult(audit, { who: account!, action: "owner-submit", agent, subject: params.id, stage: "result", answer: audited(submitted, reply) });
      return reply;
    },
  },
  {
    // Where an owner action stands, by the correlation ID its preparation answered.
    method: "GET", path: "/api/agents/:agent/owner/actions/:id", access: "owner", needs: "read",
    handle: ({ identity, params }, { platform }) => ownerStatus(identity!, params.id, platform.owner.status, { missing: "no_action", forbidden: "not_connected" }),
  },
  autopilotAction("/api/agents/:agent/autopilot/enable", "autopilot-on", "enable", contract.enableRequest,
    (platform, organization, agent, { expectedDigest }) => platform.autopilot.enable(organization, agent, expectedDigest), () => ({})),
  autopilotAction("/api/agents/:agent/autopilot/stop", "autopilot-off", "stop", z.strictObject({}),
    (platform, organization, agent) => platform.autopilot.stop(organization, agent), () => ({})),
  autopilotAction("/api/agents/:agent/autopilot/tick", "run-now", "tick", z.strictObject({}),
    (platform, organization, agent) => platform.autopilot.tick(organization, agent), value => ({ summary: value })),
  fundingChange("/api/agents/:agent/treasury/link", "link", contract.linkRequest,
    (platform, organization, agent, { accountId }) => platform.funding.link(organization, agent, accountId)),
  fundingChange("/api/agents/:agent/treasury/unlink", "unlink", contract.unlinkRequest,
    (platform, organization, agent) => platform.funding.unlink(organization, agent)),
  {
    // One recorded run of the autopilot, by its tick ID (`runs` lists them).
    method: "GET", path: "/api/agents/:agent/runs/:id", access: "owner", needs: "read",
    async handle({ identity, params }, { platform }) {
      const { agent, owner } = identity!, tick = readId(params.id);
      if (!tick) return refused(400, "bad_request");
      const answer = await relay(() => platform.reads.recording(organizationOf(owner), agent, tick), agent);
      if (answer.ok) return ok(answer.value);
      return answer.kind === "refused" && answer.status === 404 ? refused(404, "not_found") : readFailure(answer, agent, "recording");
    },
  },
  {
    /**
     * A proposal by the `requestId` it was proposed with, found among the agent's proposals: the platform has no lookup
     * by `requestId`. Read only: after a lost answer, a proposal is found here, never created again.
     */
    method: "GET", path: "/api/agents/:agent/requests/:id", access: "owner", needs: "read",
    async handle({ identity, params }, { platform }) {
      const { agent, owner } = identity!, requestId = readId(params.id);
      if (!requestId) return refused(400, "bad_request");
      const listed = await relay(() => platform.proposals.list(organizationOf(owner), agent), agent);
      if (!listed.ok) return proposalFailure(listed, agent);
      const found = listed.value.proposals.find(proposal => proposal.requestId === requestId);
      return found ? ok({ proposal: found }) : refused(404, "no_proposal");
    },
  },
  {
    /**
     * An operation's status by its `correlationId`, from its `activity` row: null until an outcome is recorded. Not
     * `owner/status`, which reports owner actions and answers `unknown` for any swap, which reads like an outcome in doubt.
     */
    method: "GET", path: "/api/agents/:agent/operations/:id", access: "owner", needs: "read",
    async handle({ identity, params }, { platform }) {
      const { agent, owner } = identity!, correlationId = readId(params.id);
      if (!correlationId) return refused(400, "bad_request");
      const answer = await relay(() => platform.reads.activity(organizationOf(owner), agent), agent);
      if (!answer.ok) return readFailure(answer, agent, "activity");
      const row = answer.value.find(item => item.correlationId === correlationId);
      return row ? ok({ correlationId, at: row.at, kind: row.kind, status: row.status ?? null, refused: row.refused ?? null }) : refused(404, "not_found");
    },
  },
  verdictRoute("approve"),
  verdictRoute("reject"),
  {
    /**
     * Asks for an approved proposal's execution, once per request. Any other state is answered from the fresh read,
     * with nothing sent: each execute re-quotes and spends the platform's quota. After a lost answer or a thrown call,
     * the proposal is read once and never asked to execute again; if that read goes unanswered too, the answer is
     * `pending` with no proposal. The platform claims a proposal once, so it never runs twice. Recorded before the
     * platform is asked and after.
     */
    method: "POST", path: "/api/agents/:agent/proposals/:id/execute", access: "owner-fresh", needs: "execute",
    async handle({ account, identity, params }, { platform, audit }) {
      const id = parse(proposalId, params.id);
      if (!id) return refused(400, "bad_request");
      const organization = organizationOf(identity!.owner), { agent } = identity!;
      const fresh = await relay(() => platform.proposals.get(organization, agent, id), agent);
      if (!fresh.ok) return proposalFailure(fresh, agent);
      if (fresh.value.state === "proposed") return refused(409, "not_approved");
      if (fresh.value.state !== "approved") return executed(outcomeOf(fresh.value.state), fresh.value);
      await audit.append({ who: account!, action: "execute", agent, subject: id, stage: "attempt" });
      const ran = await relay(() => platform.proposals.execute(organization, agent, id), agent);
      let reply: Reply;
      if (ran.ok) reply = executed(outcomeOf(ran.value.state), ran.value);
      else if (ran.kind === "forbidden") reply = refused(409, "not_connected");
      else if (ran.kind === "refused" && ran.code === "not_approved") reply = refused(409, "not_approved");
      else {
        // Refused before any claim, or the answer was lost: read the proposal, never ask for its execution again.
        const notExecutable = ran.kind === "refused" && ran.code === "not_executable";
        if (!notExecutable) log("platform_execute_unanswered", { agent, proposal: id, ...failure(ran as { kind: string }) });
        const now = await relay(() => platform.proposals.get(organization, agent, id), agent);
        reply = !now.ok ? executed("pending", null)
          : executed(notExecutable && now.value.state === "approved" ? "not_executable" : outcomeOf(now.value.state), now.value);
      }
      await recordResult(audit, { who: account!, action: "execute", agent, subject: id, stage: "result", answer: audited(ran, reply) });
      return reply;
    },
  },
];

/**
 * `account` as one of `dao`'s members, by the DAO's policy read at most a minute ago, for a route about a DAO with no
 * agent yet: counted against the account's requests, since it reads the chain and the platform. A failed read is
 * `unavailable`, never an admission; an account the policy names in no role is `not_owner`, as for an agent.
 */
async function daoMember(account: string, dao: string, { daos, platform, requests }: Context): Promise<Reply | DaoTarget & { access: contract.Access }> {
  if (!parse(contract.accountId, dao)) return refused(400, "bad_request");
  if (!requests(account)) return refused(429, "rate_limited");
  const policy = await daos.policy(dao);
  if (policy === "unavailable") { log("dao_policy_unavailable", { dao }); return unavailable(); }
  const access = memberAccess(account, dao, policy);
  return access ? { owner: dao, host: platform.host, access } : notOwner();
}

/** A token as the owner is shown it: times as ISO strings. */
const tokenShown = (view: { id: string; label: string; createdAt: number; expiresAt: number; lastUsedAt: number | null }) => ({ id: view.id, label: view.label,
  createdAt: new Date(view.createdAt).toISOString(), expiresAt: new Date(view.expiresAt).toISOString(), lastUsedAt: view.lastUsedAt === null ? null : new Date(view.lastUsedAt).toISOString() });

/** A schema as JSON Schema, or undefined when it can't be shown as one (an amount is a `bigint` string in the SDK's). */
const described = (schema: z.ZodType) => { try { return z.toJSONSchema(schema, { unrepresentable: "any", io: "output" }); } catch { return undefined; } };
/** The routes a token may call, with the schemas of what they answer and take (`GET /api/agent-api`). */
function agentApi() {
  const route = (call: (typeof TOKEN_ROUTES)[number], summary: string, response?: z.ZodType, request?: z.ZodType) => {
    const [method, path] = call.split(" ") as [string, string];
    return { method, path, summary, ...(request && { request: described(request) }), ...(response && { response: described(response) }) };
  };
  return {
    version: 1,
    authorization: "Send `Authorization: Bearer <token>`. A token is issued by the agent's owner from the app, for one agent and at most 30 days. Every route answers `{ ok: true, value }` or `{ ok: false, kind, code? }`.",
    routes: [
      route("GET /api/agents/:agent/overview", "The book against its targets, the policy and what is left of its budget", contract.overviewRead),
      route("GET /api/agents/:agent/activity", "Everything the agent did, and how each ended", contract.activityRead),
      route("GET /api/agents/:agent/unresolved", "Operations without a proven outcome", contract.unresolvedRead),
      route("GET /api/agents/:agent/strategy", "The saved strategy and whether the agent's grant binds it", contract.strategyRead),
      route("GET /api/agents/:agent/autopilot", "Whether autopilot is on, and its last run", contract.autopilotRead),
      route("GET /api/agents/:agent/proposals", "The agent's proposals", proposalList),
      route("GET /api/agents/:agent/proposals/:id", "One proposal", contract.proposalRead),
      route("POST /api/agents/:agent/proposals", "Proposes a rebalance to the saved strategy for the owner to approve or reject. Name a `requestId`: after a lost answer, ask again with the same one and the proposal made is returned, never a second", contract.rebalanceMade, contract.rebalanceRequest),
      route("POST /api/agents/:agent/strategy-proposals", "Proposes a strategy, with your reasons, for the owner to adopt or decline. Name the digest of the saved strategy you read (`GET …/strategy`): adopting it saves over that one, or not at all. Targets may name only the policy's assets (`strategy_not_allowed`). Your next proposal replaces your open one, so a lost answer is safe to send again", contract.strategyProposed, contract.strategyProposalRequest),
    ],
    refused: "Verdicts, execution, owner actions, funding, sweeps, strategy and autopilot changes and consents are not available to a token: the owner does those in the app, and adopts or declines the strategies a token proposes.",
  };
}

/** A route's parameters for `pathname`; `malformed` when a parameter's percent-encoding is broken. */
function match(route: Route, method: string, pathname: string): Record<string, string> | "malformed" | undefined {
  if (route.method !== method) return undefined;
  const want = route.path.split("/"), got = pathname.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(":")) {
      try { params[part.slice(1)] = decodeURIComponent(got[i]!); } catch { return "malformed"; }
    } else if (part !== got[i]) return undefined;
  }
  return params;
}

function tokenOf(req: IncomingMessage) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=") || undefined;
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; reply: Reply }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return { ok: false, reply: refused(413, "too_large") };
    chunks.push(chunk);
  }
  if (!size) return { ok: true, body: undefined };
  try { return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
  catch { return { ok: false, reply: refused(400, "bad_request") }; }
}

/**
 * Checks a call before its handler runs. A write must come from this server's own origin and carry JSON, unless it's a
 * DELETE without a body. A session route needs a live session. An owner route also needs the session's account to be
 * the agent's owner, as the platform answers it (within the last minute, or anew for `owner-fresh`; see `Access`),
 * because ownership can change: the platform's own checks prove this server may act for the agent, not that the person
 * in the browser owns it.
 *
 * Each owner-route request counts against the account's `ownerRequestsPerMinute`. Only a successful identity is reused,
 * so a reused answer that refuses the account names another owner: it's read once more anew, counted too, so a new
 * owner isn't locked out for a minute after a transfer.
 */
async function admit(route: Route, call: Call, deps: Deps, admissions: RateLimit): Promise<Reply | Admitted | undefined> {
  if (route.method !== "GET") {
    // A browser's write must come from this server's own page. A token's isn't a browser's: it carries a credential no page
    // can add to a request it didn't make, so there is no origin to check.
    if (!call.viaToken && call.req.headers.origin !== deps.publicOrigin) return refused(403, "origin");
    // A body must be JSON; a DELETE without one (sign-out) needs no content type.
    const bodyless = route.method === "DELETE" && call.body === undefined;
    if (!bodyless && !/^application\/json(;|$)/.test(call.req.headers["content-type"] ?? "")) return refused(415, "content_type");
  }
  if (route.access === "public") return undefined;
  if (!call.account) return fail(401, { ok: false, kind: "not_signed_in" });
  if (route.access === "session") return undefined;
  const agent = call.params.agent!;
  if (!parse(contract.agentName, agent)) return refused(400, "bad_request");
  // A token's calls are counted against the token (in the handler), not against the account that issued it: software
  // gone wrong must not lock the owner out of their own page.
  const within = (account: string) => call.viaToken ? true : admissions(account);
  if (!within(call.account)) return refused(429, "rate_limited");
  const first = await deps.platform.identity(agent, { fresh: route.access === "owner-fresh" });
  let decided = await decide(first.answer, agent, call.account, deps, first.cached);
  if (first.cached && "status" in decided && !decided.body.ok && decided.body.kind === "not_owner") {
    if (!within(call.account)) return refused(429, "rate_limited");
    decided = await decide((await deps.platform.identity(agent, { fresh: true })).answer, agent, call.account, deps, false);
  }
  if ("status" in decided) return decided;
  return mayCall(decided.access, NEEDS[route.needs]) ? decided : refused(403, "not_permitted");
}

/**
 * Whether `account` owns `agent` by the platform's answer, or for a DAO-owned agent is one of the DAO's members by its
 * policy (read at most a minute ago; a failed read is `unavailable`, never an admission). Only the platform's 404 (no such agent, or one this
 * deployment can't reach) means the agent isn't visible, and it gets the same answer as one someone else owns,
 * `not_owner`, so a signed-in stranger can't tell which agents exist. Any other failure says nothing about ownership and
 * is `unavailable`: the credential's hourly limit (429), a conflict (409), an outage, and a 403, which the platform
 * answers only to a request carrying browser headers, so it means this server is misconfigured. So does an identity
 * naming another deployment, since the platform only ever names the credential's own. Failures are logged when read,
 * never forwarded.
 */
async function decide(answer: IdentityAnswer, agent: string, account: string, deps: Deps, cached: boolean): Promise<Reply | Admitted> {
  if (!answer.ok) {
    if (!cached) log("platform_identity_failed", { agent, ...failure(answer) });
    return answer.kind === "refused" && answer.status === 404 ? notOwner() : unavailable();
  }
  if (answer.value.deployment !== deps.deployment) {
    log("deployment_mismatch", { agent, expected: deps.deployment, got: answer.value.deployment });
    return unavailable();
  }
  const { owner, agentId, host } = answer.value, signer = answer.value.signer ?? "wallet";
  let access: contract.Access | null;
  if (signer === "dao") {
    const policy = await deps.daos.policy(owner);
    if (policy === "unavailable") { log("dao_policy_unavailable", { agent, dao: owner }); return unavailable(); }
    access = memberAccess(account, owner, policy);
  } else access = accessOf(account, { account: owner, policy: null, signer: owner });
  return access ? { agent: answer.value.agent, owner, agentId, host, signer, account, access } : notOwner();
}

/** The server's request handler, built from its dependencies so tests can run it in-process with fakes. */
export function createServer(deps: Deps) {
  const admissions = createRateLimit({ limit: deps.ownerRequestsPerMinute });
  const tokenRequests = createRateLimit({ limit: deps.tokenRequestsPerHour ?? 60, windowMs: 3_600_000 });
  const tokenBudget = createRateLimit({ limit: deps.tokenBudgetPerHour ?? 300, windowMs: 3_600_000 });
  const context: Context = { ...deps, settle: deps.settle ?? createSettle(deps), tokens: deps.agentTokens ?? createAgentTokens(memoryTokenRecords()), strategyProposals: deps.strategyProposals ?? createStrategyProposals(memoryProposalRecords(), { audit: deps.audit }), consentsToday: createRateLimit({ limit: deps.consentsPerDay, windowMs: 86_400_000 }),
    daoFilingsToday: createRateLimit({ limit: deps.daoFilingsPerDay, windowMs: 86_400_000 }), filing: new Map(), requests: admissions };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = ({ status, body, cookie, csv }: Reply) => {
      if (csv) {
        // A file for the owner to keep: it is only ever offered as a download, never rendered as a page.
        res.writeHead(status, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${csv.filename}"`,
          "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(csv.text);
        return;
      }
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
        ...(cookie && { "set-cookie": cookie }),
      });
      // A `bigint` (the SDK's amounts) goes out as its exact decimal string: `JSON.stringify` would throw on one.
      res.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    };
    try {
      const { pathname } = new URL(req.url ?? "/", "http://server");
      const file = req.method === "GET" || req.method === "HEAD" ? deps.page?.(pathname) : undefined;
      if (file) {
        res.writeHead(200, { ...file.headers, "content-length": file.body.length });
        res.end(req.method === "HEAD" ? undefined : file.body);
        return;
      }
      let found: { route: Route; params: Record<string, string> } | undefined;
      for (const route of routes) {
        const params = match(route, req.method ?? "", pathname);
        if (params === "malformed") return send(refused(400, "bad_request"));
        if (params) { found = { route, params }; break; }
      }
      if (!found) return send(refused(404, "not_found"));
      const read = found.route.method === "GET" ? { ok: true as const, body: undefined } : await readBody(req);
      if (!read.ok) return send(read.reply);
      const token = tokenOf(req);
      let call: Call = { req, body: read.body, token, account: deps.sessions.account(token), params: found.params };
      // An agent's token (#139): only on the routes it may call, for the agent it was issued for, and counted on its own.
      if (req.headers.authorization !== undefined) {
        if (!TOKEN_ROUTES.includes(`${found.route.method} ${found.route.path}` as (typeof TOKEN_ROUTES)[number])) return send(refused(403, "token_not_allowed"));
        const presented = BEARER.exec(req.headers.authorization);
        const record = presented ? context.tokens.find(presented[1]!) : undefined;
        if (!record) return send(refused(401, "invalid_token"));
        if (found.params.agent !== record.agent) return send(refused(403, "token_not_allowed"));
        // Its own hourly limit, then the one all tokens share, so tokens never spend more than their part of the platform's budget.
        if (!tokenRequests(record.id) || !tokenBudget("tokens")) return send(refused(429, "rate_limited"));
        // Admitted as the account that issued it would be: still the agent's owner, or still a DAO member who may propose.
        call = { req, body: read.body, token: undefined, account: record.account, params: found.params, actor: `token:${record.id}`, viaToken: record };
      }
      const admitted = await admit(found.route, call, deps, admissions);
      if (admitted && "status" in admitted) return send(admitted);
      if (call.viaToken) void context.tokens.used(call.viaToken.id);
      send(await found.route.handle({ ...call, ...(admitted && { identity: admitted }) }, context));
    } catch (error) {
      log("internal_error", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path: req.url?.split("?")[0] });
      if (!res.headersSent) send(unavailable());
      else res.destroy();
    }
  };
}
