import type { IncomingMessage, ServerResponse } from "node:http";
import { accessOf, mayCall, proposalId, type ProposalView } from "@multiagency/sdk";
import { verifyNep413Signature } from "near-kit";
import type { z } from "zod";
import { sha256, type Audit } from "./audit.ts";
import { checkConsent, consentFor, consentText, liveConsents, organizationOf } from "./consent.ts";
import { offerFor } from "./dao-offer.ts";
import type { DaoRequests, StoredDaoRequest } from "./dao-requests.ts";
import { createSettle, type Settle } from "./dao-settle.ts";
import { memberAccess, type DaoChain } from "./dao.ts";
import type { KeyLookup } from "./keys.ts";
import type { Page } from "./page.ts";
import { checkVerdict, outcomeOf, type Verdict } from "./proposals.ts";
import * as contract from "./contract.ts";
import type { Admitted } from "./contract.ts";
import type { ConsentRecord, IdentityAnswer, Platform, ProposalAnswer, ProposalListAnswer } from "./platform.ts";
import { failure, log } from "./log.ts";
import { createRateLimit, type RateLimit } from "./ratelimit.ts";
import { recordResult, revokeAll } from "./revoke.ts";
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
  /** The proposals page, served at every GET and HEAD outside `/api/`; without it, the server answers only its API. */
  page?: Page;
};
/**
 * What a handler reads: the dependencies, the limits the server keeps across requests, and the DAO filings in flight
 * per agent, so two members' clicks file once.
 */
type Context = Deps & { settle: Settle; consentsToday: RateLimit; daoFilingsToday: RateLimit; filing: Map<string, Promise<Filing>> };

/**
 * Who may call a route: anyone, a signed-in session, or the signed-in owner of the route's `:agent`. `owner` may use an
 * identity the platform answered within the last minute: for routes that forward to the platform, which checks the
 * owner again on every forwarded call (a consent is live only while its signer owns the agent). `owner-fresh` reads it
 * anew: for routes that answer from this server's own records, which nothing else re-checks, and for writes that build
 * on the agent's identity, where a stale one would be refused anyway.
 */
export type Access = "public" | "session" | "owner" | "owner-fresh";
/** A call as its handler sees it. `identity` is the agent's, as the owner check read it (see `Access`), on owner routes only. */
type Call = { req: IncomingMessage; body: unknown; token: string | undefined; account: string | undefined; params: Record<string, string>; identity?: Admitted };
type Reply = { status: number; body: contract.Answer<unknown>; cookie?: string };
/**
 * What an agent route needs of the account's access, beyond being admitted, as the platform's own rule for the
 * procedure it stands for (`mayCall`, so it can't drift from what the platform enforces): `read` a read; `sign` relaying
 * the owner's own signature (`owner/submit`: a wallet owner, never a DAO's member); `file` preparing what the owner
 * signs (`owner/prepare`: the owner, or a DAO member who may file its proposals, which the DAO contract checks too);
 * `execute` asking for a proposal's execution.
 */
export type Need = "read" | "sign" | "file" | "execute";
const NEEDS: Record<Need, string> = { read: "proposals/get", sign: "owner/submit", file: "owner/prepare", execute: "proposals/execute" };
type Route = { method: "GET" | "POST" | "DELETE"; path: string; handle(call: Call, context: Context): Promise<Reply> }
  & ({ access: "public" } | { access: "session" } | { access: "owner" | "owner-fresh"; needs: Need });

