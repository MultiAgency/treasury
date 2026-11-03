import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { sha256, type Audit, type AuditEntry } from "./audit.ts";
import { checkConsent, consentText, liveConsents, organizationOf } from "./consent.ts";
import * as contract from "./contract.ts";
import type { Identity } from "./contract.ts";
import type { ConsentRecord, IdentityAnswer, Platform } from "./platform.ts";
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
};
/** What a handler reads: the dependencies, and the limits the server keeps across requests. */
type Context = Deps & { consentsToday: RateLimit };

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
type Route = { method: "GET" | "POST" | "DELETE"; path: string; access: Access; handle(call: Call, context: Context): Promise<Reply> };

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
    method: "GET", path: "/api/agents/:agent", access: "owner",
    async handle({ identity }) {
      const { agent, owner, agentId, host } = identity!;
      return ok({ agent, owner, agentId, host });
    },
  },
  {
    // The agent's live consent for this deployment, read from the platform's list for the owner's Organization.
    method: "GET", path: "/api/agents/:agent/consent", access: "owner",
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
    method: "POST", path: "/api/agents/:agent/consent/revoke", access: "owner-fresh",
    async handle({ account, identity }, context) {
      const listed = await context.platform.consents.list(organizationOf(identity!.owner));
      if (!listed.ok) { log("platform_consents_failed", { agent: identity!.agent, ...failure(listed) }); return unavailable(); }
      const { revoked, complete } = await revokeAll(liveConsents(listed.value.consents, identity!), account!, identity!.agent, context);
      return complete ? ok({ revoked }) : unavailable();
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
async function admit(route: Route, call: Call, deps: Deps, admissions: RateLimit): Promise<Reply | Identity | undefined> {
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
  const decided = decide(first.answer, agent, call.account, deps, first.cached);
  if (!first.cached || !("status" in decided) || decided.body.ok || decided.body.kind !== "not_owner") return decided;
  if (!admissions(call.account)) return refused(429, "rate_limited");
  return decide((await deps.platform.identity(agent, { fresh: true })).answer, agent, call.account, deps, false);
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
function decide(answer: IdentityAnswer, agent: string, account: string, deps: Deps, cached: boolean): Reply | Identity {
  if (!answer.ok) {
    if (!cached) log("platform_identity_failed", { agent, ...failure(answer) });
    return answer.kind === "refused" && answer.status === 404 ? notOwner() : unavailable();
  }
  if (answer.value.deployment !== deps.deployment) {
    log("deployment_mismatch", { agent, expected: deps.deployment, got: answer.value.deployment });
    return unavailable();
  }
  if (answer.value.owner !== account) return notOwner();
  const { owner, agentId, host } = answer.value;
  return { agent: answer.value.agent, owner, agentId, host };
}

/** The server's request handler, built from its dependencies so tests can run it in-process with fakes. */
export function createServer(deps: Deps) {
  const admissions = createRateLimit({ limit: deps.ownerRequestsPerMinute });
  const context: Context = { ...deps, consentsToday: createRateLimit({ limit: deps.consentsPerDay, windowMs: 86_400_000 }) };
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
