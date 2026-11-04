import type { IncomingMessage, ServerResponse } from "node:http";
import { mayCall, proposalId, proposalText, type ProposalView } from "@multiagency/sdk";
import { verifyNep413Signature } from "near-kit";
import type { z } from "zod";
import { sha256, type Audit, type AuditEntry } from "./audit.ts";
import { checkConsent, consentMessageFor, consentText, liveConsents, organizationOf } from "./consent.ts";
import { checkUrlOf, memberAccess, memoryDaoRequests, type DaoRequest, type DaoRequests, type PolicyReader } from "./dao.ts";
import type { KeyLookup } from "./keys.ts";
import type { Page } from "./page.ts";
import { checkOpen, checkVerdict, outcomeOf, type Verdict } from "./proposals.ts";
import * as contract from "./contract.ts";
import type { Identity } from "./contract.ts";
import type { ConsentRecord, IdentityAnswer, Platform, ProposalAnswer, ProposalListAnswer } from "./platform.ts";
import { createRateLimit, type RateLimit } from "./ratelimit.ts";
import type { Sessions } from "./sessions.ts";
import type { SignIn } from "./signin.ts";

export const COOKIE = "__Host-treasury_session";
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
   * New consents a signed-in account may relay a day. The platform caps a deployment's unexpired consents, revoked ones
   * included, across every owner, so one account reconnecting in a loop could otherwise fill it for all.
   */
  consentsPerDay: number;
  /** Whether a key is a full-access key of an account, as the chain answers: an owner's verdict must be signed with one. */
  keyLookup: KeyLookup;
  /** The proposals page, served at every GET and HEAD outside `/api/`; without it, the server answers only its API. */
  page?: Page;
  /**
   * A DAO's policy, read from the chain at most a minute ago: how a DAO-owned agent's members are told apart. Without
   * one, no DAO's member is admitted (every policy read is `unavailable`).
   */
  daoPolicy?: PolicyReader;
  /** The DAO requests this server filed and follows until they're final; in memory unless given. */
  daoRequests?: DaoRequests;
};
/** What a handler reads: the dependencies, and the limits the server keeps across requests. */
type Context = Deps & { consentsToday: RateLimit; daoPolicy: PolicyReader; daoRequests: DaoRequests };

/**
 * Who may call a route: anyone, a signed-in session, or the signed-in owner of the route's `:agent`. `owner` may use an
 * identity the platform answered within the last minute: for routes that forward to the platform, which checks the
 * owner again on every forwarded call (a consent is live only while its signer owns the agent). `owner-fresh` reads it
 * anew: for routes that answer from this server's own records, which nothing else re-checks, and for writes that build
 * on the agent's identity, where a stale one would be refused anyway.
 */
export type Access = "public" | "session" | "owner" | "owner-fresh";
/** A call as its handler sees it. `identity` is the agent's, as the owner check read it (see `Access`), on owner routes only. */
type Call = { req: IncomingMessage; body: unknown; token: string | undefined; account: string | undefined; params: Record<string, string>; identity?: Identity };
type Reply = { status: number; body: contract.Answer<unknown>; cookie?: string };
/** What a DAO member may have this app do, by the DAO's roles (`contract.member`). */
type Member = contract.Identity extends { member: infer M } ? NonNullable<M> : never;
/**
 * A route, and for a DAO-owned agent whether the signed-in member may call it (`member`). A route without `member` is
 * for wallet owners only, and a DAO's member is refused it as `dao_owner`: fail closed, so a new route reaches members
 * only once it says so. The platform admits this app under a DAO's consent, not the member: the gate is this server's.
 */
type Route = { method: "GET" | "POST" | "DELETE"; path: string; access: Access; member?: (member: Member) => boolean; handle(call: Call, context: Context): Promise<Reply> };
/**
 * A member gate by the SDK's own procedure map (`mayCall`), as the platform's owner session gates a DAO's members. A
 * member never signs for the DAO, so `canSign` is false.
 */
