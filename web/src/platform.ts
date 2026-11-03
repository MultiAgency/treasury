/**
 * Every call this app makes to the platform; no other module calls it. Today that is the owner's session on this host:
 * the gateway's own routes (`/gw/...`) and each agent's owner procedures through `ownerClient`, same-origin. Under
 * direction B it calls the app's own server (`/apps/v1`) instead, behind these same signatures.
 *
 * Reads may be cached and retried (`reads`). Actions and streams return their result: the caller decides by `kind`,
 * and nothing here ever sends an action again.
 */
import { gatewayDenialScope, gatewayDiscovery, ownerClient, ownerStreams, type GatewayDenialScope, type OwnerFailure,
  type OwnerInputs, type OwnerOutput, type OwnerProcedure, type OwnerResult } from "@multiagency/sdk";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

// Denials ---------------------------------------------------------------------------------------------------------

/** A gateway's plain 401/403: which scope it closed (`agent` is null for the session and gateway routes). */
export type Denial = { agent: string | null; scope: GatewayDenialScope; message: string };
const denialListeners = new Set<(denial: Denial) => void>();
/** Told of every gateway denial before the failed call returns, so private records can be hidden at once. */
export function onDenial(listener: (denial: Denial) => void) {
  denialListeners.add(listener);
  return () => { denialListeners.delete(listener); };
}
const deny = (denial: Denial) => { for (const listener of denialListeners) listener(denial); };

/** A failed call, decided by `failure.kind`; the message is only for people. */
export class PlatformError extends Error {
  readonly failure: OwnerFailure;
  constructor(failure: OwnerFailure) {
    super(failureMessage(failure));
    this.failure = failure;
  }
}
export const failureKind = (error: unknown) => error instanceof PlatformError ? error.failure.kind : undefined;

/** Plan previews save a plan and move nothing; every other unknown outcome may have sent something. */
const PREVIEWS = new Set<string>(["rebalance", "steward/propose"]);
export function failureMessage(failure: OwnerFailure): string {
  if (failure.kind === "unknown") return PREVIEWS.has(failure.procedure)
    ? "The preview was interrupted, so a plan may have been saved. Nothing was sent. Observations are read again; preview again for a fresh plan, and any earlier plan expires unused."
    : `The outcome is unknown: this ${failure.procedure} request may have taken effect. Check the recorded operations before any other action; nothing is sent again automatically.`;
  if (failure.kind === "unavailable") return "This read failed or returned an answer that could not be verified. Reading again is safe.";
  return failure.error;
}

// The gateway -----------------------------------------------------------------------------------------------------

/** The gateway's `GET /gw/me`, plus the flag a standalone Treasury gateway still sends. */
const gatewaySchema = gatewayDiscovery.extend({ selfServiceTreasury: z.boolean().optional() });
export type Gateway = z.output<typeof gatewaySchema>;
export type GatewayAgent = Gateway["agents"][number];
export type Challenge = { message: string; recipient: string; nonce: string };
/** The wallet's NEP-413 signature over a challenge, with the callback URLs some wallets sign without saying. */
export type SignedChallenge = { accountId: string; publicKey: string; signature: string; nonce: string; callbackUrls: string[] };

const unexpected = (status: number) => new Error(`The hosted gateway returned an unexpected response (${status}).`);
const isJson = (response: Response) => response.headers.get("content-type")?.includes("application/json") ?? false;

/** One call to a gateway route; its `{ error }` answer is thrown, and a 401/403 is reported as a denial first. A success
 * that isn't JSON throws: never an empty answer in its place. */
