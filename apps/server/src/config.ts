import { z } from "zod";
import { DEFAULT_ASSISTANT_MODEL } from "./assistant/model.ts";

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
  /**
   * Where the tokens issued to owners' agents are kept (`agent-tokens.ts`, #139), owner-only and hashed. Without it, tokens
   * last only as long as the process, and a restart ends them all.
   */
  TREASURY_AGENT_TOKENS_FILE: z.string().min(1).optional(),
  /**
   * Where the strategies agents propose are kept until the owner answers them (`strategy-proposals.ts`, #206),
   * owner-only, with the last answered one of each source, so a declined strategy isn't proposed again. Without it, they
   * last only as long as the process.
   */
  TREASURY_STRATEGY_PROPOSALS_FILE: z.string().min(1).optional(),
  /** This server's own origin: the sign-in recipient and the only `Origin` accepted on writes. */
  TREASURY_PUBLIC_ORIGIN: publicOrigin,
  /**
   * How many reverse proxies in front of this server to trust for the client's address (`X-Forwarded-For`), which the
   * challenge rate limit is keyed on. 0, the default, trusts none: the connection's own address is used.
   */
  TREASURY_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** The app's build (`web/dist`), which this server serves; unset, it answers only its API. */
  TREASURY_PAGE_DIR: z.string().min(1).optional(),
  /** The agents `watch` proposes for (`watch-config.ts`), a 0600 JSON file; unset, `watch` doesn't run. */
  TREASURY_WATCH_FILE: z.string().min(1).optional(),
  /** Where `watch` stores each proposal request before sending it (`requests.ts`), owner-only; needed with `TREASURY_WATCH_FILE`. */
  TREASURY_REQUESTS_FILE: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  /** Overrides the chain RPC; otherwise FastNEAR's, as the platform's `src/chain.ts` does. */
  NEAR_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Wallet ownership verification only; leaves DAO reads and synthetic transaction services unchanged. */
  TREASURY_SIGNIN_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  SESSION_IDLE_MS: duration(minutes(30)),
  SESSION_MAX_MS: duration(minutes(12 * 60)),
  CHALLENGE_TTL_MS: duration(minutes(5)),
  CHALLENGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /**
   * Owner-route requests per signed-in account a minute; each may cost a call against the platform's shared quota. Set
   * for the pages as measured (2026-11-14): one tab peaks at 44 in a minute, a full page load is 15 and an action waiting
   * for its signature polls 26, so two tabs on an agent while a freeze waits make about 90. The limit stops a runaway
   * client; the platform's own limit is what guards its quota.
   */
  OWNER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Calls per agent token an hour, apart from the account's own: each costs a call against the platform's hourly budget. */
  TOKEN_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(60),
  /** Calls every agent token together may make an hour: a quarter of the platform's 1,200, so software can't spend the rest. */
  TOKEN_BUDGET_PER_HOUR: z.coerce.number().int().positive().default(300),
  /** New consents per signed-in account a day: the platform caps a deployment's live consents at 1,024, every owner's together. */
  CONSENTS_PER_DAY: z.coerce.number().int().positive().default(5),
  /**
   * Which model answers: `nearai` (NEAR AI Cloud's chat completions, needs `NEARAI_API_KEY`) or `rules`, a
   * deterministic keyword-routed stand-in that answers a fixed set of question kinds with the same tools and sends
   * nothing off the server (the stack's tests use it). Unset, the assistant is on only when a NEAR AI key is.
   */
  TREASURY_ASSISTANT_PROVIDER: z.enum(["nearai", "rules"]).optional(),
  /**
   * The treasury assistant (#219): the NEAR AI Cloud model it asks (a private TEE model by default), the questions one account
   * may ask an hour, and the platform reads it may make an hour, every owner's together (its share of the deployment's
   * 1,200 platform calls an hour, which the routes and watch spend too).
   */
  TREASURY_ASSISTANT_MODEL: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/).default(DEFAULT_ASSISTANT_MODEL),
  ASSISTANT_QUESTIONS_PER_HOUR: z.coerce.number().int().positive().default(30),
  ASSISTANT_READS_PER_HOUR: z.coerce.number().int().positive().default(240),
  /**
   * NEAR Intents' public API (#221), read for the hedge plan's live prices and dry quotes: `live` (1Click, keyless, nothing
   * of the treasury's sent), `stub` (a deterministic list and quotes from the registry, nothing leaves the server: the
   * stack's tests use it) or `off` (the hedge read says NEAR Intents isn't connected and blocks every move).
   */
  INTENTS_PROVIDER: z.enum(["live", "stub", "off"]).default("live"),
  /** Calls to NEAR Intents an hour, the token list and every quote, for the whole deployment. */
  INTENTS_CALLS_PER_HOUR: z.coerce.number().int().positive().default(120),
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
  /**
   * The NEAR account that anchors the audit log's head hash (A7.3, #55), with `TREASURY_ANCHOR_KEY_FILE`; unset, the log
   * isn't anchored. It writes to itself through FastData's `__fastdata_kv`, under `audit/<TREASURY_DEPLOYMENT>`:
   * `contextual.near`, or `contextual.testnet` on testnet.
   */
  TREASURY_ANCHOR_ACCOUNT: z.string().regex(/^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/).optional(),
  /** A 0600 file holding the anchor account's function-call key, limited to that account and `__fastdata_kv`. */
  TREASURY_ANCHOR_KEY_FILE: z.string().min(1).optional(),
  /** How often the head is anchored, in seconds: hourly by default, and at most daily, the heartbeat's period. */
  TREASURY_ANCHOR_INTERVAL_S: z.coerce.number().int().min(60).max(86_400).default(3600),
  /**
   * The NEAR network the anchor is sent on. Mainnet uses the server's RPC (`NEAR_RPC_URL` or FastNEAR's); testnet uses
   * FastNEAR's testnet RPC. Sign-in and DAO reads stay on mainnet either way.
   */
  TREASURY_ANCHOR_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  PLATFORM_TIMEOUT_MS: duration(15_000),
  /** For an execute, which the platform answers once the plan's swaps have run: a two-swap plan took about 50 s on staging. */
  PLATFORM_EXECUTE_TIMEOUT_MS: duration(180_000),
  CHAIN_TIMEOUT_MS: duration(10_000),
});