const may = (path: string) => (member: Member) => mayCall({ canSign: false, ...member }, path);

const ok = (value: unknown, status = 200): Reply => ({ status, body: { ok: true, value } });
const fail = (status: number, body: contract.ServerFailure): Reply => ({ status, body });
const refused = (status: number, code: string) => fail(status, { ok: false, kind: "refused", code });
const notOwner = () => fail(403, { ok: false, kind: "not_owner" });
const unavailable = () => fail(503, { ok: false, kind: "unavailable" });

/** Logs what the browser isn't told: the event and its details, never a request's cookie, body or credential. */
const log = (event: string, details: Record<string, unknown>) => console.error(JSON.stringify({ event, ...details }));

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
/** A platform failure's details for the log, never for the browser. */
const failure = (answer: { kind: string; status?: number; httpStatus?: number; error?: string }) =>
  ({ kind: answer.kind, ...(answer.status !== undefined && { status: answer.status }), ...(answer.httpStatus !== undefined && { httpStatus: answer.httpStatus }),
    ...(answer.error !== undefined && { error: answer.error }) });
/** The platform's answer as the audit trail records it: its kind and status, and the code the browser was given. */
const audited = (answer: { ok: true } | { ok: false; kind: string; status?: number }, reply: Reply) =>
  answer.ok ? { ok: true as const } : { ok: false as const, kind: answer.kind, ...(answer.status !== undefined && { status: answer.status }),
    ..."code" in reply.body && { code: reply.body.code }, ...(!reply.body.ok && reply.body.kind === "not_owner" && { code: "not_owner" }) };
/** Records a result; a record that can't be written is logged instead, since its attempt is already on record. */
const recordResult = async (audit: Audit, entry: Extract<AuditEntry, { stage: "result" }>) => {
  try { await audit.append(entry); } catch (error) { log("audit_failed", { ...entry, error: String(error) }); }
};
/** How many consents one disconnect revokes; more answer `unavailable`, and trying again revokes the rest. */
const REVOKES_PER_REQUEST = 5;

/**
 * Revokes `consents`, at most `REVOKES_PER_REQUEST`, each recorded before and after. One whose attempt can't be
 * recorded is skipped, so nothing reaches the platform unrecorded. Answers how many were revoked and whether all were.
 */
async function revokeAll(consents: readonly ConsentRecord[], who: string, agent: string, { platform, audit }: Context) {
  let revoked = 0, complete = consents.length <= REVOKES_PER_REQUEST;
  for (const consent of consents.slice(0, REVOKES_PER_REQUEST)) {
    try { await audit.append({ who, action: "revoke", agent, subject: consent.id, stage: "attempt" }); }
    catch (error) { log("audit_failed", { action: "revoke", agent, subject: consent.id, error: String(error) }); complete = false; continue; }
    const answer = await platform.consents.revoke(consent.id);
    if (answer.ok) revoked++;
    else { complete = false; log("platform_revoke_failed", { agent, consent: consent.id, ...failure(answer) }); }
    await recordResult(audit, { who, action: "revoke", agent, subject: consent.id, stage: "result", answer: audited(answer, answer.ok ? ok({}) : unavailable()) });
  }
  return { revoked, complete };
}

/** The platform's refusal codes for a proposal call that the page may act on, with the status the browser gets. */
const PROPOSAL_CODES: Record<string, number> = { signature_invalid: 400, invalidated: 409, withdrawn: 409, not_open: 409, expired: 409,
  not_approved: 409, policy_not_in_force: 409 };
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
/** A platform call whose throw is a lost answer: logged, and answered as `unavailable`, so a result is always recorded. */
async function relay<T>(call: () => Promise<T>, agent: string): Promise<T | { ok: false; kind: "unavailable" }> {
  try { return await call(); } catch (error) { log("platform_call_threw", { agent, error: String(error) }); return { ok: false, kind: "unavailable" }; }
}
/** Whether the platform's answer may have been lost: then the proposal is read once, never the call sent again. */
const lost = (answer: ProposalAnswer) => !answer.ok && !(answer.kind === "refused" && answer.status !== undefined) && answer.kind !== "forbidden" && answer.kind !== "session";

