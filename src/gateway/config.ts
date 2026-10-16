import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The hosted dashboard's configuration, `dashboard.json` (or DASHBOARD_FILE): its agents, each an agent
 * server with its own owner, settings file and loopback port.
 */
const Config = z.object({
  /** The public host users sign in to, e.g. "dao.example.com". Bound into every sign-in signature. */
  host: z.string().min(0),
  /** Legacy page hosts redirect to host; API requests on them are refused, never replayed. */
  redirect_hosts: z.array(z.hostname()).default([]),
  /** Additional standalone hosts that sign in on their own origin; never inferred from proxy headers. */
  signin_hosts: z.array(z.hostname()).default([]),
  /** Where payees submit invoices, linked from the public page. */
  invoices: z.url().optional(),
  /**
   * Each agent's server: with `envFile`, the gateway runs it on `port`; without, one is already
   * running there (only one server may run per agent: each runs that agent's background loops).
   */
  agents: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]{1,32}$/),
        /** Stable presentation identity, independent of the policy's current permissions. */
        area: z.enum(["payables", "treasury"]).optional(),
        /**
         * The NEAR account the agent answers to: a Sputnik DAO, whose members sign in, or any other
         * account, which signs in itself (src/gateway/roles.ts).
         */
        owner: z.string().min(2),
        envFile: z.string().optional(),
        port: z.number().int().min(1024).max(65535),
        /** false: the server here only reads and files owner proposals; another host executes for this agent. */
        executor: z.boolean().default(true),
      }),
    )
    .min(0),
});
type Config = z.infer<typeof Config>;
export type AgentEntry = Config["agents"][number];

export function loadConfig(file = process.env.DASHBOARD_FILE ?? fileURLToPath(new URL("../../deploy/treasury.json", import.meta.url))): Config {
  const config = Config.parse(JSON.parse(readFileSync(file, "utf8")));
  if (config.signin_hosts.some(host => config.redirect_hosts.some(alias => alias.toLowerCase() === host.toLowerCase())))
    throw new Error("A signing host cannot also redirect");
  if (!config.agents.length && process.env.TREASURY_SELF_SERVICE !== "true") throw new Error("Configure an agent or explicitly enable Treasury self-service");
  const names = new Set(config.agents.map((a) => a.name));
  if (names.size !== config.agents.length) throw new Error("Agent names must be unique");
  const ports = new Set(config.agents.map((a) => a.port));
  if (ports.size !== config.agents.length) throw new Error("Agent ports must be unique");
  return config;
}

/**
 * The environment an agent server the gateway runs starts with: the gateway's own (API keys and other
 * shared settings), plus the agent's settings file and port, and EXECUTOR=off when another host is
 * this agent's executor. Gateway-only settings stay out.
 */
export function childEnv(agent: AgentEntry & { envFile: string }, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { SESSION_SECRET: _secret, DASHBOARD_FILE: _file, DASHBOARD_HOST: _host, DASHBOARD_AREA: _area, EXECUTOR: _executor, ...shared } = parent;
  return { ...shared, ENV_FILE: agent.envFile, PORT: String(agent.port), ...(agent.area && { DASHBOARD_AREA: agent.area }), ...(agent.executor ? {} : { EXECUTOR: "off" }) };
}

/** A host as sign-in binds it ("dao.example.com", with a port if any), also when given as a URL. */
export const hostOf = (value: string) => (value.includes("://") ? new URL(value).host : value.replace(/\/+$/, ""));