const ok = (value: unknown, status = 200): Reply => ({ status, body: { ok: true, value } });
const fail = (status: number, body: contract.ServerFailure): Reply => ({ status, body });
const refused = (status: number, code: string) => fail(status, { ok: false, kind: "refused", code });
const notOwner = () => fail(403, { ok: false, kind: "not_owner" });
const unavailable = () => fail(503, { ok: false, kind: "unavailable" });


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
async function relay(call: () => Promise<ProposalAnswer>, agent: string): Promise<ProposalAnswer> {
  try { return await call(); } catch (error) { log("platform_call_threw", { agent, error: String(error) }); return { ok: false, kind: "unavailable" }; }
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

/**
 * An open DAO request as the page shows it: what the DAO's proposal says, the platform's check page for the exact text
 * and hash the DAO signs, a vote's verdict, and what this member is offered by what the DAO holds now; the offer is
 * null when the DAO couldn't be read.
 */
async function daoView(stored: StoredDaoRequest, identity: Admitted, { daos }: Context) {
  const [policy, read] = await Promise.all([daos.policy(stored.filed.dao), daos.proposals(stored.filed.dao, stored.filed.next)]);
  if (policy === "unavailable" || read === "unavailable") log("dao_unreadable", { agent: identity.agent, dao: stored.filed.dao });
  const offer = policy === "unavailable" || read === "unavailable" ? null : offerFor(stored.filed, read, policy, identity.access, Date.now());
  return { id: stored.id, description: stored.description, votingUntil: stored.votingUntil, check: `https://${identity.host}/confirm/dao/${stored.id}`,
    ...(stored.kind === "vote" && { verdict: stored.verdict }), offer };
}

/** What a DAO is asked to vote on: its consent to this app, or a verdict on one of the agent's proposals. */
type DaoSubject = { kind: "consent" } | { kind: "vote"; proposal: string; verdict: Verdict };

/**
 * Files a DAO request for its vote, or answers the one already open for the same subject (the agent's consent, or the
 * proposal's vote): each filing is a new platform request, counted against the deployment's DAO requests a day, so
 * it's filed once, and concurrent clicks share one filing. The DAO's next proposal number is read first, so the
 * proposal a member files for it can be found. The filing is recorded before the platform is asked and after, and
 * stored before it's shown: the platform answers its transactions only once. A lost answer isn't filed again, since
 * it may have been filed.
 */
async function fileDao(subject: DaoSubject, account: string, identity: Admitted & { agentId: string }, context: Context): Promise<Reply> {
  const key = [identity.owner, identity.agent, subject.kind === "vote" ? subject.proposal : "consent"].join(" ");
  const pending = context.filing.get(key) ?? filing(subject, account, identity, context).finally(() => context.filing.delete(key));
  context.filing.set(key, pending);
  // Callers share the filing, never its view: what each is offered comes from their own roles.
  const outcome = await pending;
  return "status" in outcome ? outcome : ok({ request: await daoView(outcome, identity, context) });
}

/** A filing's outcome, shared by the clicks that wait on it: the request, open or stored now, or the refusal. */
type Filing = StoredDaoRequest | Reply;

async function filing(subject: DaoSubject, account: string, identity: Admitted & { agentId: string }, context: Context): Promise<Filing> {
  const { platform, deployment, audit, daos, daoRequests, daoFilingsToday } = context;
  const organization = organizationOf(identity.owner), { agent } = identity;
  const open = subject.kind === "consent" ? daoRequests.consent(organization, agent) : daoRequests.vote(organization, agent, subject.proposal);
  if (open) return open;
  if (!daoFilingsToday(account)) return refused(429, "rate_limited");
  // A request the platform filed is followed only once it's stored, so one that couldn't be kept isn't filed at all.
  if (!daoRequests.hasRoom()) { log("dao_requests_full", { agent }); return unavailable(); }
  const next = await daos.next(identity.owner);
  if (next === "unavailable") { log("dao_unreadable", { agent, dao: identity.owner }); return unavailable(); }
  const action = subject.kind === "consent" ? "dao-consent" as const : "dao-vote" as const;
  const message = subject.kind === "consent" ? consentFor({ identity, deployment }) : undefined;
  // A consent's text is this server's, by its hash; a vote's is the platform's own text of the proposal it names.
  const recorded = message ? { signedTextSha256: sha256(message) } : { subject: (subject as { proposal: string }).proposal };
  await audit.append({ who: account, action, agent, ...recorded, stage: "attempt" });
  const filed = subject.kind === "consent" ? await platform.daoConsents.file(message!)
    : await platform.daoVotes.file({ organization, agent, proposal: subject.proposal, verdict: subject.verdict });
  if (!filed.ok) log(`platform_${action.replace("-", "_")}_failed`, { agent, ...failure(filed) });
  const transactions = filed.ok ? parse(contract.daoTransactions,
    { proposal: filed.value.transactions.proposal, proposalAndVote: filed.value.transactions.proposalAndVote }) : undefined;
  let outcome: Filing;
  if (filed.ok && transactions) {
    const { request } = filed.value;
    const common = { organization, agent, id: request.id, description: request.description, votingUntil: request.votingUntil, filed: { dao: identity.owner, next, transactions } };
    const stored: StoredDaoRequest = subject.kind === "consent" ? { kind: "consent", ...common } : { kind: "vote", ...common, proposal: subject.proposal, verdict: subject.verdict };
    // The platform filed it: one that can't be stored now (another filing took the last room, or the disk failed) is
    // logged and recorded by its ID, since nothing here will follow it.
    const kept = await daoRequests.add(stored).catch(error => { log("dao_request_store_failed", { agent, request: request.id, error: String(error) }); return false; });
    if (!kept) log("dao_request_unstored", { agent, request: request.id });
    outcome = kept ? stored : unavailable();
  } else if (filed.ok) {
    log("platform_dao_transactions_unreadable", { agent, request: filed.value.request.id });
    outcome = unavailable();
  } else {
    // 429: the deployment's DAO requests for the day are spent. A consent's 409: the agent changed since its identity
    // was read; its 403: the agent isn't this DAO's. A vote's 409: the proposal isn't open, or it (or the consent it
    // would be relayed under) expires too soon for a vote; its 403: no live consent of the DAO covers it. Anything else
    // may work later as is.
    const status = filed.kind === "refused" ? filed.status : filed.kind === "forbidden" ? 403 : undefined;
    outcome = status === 429 ? refused(429, "rate_limited")
      : status === 409 ? refused(409, subject.kind === "consent" ? "agent_changed" : "not_open")
      : status === 403 ? (subject.kind === "consent" ? notOwner() : refused(409, "not_connected")) : unavailable();
  }
  await recordResult(audit, { who: account, action, agent, ...recorded, stage: "result", ...(filed.ok && { subject: filed.value.request.id }),
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
  return ok({ consent: live ? shown(live) : null, request: await daoView(open, identity, context) });
}

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
     * answers it now, never from the browser. An agent already connected isn't offered another signature. For a
     * DAO-owned agent, the consent is filed for the DAO's vote instead (`fileDaoConsent`), once per agent at a time.
     */
    method: "POST", path: "/api/agents/:agent/consent/text", access: "owner-fresh", needs: "file",
    async handle({ account, identity }, context) {
      const { agentId } = identity!;
      if (agentId === null) return refused(409, "not_created");
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      if (liveConsents(listed.value.consents, identity!).length) return refused(409, "already_connected");
      if (identity!.signer === "wallet") return ok(consentText({ identity: { ...identity!, agentId }, deployment: context.deployment }));
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
    method: "POST", path: "/api/agents/:agent/consent/revoke", access: "owner-fresh", needs: "sign",
    async handle({ account, identity }, context) {
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const { revoked, complete } = await revokeAll(liveConsents(listed.value.consents, identity!), account!, identity!.agent, context);
      return complete ? ok({ revoked }) : unavailable();
    },
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
async function admit(route: Route, call: Call, deps: Deps, admissions: RateLimit): Promise<Reply | Admitted | undefined> {
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
  const context: Context = { ...deps, settle: deps.settle ?? createSettle(deps), consentsToday: createRateLimit({ limit: deps.consentsPerDay, windowMs: 86_400_000 }),
    daoFilingsToday: createRateLimit({ limit: deps.daoFilingsPerDay, windowMs: 86_400_000 }), filing: new Map() };
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
      const admitted = await admit(found.route, call, deps, admissions);
      if (admitted && "status" in admitted) return send(admitted);
      send(await found.route.handle({ ...call, ...(admitted && { identity: admitted }) }, context));
    } catch (error) {
      log("internal_error", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path: req.url?.split("?")[0] });
      if (!res.headersSent) send(unavailable());
      else res.destroy();
    }
  };
}
