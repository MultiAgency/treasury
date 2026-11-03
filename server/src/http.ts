import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import * as contract from "./contract.ts";
import type { Platform } from "./platform.ts";
import type { Sessions } from "./sessions.ts";
import type { SignIn } from "./signin.ts";

export const COOKIE = "__Host-treasury_session";
const MAX_BODY = 16 * 1024;

export type Deps = { platform: Platform; signIn: SignIn; sessions: Sessions; publicOrigin: string };

/** Who may call a route: anyone, a signed-in session, or the signed-in owner of the route's `:agent`. */
export type Access = "public" | "session" | "owner";
type Identity = { agent: string; owner: string; agentId: string | null; host: string };
/** A call as its handler sees it. `identity` is the agent's, read fresh by the owner check, on owner routes only. */
type Call = { req: IncomingMessage; body: unknown; token: string | undefined; account: string | undefined; params: Record<string, string>; identity?: Identity };
type Reply = { status: number; body: contract.Answer<unknown>; cookie?: string };
type Route = { method: "GET" | "POST" | "DELETE"; path: string; access: Access; handle(call: Call, deps: Deps): Promise<Reply> };

const ok = (value: unknown, status = 200): Reply => ({ status, body: { ok: true, value } });
const fail = (status: number, body: contract.ServerFailure): Reply => ({ status, body });
const refused = (status: number, code: string, error?: string) => fail(status, { ok: false, kind: "refused", code, ...(error && { error }) });

/** A platform failure, passed through by kind with the status it came with. */
function platformFailure(result: { ok: false; kind: "session" | "forbidden" | "refused" | "unavailable"; status?: number; error?: string }): Reply {
  if (result.kind === "refused") return refused(result.status ?? 400, "platform", result.error);
  const status = result.kind === "session" ? 502 : result.kind === "forbidden" ? 403 : 503;
  return fail(status, { ok: false, kind: result.kind, ...(result.error && { error: result.error }) });
}

const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

const cookieFor = (token: string, maxMs: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxMs / 1000)}`;
const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** Every route the server answers. Tests walk this table, so a new route is covered by the access tests as it's added. */
export const routes: Route[] = [
  {
    method: "POST", path: "/api/session/challenge", access: "public",
    async handle({ req }, { signIn }) {
      const issued = signIn.challenge(req.socket.remoteAddress ?? "unknown");
      return issued.ok ? ok(issued.value) : refused(429, issued.code);
    },
  },
  {
    method: "POST", path: "/api/session", access: "public",
    async handle({ body }, { signIn, sessions }) {
      const signed = parse(contract.signIn, body);
      if (!signed) return refused(400, "bad_request");
      const result = await signIn.verify(signed);
      if (!result.ok) return result.kind === "unavailable" ? fail(503, { ok: false, kind: "unavailable" }) : refused(401, result.code);
      return { ...ok({ account: result.account }), cookie: cookieFor(sessions.start(result.account), sessions.maxMs) };
    },
  },
  {
    method: "DELETE", path: "/api/session", access: "session",
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

function match(route: Route, method: string, pathname: string): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  const want = route.path.split("/"), got = pathname.split("/");
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(got[i]!);
    else if (part !== got[i]) return undefined;
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
 * Checks a call before its handler runs. A write must come from this server's own origin and carry JSON. A session
 * route needs a live session. An owner route also needs the session's account to be the agent's owner, read fresh
 * from the platform on every request because ownership can change: the platform's own checks prove this server may
 * act for the agent, not that the person in the browser owns it.
 */
async function admit(route: Route, call: Call, deps: Deps): Promise<Reply | Identity | undefined> {
  if (route.method !== "GET") {
    if (call.req.headers.origin !== deps.publicOrigin) return refused(403, "origin");
    if (!/^application\/json(;|$)/.test(call.req.headers["content-type"] ?? "")) return refused(415, "content_type");
  }
  if (route.access === "public") return undefined;
  if (!call.account) return fail(401, { ok: false, kind: "not_signed_in" });
  if (route.access === "session") return undefined;
  if (!parse(contract.agentName, call.params.agent)) return refused(400, "bad_request");
  const identity = await deps.platform.identity(call.params.agent!);
  if (!identity.ok) return platformFailure(identity);
  if (identity.value.owner !== call.account) return fail(403, { ok: false, kind: "not_owner" });
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
      // The error's own name and message only: never the request, its cookie or its body.
      console.error(JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error), path: req.url?.split("?")[0] }));
      if (!res.headersSent) send(fail(500, { ok: false, kind: "unavailable", error: "internal error" }));
      else res.destroy();
    }
  };
}
