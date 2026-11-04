import { z } from "zod";

/**
 * A secret's value, which prints as `[secret]` wherever it ends up: logs, JSON, error messages. Only `reveal()` gives
 * the value, at the one place that sends it.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal() { return this.#value; }
  toString() { return "[secret]"; }
  toJSON() { return "[secret]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "[secret]"; }
}

const minutes = (n: number) => n * 60_000;
const duration = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const origin = z.url({ protocol: /^https?$/ }).transform(value => new URL(value).origin);
/** Sessions use a `Secure`, `__Host-` cookie, which a browser drops on plain HTTP: only localhost may use it. */
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const publicOrigin = origin.refine(value => { const url = new URL(value); return url.protocol === "https:" || LOCAL.has(url.hostname); },
  "must be https, except on localhost: the session cookie is Secure");

/** Plain settings: safe to print. */
const Settings = z.object({
  /** The platform host's origin, where `/apps/v1` is served. */
  TREASURY_PLATFORM_ORIGIN: origin,
  /** This app's deployment name, as the operator issued its credential: every agent's identity must name it. */
  TREASURY_DEPLOYMENT: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** A 0600 file holding the deployment's `tap_` credential; checked on every call and read again when it changes. */
  TREASURY_CREDENTIAL_FILE: z.string().min(1),
  /** Where relayed owner actions (consents, revocations) are recorded: an append-only file of JSON lines, owner-only. */
  TREASURY_AUDIT_FILE: z.string().min(1),
  /**
   * Where the DAO requests this server files are kept until they end (`dao-requests.ts`), owner-only: the platform
   * answers a request's transactions only once. Created on first use, so a deployment without DAOs only names it.
   */
  TREASURY_DAO_REQUESTS_FILE: z.string().min(1),
  /** This server's own origin: the sign-in recipient and the only `Origin` accepted on writes. */
  TREASURY_PUBLIC_ORIGIN: publicOrigin,
  /**
   * How many reverse proxies in front of this server to trust for the client's address (`X-Forwarded-For`), which the
   * challenge rate limit is keyed on. 0, the default, trusts none: the connection's own address is used.
   */
  TREASURY_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** The proposals page's build (`web/dist-proposals`), which this server serves; unset, it answers only its API. */
  TREASURY_PAGE_DIR: z.string().min(1).optional(),
  /** The agents `watch` proposes for (`watch-config.ts`), a 0600 JSON file; unset, `watch` doesn't run. */
  TREASURY_WATCH_FILE: z.string().min(1).optional(),
  /** Where `watch` stores each proposal request before sending it (`requests.ts`), owner-only; needed with `TREASURY_WATCH_FILE`. */
  TREASURY_REQUESTS_FILE: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  /** Overrides the chain RPC; otherwise FastNEAR's, as the platform's `src/chain.ts` does. */
  NEAR_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  SESSION_IDLE_MS: duration(minutes(30)),
  SESSION_MAX_MS: duration(minutes(12 * 60)),
  CHALLENGE_TTL_MS: duration(minutes(5)),
  CHALLENGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Owner-route requests per signed-in account a minute; each may cost a call against the platform's shared quota. */
  OWNER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** New consents per signed-in account a day: the platform caps a deployment's unexpired consents, revoked ones included. */
  CONSENTS_PER_DAY: z.coerce.number().int().positive().default(5),
  /**
   * DAO requests (consents and votes) a signed-in member may file a day: the platform allows a deployment 256 a day,
   * shared by every DAO and member.
   */
  DAO_FILINGS_PER_DAY: z.coerce.number().int().positive().default(20),
  /**
   * How often the open DAO requests are read, so a vote that passed while nobody has the page open is completed in
   * time: each open request is one call a pass against the credential's 1,200 an hour.
   */
  DAO_READ_INTERVAL_MS: duration(60_000),
  /**
   * The most open DAO requests one pass reads, the least recently read first: at one pass a minute, 5 is at most 300
   * of the credential's 1,200 calls an hour, which every owner's page shares.
   */
  DAO_READS_PER_PASS: z.coerce.number().int().positive().default(5),
  PLATFORM_TIMEOUT_MS: duration(15_000),
  CHAIN_TIMEOUT_MS: duration(10_000),
});

/** Secrets: wrapped so they never print. */
const Secrets = z.object({
  /** FastNEAR's API key: a rate-limit and billing credential, sent only to FastNEAR's hosts. */
  FASTNEAR_API_KEY: z.string().min(1).optional().transform(value => value === undefined ? undefined : new Secret(value)),
});

export type Settings = z.output<typeof Settings>;
export type Secrets = z.output<typeof Secrets>;
export type Config = { settings: Settings; secrets: Secrets };

/**
 * Reads and checks the configuration from the environment; throws, naming each missing or invalid variable. A variable
 * set to the empty string counts as unset, so its default applies (a number would otherwise read it as 0).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const settings = Settings.safeParse(set), secrets = Secrets.safeParse(set);
  const problems = [...(settings.error?.issues ?? []), ...(secrets.error?.issues ?? [])]
    .map(issue => `${issue.path.join(".")}: ${issue.message}`);
  if (problems.length || !settings.success || !secrets.success) throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  if (settings.data.SESSION_IDLE_MS > settings.data.SESSION_MAX_MS) throw new Error("Invalid configuration:\nSESSION_IDLE_MS: longer than SESSION_MAX_MS");
  if (settings.data.TREASURY_WATCH_FILE && !settings.data.TREASURY_REQUESTS_FILE) throw new Error("Invalid configuration:\nTREASURY_REQUESTS_FILE: required with TREASURY_WATCH_FILE");
  return { settings: settings.data, secrets: secrets.data };
}
