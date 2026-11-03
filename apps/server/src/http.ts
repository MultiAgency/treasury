import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import * as contract from "./contract.ts";
import type { Platform } from "./platform.ts";
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
};

/**
 * Who may call a route: anyone, a signed-in session, or the signed-in owner of the route's `:agent`. `owner` may use an
 * identity the platform answered within the last minute: for routes that forward to the platform, which checks the
 * owner again on every forwarded call (a consent is live only while its signer owns the agent). `owner-fresh` reads it
 * anew: for routes that answer from this server's own records, which nothing else re-checks.
 */
export type Access = "public" | "session" | "owner" | "owner-fresh";
type Identity = { agent: string; owner: string; agentId: string | null; host: string };
/** A call as its handler sees it. `identity` is the agent's, read fresh by the owner check, on owner routes only. */
type Call = { req: IncomingMessage; body: unknown; token: string | undefined; account: string | undefined; params: Record<string, string>; identity?: Identity };
type Reply = { status: number; body: contract.Answer<unknown>; cookie?: string };
type Route = { method: "GET" | "POST" | "DELETE"; path: string; access: Access; handle(call: Call, deps: Deps): Promise<Reply> };

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
 * An agent that doesn't exist or that this deployment can't see (the platform's 404, or `forbidden`) and one someone
 * else owns get the same answer, `not_owner`, so a signed-in stranger can't tell which agents exist. Any other platform
 * refusal, such as the credential's hourly limit (429), says nothing about ownership, so it's `unavailable`. The
 * platform only ever names the credential's own deployment, so an identity naming another means this server's
 * `TREASURY_DEPLOYMENT` is misconfigured: every agent answers `unavailable`. Platform failures are logged, never forwarded.
 */
async function admit(route: Route, call: Call, deps: Deps): Promise<Reply | Identity | undefined> {
  if (route.method !== "GET") {
    if (call.req.headers.origin !== deps.publicOrigin) return refused(403, "origin");
    // A body must be JSON; a DELETE without one (sign-out) needs no content type.
    const bodyless = route.method === "DELETE" && call.body === undefined;
    if (!bodyless && !/^application\/json(;|$)/.test(call.req.headers["content-type"] ?? "")) return refused(415, "content_type");
  }
  if (route.access === "public") return undefined;
  if (!call.account) return fail(401, { ok: false, kind: "not_signed_in" });
  if (route.access === "session") return undefined;
  if (!parse(contract.agentName, call.params.agent)) return refused(400, "bad_request");
  const identity = await deps.platform.identity(call.params.agent!, { fresh: route.access === "owner-fresh" });
  if (!identity.ok) {
    log("platform_identity_failed", { agent: call.params.agent, kind: identity.kind, ..."status" in identity && { status: identity.status },
      ..."httpStatus" in identity && { httpStatus: identity.httpStatus }, ..."error" in identity && { error: identity.error } });
    const unseen = (identity.kind === "refused" && identity.status === 404) || identity.kind === "forbidden";
    return unseen ? notOwner() : unavailable();
  }
  if (identity.value.deployment !== deps.deployment) {
    log("deployment_mismatch", { agent: call.params.agent, expected: deps.deployment, got: identity.value.deployment });
    return unavailable();
  }
  if (identity.value.owner !== call.account) return notOwner();
  const { agent, owner, agentId, host } = identity.value;
  return { agent, owner, agentId, host };
}

/** The server's request handler, built from its dependencies so tests can run it in-process with fakes. */
export function createServer(deps: Deps) {
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
      const admitted = await admit(found.route, call, deps);
      if (admitted && "status" in admitted) return send(admitted);
      send(await found.route.handle({ ...call, ...(admitted && { identity: admitted }) }, deps));
    } catch (error) {
      log("internal_error", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path: req.url?.split("?")[0] });
      if (!res.headersSent) send(unavailable());
      else res.destroy();
    }
  };
}