/**
 * Whether the owner signed `message` for the platform's host with `nonce`, with a full-access key of their own account:
 * checked here, so a bad signature is a stable `signature_invalid` (the gateway's own answer to it reaches the SDK as a
 * lost one) and costs no relay.
 */
async function ownersSignature(signed: { message: string; nonce: string; publicKey: string; signature: string }, identity: Identity, keyLookup: KeyLookup) {
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
  method: "POST", path: `/api/agents/:agent/proposals/:id/${verdict}`, access: "owner-fresh",
  async handle({ body, account, identity, params }, { platform, audit, keyLookup }) {
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

/**
 * A DAO request as the member who asked sees it: the platform's description and check link, and the transaction this
 * member files, by whether their role may vote (`proposalAndVote` files and votes at once; otherwise the DAO refuses the
 * whole transaction, so they only file `proposal`).
 */
function requestShown(request: DaoRequest, identity: Identity) {
  const votes = identity.member!.canVote && request.transactions.proposalAndVote !== null;
  const { id, hash, description, votingUntil } = request;
  return { id, hash, description, votingUntil, checkUrl: checkUrlOf(identity.host, hash),
    transaction: votes ? request.transactions.proposalAndVote : request.transactions.proposal, votes };
}
/** The platform's answers that end a DAO request: removed (404), ended by the DAO's stop (409), or not passed in time (410). */
const DAO_ENDED: Record<number, "gone" | "ended" | "expired"> = { 404: "gone", 409: "ended", 410: "expired" };
/** A filed DAO request as this server keeps it. */
const keptOf = (kind: DaoRequest["kind"], organization: string, agent: string, filed: { request: { id: string; hash: string; description: string; votingUntil: number };
  transactions: { proposal: unknown; proposalAndVote: unknown } }, vote?: { proposal: string; verdict: Verdict }): DaoRequest => ({
  kind, organization, agent, proposal: vote?.proposal ?? null, verdict: vote?.verdict ?? null, id: filed.request.id, hash: filed.request.hash,
  description: filed.request.description, votingUntil: filed.request.votingUntil,
  transactions: { proposal: (filed.transactions.proposal ?? null) as DaoRequest["transactions"]["proposal"],
    proposalAndVote: (filed.transactions.proposalAndVote ?? null) as DaoRequest["transactions"]["proposalAndVote"] },
});
/**
 * A refused DAO filing as the browser gets it. Consent: 403, the DAO doesn't own the agent; 409, the agent changed.
 * Vote: 403, no live DAO consent covers it; 409, the proposal isn't open. Either: 400, the platform didn't accept the
 * request; 429, the deployment's daily DAO requests are spent. Anything else is unavailable, logged, never forwarded.
 */
function daoFileFailure(answer: { ok: false; kind: string; status?: number; httpStatus?: number; error?: string }, kind: DaoRequest["kind"], agent: string): Reply {
  log("platform_dao_file_failed", { agent, request: kind, ...failure(answer) });
  if (answer.kind === "forbidden") return kind === "consent" ? notOwner() : refused(409, "not_connected");
  if (answer.kind !== "refused") return unavailable();
  if (answer.status === 400) return refused(400, "dao_refused");
  if (answer.status === 409) return refused(409, kind === "consent" ? "agent_changed" : "not_open");
  if (answer.status === 429) return refused(429, "too_many_requests");
  return unavailable();
}
/**
 * Keeps a request the platform just filed, before the member is given its transaction, so its state can be followed.
 * One that can't be kept is logged and answered `unavailable`: no member has filed it yet, so nothing waits on it.
 */
async function keep(request: DaoRequest, { daoRequests }: Context) {
  try { if (await daoRequests.add(request)) return true; } catch (error) { log("dao_request_not_kept", { agent: request.agent, request: request.id, error: String(error) }); return false; }
  log("dao_request_not_kept", { agent: request.agent, request: request.id, error: "too many open DAO requests" });
  return false;
}

/**
 * Reads a DAO consent request's state: reading it after the DAO's vote passed is what stores the consent, so nothing
 * else needs to watch for the vote. `pending` keeps it. A final answer is recorded (`relay`), then the request is
 * forgotten; once signed, the owner's older consents for the agent are revoked, as for a wallet's reconnect. An
 * unanswered read keeps it, and reading again is safe; it's never filed again for that.
 */
async function followConsent(request: DaoRequest, who: string, identity: Identity, context: Context): Promise<Reply> {
  const { platform, audit, daoRequests } = context, { agent } = identity;
  const at = { who, action: "consent" as const, agent, signer: "dao" as const, step: "relay" as const, daoRequest: request.id, daoHash: request.hash, stage: "result" as const };
  const answer = await relay(() => platform.dao.consents.state(request.id), agent);
  if (!answer.ok) {
    const ended = answer.kind === "refused" ? DAO_ENDED[answer.status] : undefined;
    if (!ended) { log("platform_dao_state_failed", { agent, request: request.id, ...failure(answer) }); return unavailable(); }
    await recordResult(audit, { ...at, answer: { ok: false, kind: answer.kind, status: (answer as { status: number }).status, code: ended } });
    await daoRequests.drop(request);
    return ok({ state: ended });
  }
  if (answer.value.state === "pending") return ok({ state: "pending", request: requestShown(request, identity) });
  const { consent } = answer.value;
  await recordResult(audit, { ...at, subject: consent.id, answer: { ok: true } });
  await daoRequests.drop(request);
  const listed = await platform.consents.list(organizationOf(identity.owner));
  if (listed.ok) await revokeAll(liveConsents(listed.value.consents, identity).filter(other => other.id !== consent.id), who, agent, context);
  else log("platform_consents_failed", { agent, ...failure(listed) });
  return ok({ state: "signed", consent: shown(consent) });
}

/**
 * Reads a DAO vote request's state: reading it after the vote passed is what relays the verdict to the proposal, once.
 * As `followConsent`: `pending` keeps it; a final answer is recorded, then the request is forgotten.
 */
async function followVote(request: DaoRequest, who: string, identity: Identity, context: Context): Promise<Reply> {
  const { platform, audit, daoRequests } = context, { agent } = identity;
  const verdict = request.verdict!;
  const at = { who, action: verdict, agent, subject: request.proposal!, signer: "dao" as const, step: "relay" as const, daoRequest: request.id, daoHash: request.hash, stage: "result" as const };
  const answer = await relay(() => platform.dao.votes.state(request.id), agent);
  if (!answer.ok) {
    const ended = answer.kind === "refused" ? DAO_ENDED[answer.status] : undefined;
    if (!ended) { log("platform_dao_state_failed", { agent, request: request.id, ...failure(answer) }); return unavailable(); }
    await recordResult(audit, { ...at, answer: { ok: false, kind: answer.kind, status: (answer as { status: number }).status, code: ended } });
    await daoRequests.drop(request);
    return ok({ state: ended });
  }
  if (answer.value.state === "pending") return ok({ state: "pending", verdict, request: requestShown(request, identity) });
  await recordResult(audit, { ...at, answer: { ok: true } });
  await daoRequests.drop(request);
  return ok({ state: "relayed", verdict, proposalState: answer.value.proposalState });
}
/** Whether a followed request's answer leaves it open (pending, or unanswered), so nothing new is filed. */
const stillOpen = (reply: Reply) => !reply.body.ok || ["pending", "relayed", "signed"].includes((reply.body.value as { state: string }).state);

/** An execute's answer, with the proposal as last read (null when that read went unanswered). */
const executed = (result: "final" | "pending" | "not_executable", proposal: ProposalView | null) => ok({ result, proposal });

/** Every route the server answers. Tests walk this table, so a new route is covered by the access tests as it's added. */
export const routes: Route[] = [
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
    method: "GET", path: "/api/agents/:agent", access: "owner", member: () => true,
    async handle({ identity }) {
      const { agent, owner, agentId, host, signer, member } = identity!;
      return ok({ agent, owner, agentId, host, signer, member });
    },
  },
  {
    // The agent's live consent for this deployment, read from the platform's list for the owner's Organization.
    method: "GET", path: "/api/agents/:agent/consent", access: "owner", member: () => true,
    async handle({ identity }, { platform }) {
      const listed = await platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const [live] = liveConsents(listed.value.consents, identity!);
      return ok({ consent: live ? shown(live) : null });
    },
  },
  {
    /**
     * The text the owner's wallet signs to connect the agent, built here from the agent's identity as the platform
     * answers it now, never from the browser. An agent already connected isn't offered another signature.
     */
    method: "POST", path: "/api/agents/:agent/consent/text", access: "owner-fresh",
    async handle({ identity }, { platform, deployment }) {
      const { agentId } = identity!;
      if (agentId === null) return refused(409, "not_created");
      const listed = await platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      if (liveConsents(listed.value.consents, identity!).length) return refused(409, "already_connected");
      return ok(consentText({ identity: { ...identity!, agentId }, deployment }));
    },
  },
  {
    /**
     * The owner's signed consent, relayed once it's checked to be exactly the consent this server asks for now. A lost
     * answer submits the same signed body once more; the owner is never asked to sign again for that. The attempt is
     * recorded before the platform is asked, and its result after. Once stored, the owner's older consents for the
     * agent are revoked, so a reconnect leaves one.
     */
    method: "POST", path: "/api/agents/:agent/consent", access: "owner-fresh",
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
      let stored = await platform.consents.submit(submission);
      if (!stored.ok && stored.kind === "unavailable") stored = await platform.consents.submit(submission);
      if (!stored.ok) log("platform_consent_failed", { agent, ...failure(stored) });
      // 400: not accepted. 409: the agent changed since the text was built; read it again and ask for a new signature.
      // 403: the platform says the signer doesn't own the agent. Anything else, a 429 included, may work later as is.
      const reply = stored.ok ? ok({ consent: shown(stored.value.consent) })
        : stored.kind === "refused" && stored.status === 400 ? refused(400, "consent_refused")
        : stored.kind === "refused" && stored.status === 409 ? refused(409, "agent_changed")
        : stored.kind === "forbidden" ? notOwner() : unavailable();
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
     * Disconnects the agent: revokes the owner's live consents for it, found in the platform's list. A consent ID from
     * the browser is never used, since the platform revokes any of the deployment's consents by ID. At most
     * `REVOKES_PER_REQUEST` a request; if any is left or fails, the answer is `unavailable` and trying again is safe.
     */
    // A DAO's member who may stop its autopilot (`mayCall`'s rule for `autopilot/stop`) may end this app's access too.
    method: "POST", path: "/api/agents/:agent/consent/revoke", access: "owner-fresh", member: may("autopilot/stop"),
    async handle({ account, identity }, context) {
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const { revoked, complete } = await revokeAll(liveConsents(listed.value.consents, identity!), account!, identity!.agent, context);
      return complete ? ok({ revoked }) : unavailable();
    },
  },
  {
    // The agent's proposals, under the owner's own Organization: an owner reaches only proposals made under their consent.
    method: "GET", path: "/api/agents/:agent/proposals", access: "owner", member: may("proposals/list"),
    async handle({ identity }, { platform }) {
      const listed = await platform.proposals.list(organizationOf(identity!.owner), identity!.agent);
      return listed.ok ? ok({ proposals: listed.value.proposals }) : proposalFailure(listed, identity!.agent);
    },
  },
  {
    method: "GET", path: "/api/agents/:agent/proposals/:id", access: "owner", member: may("proposals/get"),
    async handle({ identity, params }, { platform }) {
      const id = parse(proposalId, params.id);
      if (!id) return refused(400, "bad_request");
      const read = await platform.proposals.get(organizationOf(identity!.owner), identity!.agent, id);
      return read.ok ? ok({ proposal: read.value }) : proposalFailure(read, identity!.agent);
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
    method: "POST", path: "/api/agents/:agent/proposals/:id/execute", access: "owner-fresh", member: may("proposals/execute"),
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
  {
    /** A DAO-owned agent's consent request, as last read: reading it is what stores the consent once the DAO's vote passed. */
    method: "GET", path: "/api/agents/:agent/consent/dao", access: "owner-fresh", member: () => true,
    async handle({ account, identity }, context) {
      if (identity!.signer !== "dao") return refused(409, "not_dao");
      const open = context.daoRequests.open("consent", organizationOf(identity!.owner), identity!.agent);
      return open ? followConsent(open, account!, identity!, context) : ok({ state: "none" });
    },
  },
  {
    /**
     * Files a DAO-owned agent's consent for the DAO's vote: the canonical consent text, built here from the agent's
     * identity as the platform answers it now, never from the browser. The member then files the platform's transaction
     * in their own wallet. An open request is followed, never filed again: filing again files a new request, and a second
     * DAO proposal. A lost answer to the filing keeps nothing, so asking again files anew: no member has filed one yet.
     * Recorded before the platform is asked and after.
     */
    method: "POST", path: "/api/agents/:agent/consent/dao", access: "owner-fresh", member: member => member.canPropose,
    async handle({ account, identity }, context) {
      const { platform, deployment, audit, consentsToday } = context;
      const { agent, agentId } = identity!;
      if (identity!.signer !== "dao") return refused(409, "not_dao");
      if (agentId === null) return refused(409, "not_created");
      const organization = organizationOf(identity!.owner);
      const open = context.daoRequests.open("consent", organization, agent);
      if (open) {
        const followed = await followConsent(open, account!, identity!, context);
        if (stillOpen(followed)) return followed;
      }
      const listed = await platform.consents.list(organization);
      if (!listed.ok) { log("platform_consents_failed", { agent, ...failure(listed) }); return unavailable(); }
      if (liveConsents(listed.value.consents, identity!).length) return refused(409, "already_connected");
      if (!consentsToday(account!)) return refused(429, "rate_limited");
      const message = consentMessageFor({ identity: { ...identity!, agentId }, deployment });
      const at = { who: account!, action: "consent" as const, agent, signer: "dao" as const, step: "file" as const, signedTextSha256: sha256(message) };
      await audit.append({ ...at, stage: "attempt" });
      const filed = await relay(() => platform.dao.consents.file(message), agent);
      let reply: Reply;
      if (!filed.ok) reply = daoFileFailure(filed, "consent", agent);
      else {
        const request = keptOf("consent", organization, agent, filed.value);
        reply = await keep(request, context) ? ok({ state: "pending", request: requestShown(request, identity!) }) : unavailable();
      }
      await recordResult(audit, { ...at, ...(filed.ok && { daoRequest: filed.value.request.id, daoHash: filed.value.request.hash }), stage: "result",
        answer: filed.ok ? (reply.body.ok ? { ok: true } : { ok: false, kind: "unavailable", code: "not_kept" }) : audited(filed, reply) });
      return reply;
    },
  },
  {
    /** The DAO's vote on a proposal, as last read: reading it is what relays the verdict once the DAO's vote passed. */
    method: "GET", path: "/api/agents/:agent/proposals/:id/vote", access: "owner-fresh", member: () => true,
    async handle({ account, identity, params }, context) {
      const id = parse(proposalId, params.id);
      if (!id) return refused(400, "bad_request");
      if (identity!.signer !== "dao") return refused(409, "not_dao");
      const open = context.daoRequests.open("vote", organizationOf(identity!.owner), identity!.agent, id);
      return open ? followVote(open, account!, identity!, context) : ok({ state: "none" });
    },
  },
  {
    /**
     * Files the DAO's vote on a proposal, for a member to file in their wallet. The platform files it from the proposal's
     * own text; this server never builds or relays an approval text for a DAO. The proposal is read anew first and must
     * be open and unexpired. An open vote on it is followed, never filed again; one on the other verdict is refused
     * (`vote_open`) while it's pending. Recorded before the platform is asked and after, with the SHA-256 of the text the
     * DAO's vote signs.
     */
    method: "POST", path: "/api/agents/:agent/proposals/:id/vote", access: "owner-fresh", member: member => member.canPropose,
    async handle({ account, body, identity, params }, context) {
      const { platform, audit } = context;
      const id = parse(proposalId, params.id), asked = parse(contract.voteSubmission, body);
      if (!id || !asked) return refused(400, "bad_request");
      if (identity!.signer !== "dao") return refused(409, "not_dao");
      const organization = organizationOf(identity!.owner), { agent } = identity!, { verdict } = asked;
      const open = context.daoRequests.open("vote", organization, agent, id);
      if (open) {
        const followed = await followVote(open, account!, identity!, context);
        if (stillOpen(followed)) return followed.body.ok && open.verdict !== verdict && (followed.body.value as { state: string }).state === "pending"
          ? refused(409, "vote_open") : followed;
      }
      const fresh = await relay(() => platform.proposals.get(organization, agent, id), agent);
      if (!fresh.ok) return proposalFailure(fresh, agent);
      const checked = checkOpen(fresh.value);
      if (!checked.ok) return refused(409, checked.code);
      const at = { who: account!, action: verdict, agent, subject: id, signer: "dao" as const, step: "file" as const, signedTextSha256: sha256(proposalText(fresh.value, verdict)) };
      await audit.append({ ...at, stage: "attempt" });
      const filed = await relay(() => platform.dao.votes.file({ organization, agent, proposal: id, verdict }), agent);
      let reply: Reply;
      if (!filed.ok) reply = daoFileFailure(filed, "vote", agent);
      else {
        const request = keptOf("vote", organization, agent, filed.value, { proposal: id, verdict });
        reply = await keep(request, context) ? ok({ state: "pending", verdict, request: requestShown(request, identity!) }) : unavailable();
      }
      await recordResult(audit, { ...at, ...(filed.ok && { daoRequest: filed.value.request.id, daoHash: filed.value.request.hash }), stage: "result",
        answer: filed.ok ? (reply.body.ok ? { ok: true } : { ok: false, kind: "unavailable", code: "not_kept" }) : audited(filed, reply) });
      return reply;
    },
  },
];

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
 * DELETE without a body. A session
 * route needs a live session. An owner route also needs the session's account to be the agent's owner, as the
 * platform answers it (within the last minute, or anew for `owner-fresh`; see `Access`), because ownership can change:
 * the platform's own checks prove this server may act for the agent, not that the person in the browser owns it.
 *
 * Each owner-route request counts against the account's `ownerRequestsPerMinute`. Only a successful identity is reused,
 * so a reused answer that refuses the account names another owner: it's read once more anew, counted too, so a new
 * owner isn't locked out for a minute after a transfer.
 */
async function admit(route: Route, call: Call, deps: Context, admissions: RateLimit): Promise<Reply | Identity | undefined> {
  if (route.method !== "GET") {
    if (call.req.headers.origin !== deps.publicOrigin) return refused(403, "origin");
    // A body must be JSON; a DELETE without one (sign-out) needs no content type.
    const bodyless = route.method === "DELETE" && call.body === undefined;
    if (!bodyless && !/^application\/json(;|$)/.test(call.req.headers["content-type"] ?? "")) return refused(415, "content_type");
  }
  if (route.access === "public") return undefined;
  if (!call.account) return fail(401, { ok: false, kind: "not_signed_in" });
  if (route.access === "session") return undefined;
  const agent = call.params.agent!;
  if (!parse(contract.agentName, agent)) return refused(400, "bad_request");
  if (!admissions(call.account)) return refused(429, "rate_limited");
  const first = await deps.platform.identity(agent, { fresh: route.access === "owner-fresh" });
  let decided = await decide(first.answer, agent, call.account, deps, first.cached);
  if (first.cached && "status" in decided && !decided.body.ok && decided.body.kind === "not_owner") {
    if (!admissions(call.account)) return refused(429, "rate_limited");
    decided = await decide((await deps.platform.identity(agent, { fresh: true })).answer, agent, call.account, deps, false);
  }
  if ("status" in decided || decided.signer !== "dao") return decided;
  // A DAO's member: only on routes that say so, and only as the member's roles allow.
  if (!route.member) return refused(409, "dao_owner");
  return route.member(decided.member!) ? decided : refused(403, "not_permitted");
}

/**
 * Whether `account` owns `agent` by the platform's answer. Only the platform's 404 (no such agent, or one this
 * deployment can't reach) means the agent isn't visible, and it gets the same answer as one someone else owns,
 * `not_owner`, so a signed-in stranger can't tell which agents exist. Any other failure says nothing about ownership and
 * is `unavailable`: the credential's hourly limit (429), a conflict (409), an outage, and a 403, which the platform
 * answers only to a request carrying browser headers, so it means this server is misconfigured. So does an identity
 * naming another deployment, since the platform only ever names the credential's own. Failures are logged when read,
 * never forwarded.
 */
async function decide(answer: IdentityAnswer, agent: string, account: string, deps: Context, cached: boolean): Promise<Reply | Identity> {
  if (!answer.ok) {
    if (!cached) log("platform_identity_failed", { agent, ...failure(answer) });
    return answer.kind === "refused" && answer.status === 404 ? notOwner() : unavailable();
  }
  if (answer.value.deployment !== deps.deployment) {
    log("deployment_mismatch", { agent, expected: deps.deployment, got: answer.value.deployment });
    return unavailable();
  }
  const { owner, agentId, host } = answer.value;
  const identity = { agent: answer.value.agent, owner, agentId, host };
  if (answer.value.signer !== "dao") return owner === account ? { ...identity, signer: "wallet", member: null } : notOwner();
  // A DAO owns it: the DAO has no keys, so who may act is its members, by its roles on chain. A policy that can't be
  // read admits no one: unavailable, never a guess.
  const policy = await deps.daoPolicy(owner);
  if (policy === "unavailable") { log("dao_policy_unavailable", { agent, dao: owner }); return unavailable(); }
  const access = memberAccess(account, owner, policy);
  if (!access) return notOwner();
  const { canPropose, canVote, canExecute, canManage } = access;
  return { ...identity, signer: "dao", member: { canPropose, canVote, canExecute, canManage } };
}

/** The server's request handler, built from its dependencies so tests can run it in-process with fakes. */
export function createServer(deps: Deps) {
  const admissions = createRateLimit({ limit: deps.ownerRequestsPerMinute });
  const context: Context = { ...deps, consentsToday: createRateLimit({ limit: deps.consentsPerDay, windowMs: 86_400_000 }),
    daoPolicy: deps.daoPolicy ?? (async () => "unavailable"), daoRequests: deps.daoRequests ?? memoryDaoRequests() };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = ({ status, body, cookie }: Reply) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
        ...(cookie && { "set-cookie": cookie }),
      });
      res.end(JSON.stringify(body));
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
      const call: Call = { req, body: read.body, token, account: deps.sessions.account(token), params: found.params };
      const admitted = await admit(found.route, call, context, admissions);
      if (admitted && "status" in admitted) return send(admitted);
      send(await found.route.handle({ ...call, ...(admitted && { identity: admitted }) }, context));
    } catch (error) {
      log("internal_error", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path: req.url?.split("?")[0] });
      if (!res.headersSent) send(unavailable());
      else res.destroy();
    }
  };
}