/** Secrets: wrapped so they never print. */
const Secrets = z.object({
  /** FastNEAR's API key: a rate-limit and billing credential, sent only to FastNEAR's hosts. */
  FASTNEAR_API_KEY: z.string().min(1).optional().transform(value => value === undefined ? undefined : new Secret(value)),
  /** The NEAR AI Cloud API key the assistant asks its model with; unset, the assistant is off. Sent only to NEAR AI Cloud. */
  NEARAI_API_KEY: z.string().min(1).optional().transform(value => value === undefined ? undefined : new Secret(value)),
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
  if (!settings.data.TREASURY_ANCHOR_ACCOUNT !== !settings.data.TREASURY_ANCHOR_KEY_FILE) throw new Error("Invalid configuration:\nTREASURY_ANCHOR_ACCOUNT and TREASURY_ANCHOR_KEY_FILE: set both or neither");
  if (settings.data.TREASURY_ANCHOR_ACCOUNT && settings.data.TREASURY_ANCHOR_ACCOUNT.endsWith(".testnet") !== (settings.data.TREASURY_ANCHOR_NETWORK === "testnet"))
    throw new Error("Invalid configuration:\nTREASURY_ANCHOR_ACCOUNT: not an account on TREASURY_ANCHOR_NETWORK");
  if (settings.data.TREASURY_WATCH_FILE && !settings.data.TREASURY_REQUESTS_FILE) throw new Error("Invalid configuration:\nTREASURY_REQUESTS_FILE: required with TREASURY_WATCH_FILE");
  return { settings: settings.data, secrets: secrets.data };
}
