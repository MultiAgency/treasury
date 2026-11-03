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

/** Plain settings: safe to print. */
const Settings = z.object({
  /** The platform host's origin, where `/apps/v1` is served. */
  TREASURY_PLATFORM_ORIGIN: origin,
  /** This app's deployment name, as the operator issued its credential. */
  TREASURY_DEPLOYMENT: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** A 0600 file holding the deployment's `tap_` credential; re-read when it changes. */
  TREASURY_CREDENTIAL_FILE: z.string().min(1),
  /** This server's own origin: the sign-in recipient and the only `Origin` accepted on writes. */
  TREASURY_PUBLIC_ORIGIN: origin,
  /** Where the audit trail and other durable records are kept. */
  TREASURY_DATA_DIR: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  /** Overrides the chain RPC; otherwise FastNEAR's, as the platform's `src/chain.ts` does. */
  NEAR_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  SESSION_IDLE_MS: duration(minutes(30)),
  SESSION_MAX_MS: duration(minutes(12 * 60)),
  CHALLENGE_TTL_MS: duration(minutes(5)),
  CHALLENGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
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

/** Reads and checks the configuration from the environment; throws, naming each missing or invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const settings = Settings.safeParse(env), secrets = Secrets.safeParse(env);
  const problems = [...(settings.error?.issues ?? []), ...(secrets.error?.issues ?? [])]
    .map(issue => `${issue.path.join(".")}: ${issue.message}`);
  if (problems.length || !settings.success || !secrets.success) throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  if (settings.data.SESSION_IDLE_MS > settings.data.SESSION_MAX_MS) throw new Error("Invalid configuration:\nSESSION_IDLE_MS: longer than SESSION_MAX_MS");
  return { settings: settings.data, secrets: secrets.data };
}