async function gw<T>(path: `/gw/${string}`, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.ok && !isJson(response)) throw unexpected(response.status);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.ok) return body;
  const message = body.error ?? `${path}: ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    deny({ agent: null, scope: gatewayDenialScope(body) ?? (response.status === 401 ? "session" : "procedure"), message });
    throw new PlatformError(response.status === 401 ? { ok: false, kind: "session", status: 401, error: message, source: "gateway" }
      : { ok: false, kind: "forbidden", status: 403, error: message, source: "gateway" });
  }
  throw new Error(message);
}

export const gateway = {
  /** Who is signed in on this host and the agents they may see. A missing or malformed answer throws: never a guess. */
  async me(): Promise<Gateway> {
    const response = await fetch("/gw/me");
    if (!isJson(response)) throw unexpected(response.status);
    const body: unknown = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(body);
      throw new Error(failure.success ? failure.data.error : `The gateway answered ${response.status}.`);
    }
    const parsed = gatewaySchema.safeParse(body);
    if (!parsed.success) throw new Error("The gateway returned invalid discovery data.");
    const found = parsed.data;
    // Explicit shared-host area restrictions take precedence over the standalone flag. A self-service gateway that
    // names no areas sets up every area, as the platform's own pages read it.
    if (found.setupAreas === undefined && found.selfService === undefined) return found;
    return { ...found, selfServiceTreasury: found.selfService === true && (found.setupAreas?.includes("treasury") ?? true) };
  },
  /** The text the wallet signs to sign in. */
  challenge: () => gw<Challenge>("/gw/challenge"),
  /** Starts the host session from the wallet's signature over a challenge. */
  async signIn(signed: SignedChallenge) {
    await gw("/gw/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  },
  /** Ends the host session. Throws unless the gateway confirms it, so nobody is shown as signed out while still signed in. */
  async signOut() {
    const response = await fetch("/gw/logout", { method: "POST" });
    if (!response.ok) throw new Error(`Sign-out didn't complete (the gateway answered ${response.status}). You're still signed in; try again.`);
  },
};

/** Whether an agent is a Treasury agent: its declared area, or by name for gateways that declare none (the platform's `areaOf`). */
export const isTreasury = (agent: GatewayAgent) => (agent.area ?? (agent.name === "treasury" ? "treasury" : "payables")) === "treasury";

// One agent -------------------------------------------------------------------------------------------------------

/** Owner procedures that only read. Each is a read to the SDK too: a lost answer is `unavailable`, never `unknown`. */
export const READS = ["setup", "instance", "overview", "policyHistory", "activity", "unresolved", "held", "autopilot/get",
  "inbox/list", "treasury/get", "strategy/get", "autopilot/evidence", "autopilot/log", "ledger", "ledgerCsv",
  "owner/pending", "owner/actions", "owner/status"] as const satisfies readonly OwnerProcedure[];
export type Read = (typeof READS)[number];
export type Stream = (typeof ownerStreams)[number];
export type Action = Exclude<OwnerProcedure, Read | Stream>;
export type Setup = OwnerOutput<"setup">;
export type Overview = OwnerOutput<"overview">;
/** What a signed-in account may do on an agent, and whether that permits a procedure: for display only, the gateway decides. */
export { mayCall, type Access } from "@multiagency/sdk";
type Options = { signal?: AbortSignal };
type Call = <P extends Exclude<OwnerProcedure, Stream>>(path: P, input: OwnerInputs[P], options?: Options) => Promise<OwnerResult<OwnerOutput<P>>>;
type Follow = <P extends Stream>(path: P, input: OwnerInputs[P], options?: Options) => AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined>;

/** The agent's owner procedures on this host, under the signed-in owner's session. */
export function agent(name: string) {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error(`Not an agent name: ${name}`);
  const owner = ownerClient({ base: `/a/${name}`, async fetch(request, init) {
    const response = await fetch(request, init);
    // A gateway denial is a plain answer, not an encoded RPC error: report its scope before the client classifies it.
    if (response.status === 401 || response.status === 403) {
      const body = await response.clone().json().catch(() => null) as { error?: unknown; json?: { code?: unknown } } | null;
      if (typeof body?.json?.code !== "string")
        deny({ agent: name, scope: gatewayDenialScope(body) ?? (response.status === 401 ? "session" : "agent"),
          message: typeof body?.error === "string" ? body.error : "Access is no longer available." });
    }
    return response;
  } });
  const call = owner.call as Call, follow = owner.stream as Follow;
  return {
    /** A read's answer; a failure throws as a `PlatformError`. Reading again is always safe. */
    async read<P extends Read>(path: P, input: OwnerInputs[P], options?: Options): Promise<OwnerOutput<P>> {
      const answer = await call(path, input, options);
      if (!answer.ok) throw new PlatformError(answer);
      return answer.value;
    },
    /** One action, sent once. The result says what happened; it never throws for a failure and never retries. */
    act<P extends Action>(path: P, input: OwnerInputs[P], options?: Options): Promise<OwnerResult<OwnerOutput<P>>> {
      return call(path, input, options);
    },
    /**
     * One stream, sent once: each event goes to `onEvent` as it arrives, and its end is the failure, or undefined. A throw
     * after the first event (ours or the stream's) may leave part of the action done, so it ends the stream as unknown.
     */
    async stream<P extends Stream>(path: P, input: OwnerInputs[P], onEvent: (event: OwnerOutput<P>) => void, options?: Options): Promise<OwnerFailure | undefined> {
      const events = follow(path, input, options);
      let started = false;
      try {
        for (let next = await events.next(); ; next = await events.next()) {
          if (next.done) return next.value;
          started = true;
          onEvent(next.value);
        }
      } catch (error) {
        if (!started) throw error;
        void events.return(undefined).catch(() => {});
        return { ok: false, kind: "unknown", procedure: path, identity: (input ?? {}) as Record<string, unknown> };
      }
    },
  };
}

// Cached reads ----------------------------------------------------------------------------------------------------

/**
 * One agent's cache identity: this host, the agent and the signed-in account. Another account gets other keys, so its
 * records are never read from cache.
 */
export const scope = (name: string, viewer: string | null) => `${location.host}|/a/${name}|${viewer ?? ""}`;
/** The scope recorded in a cache key, or undefined for keys outside any agent. */
export function scopeOfKey(key: readonly unknown[]) {
  const parts = typeof key[0] === "string" ? key[0].split("|") : [];
  return parts.length === 3 ? { host: parts[0]!, agent: parts[1]!.slice("/a/".length), account: parts[2]! } : undefined;
}

export const gatewayRead = queryOptions({ queryKey: ["gateway"], queryFn: () => gateway.me(), retry: false, staleTime: 60_000,
  refetchOnReconnect: false, refetchOnWindowFocus: "always" });

/** Cached reads of one agent for one viewer. Only reads: actions and streams never go through a query. */
export function reads(name: string, viewer: string | null) {
  const api = agent(name), key = scope(name, viewer);
  return {
    setup: queryOptions({ queryKey: [key, "setup"], queryFn: ({ signal }) => api.read("setup", undefined, { signal }), retry: false }),
    overview: queryOptions({ queryKey: [key, "overview"], queryFn: ({ signal }) => api.read("overview", undefined, { signal }), refetchInterval: 30_000 }),
  };
}
