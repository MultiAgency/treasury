import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { ballastSettings, diversificationProblemsFor } from "./ballast.ts";
import { notifier } from "./notify.ts";
import { riskWatchSettings } from "./risk.ts";
import { WATCH, type WatchedAgent } from "./watch.ts";

/** The platform's calls an hour per app credential (`hourlyLimit(1_200)` in its `app-routes.ts`), shared by every owner. */
export const APP_HOURLY_LIMIT = 1_200;
/** What `watch` may spend of it: the rest is left for owners using the proposals page. */
export const WATCH_HOURLY_BUDGET = APP_HOURLY_LIMIT / 2;
/** Reads a tick makes when no proposal of the agent's own is open: overview, unresolved and autopilot. */
const READS_PER_TICK = 3;

const agentSettings = z.strictObject({
  organization: z.string().regex(/^[a-z0-9_-]+$/, "an Organization, as consents name it (the owner's account, \".\" written \"--\")"),
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/, "an agent's name: lowercase letters, digits and hyphens, at most 32"),
  driftPoints: z.number().gt(0).max(100).default(WATCH.driftPoints),
  intervalS: z.number().int().min(WATCH.minIntervalS).default(WATCH.intervalS),
  // The platform allows a proposal at most 7 days.
  proposalHours: z.number().int().min(1).max(168).default(WATCH.proposalHours),
  /** A command and its arguments, run without a shell for each notice: a proposal, or a change in what watch is doing (`notify.ts`). */
  notify: z.array(z.string().min(1)).min(1).optional(),
  /** Ballast proposes for this agent instead of the drift rule (`ballast.ts`, #47). */
  ballast: ballastSettings.optional(),
  /** The stabilization agent runs beside Ballast (#220): with it, each tick records a risk assessment and may de-risk. */
  risk: riskWatchSettings.optional(),
});
const watchFile = z.strictObject({ agents: z.array(agentSettings) });

/**
 * Calls an hour the agents' ticks make in steady state: 3 a tick, or 1 while a proposal of the agent's own is open. A
 * tick that proposes, or that reads why it was refused, makes up to 5; neither repeats every tick.
 */
export const readsPerHour = (agents: readonly Pick<WatchedAgent, "intervalS">[]) =>
  Math.ceil(agents.reduce((sum, { intervalS }) => sum + READS_PER_TICK * 3_600 / intervalS, 0));

/**
 * The agents `watch` proposes for, from an owner-only JSON file: `{ "agents": [{ "organization", "agent", … }] }`. It
 * names a command the server runs, so others may not read or write it. Refused, naming the problem, when a setting is
 * out of range, an agent is named twice, or the agents would spend more than `WATCH_HOURLY_BUDGET` of the platform's limit.
 */
export async function loadWatchConfig(path: string): Promise<WatchedAgent[]> {
  if ((await stat(path)).mode & 0o077) throw new Error(`${path} is readable by others: it must be 0600`);
  let parsed: z.output<typeof watchFile>;
  try {
    parsed = watchFile.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : "not JSON";
    throw new Error(`${path}: ${detail}`);
  }
  const seen = new Set<string>();
  for (const { organization, agent } of parsed.agents) {
    const key = `${organization}/${agent}`;
    if (seen.has(key)) throw new Error(`${path}: ${key} is named twice`);
    seen.add(key);
  }
  // A proposal that lasts less than one interval can't be followed: no tick would land in its life.
  for (const { organization, agent, intervalS, proposalHours } of parsed.agents) {
    if (intervalS >= proposalHours * 3600)
      throw new Error(`${path}: ${organization}/${agent} ticks every ${intervalS}s, but its proposals last ${proposalHours}h (${proposalHours * 3600}s): intervalS must be shorter than a proposal's life`);
  }
  // Ballast keeps one price an hour: an agent read less often leaves gaps its oracle freezes on.
  for (const { organization, agent, intervalS, ballast } of parsed.agents) {
    if (ballast && intervalS > 3600) throw new Error(`${path}: ${organization}/${agent} runs Ballast, which needs a reading at least hourly: intervalS must be at most 3600`);
  }
  // The diversified terms compile against a treasury that can hold the floor, then every rule the book leans on: a sleeve
  // or stablecoin the platform doesn't list, a missing venue cap, a split that doesn't add to 100 are refused here, never
  // proposed on a tick. An agent without the block is the two-asset book, unchanged.
  for (const { organization, agent, ballast } of parsed.agents) {
    if (!ballast?.diversification) continue;
    const problems = diversificationProblemsFor(ballast);
    if (problems.length > 0) throw new Error(`${path}: ${organization}/${agent}: ${problems.join("; ")}`);
  }
  // The risk agent reads Ballast's mandate for the cash floor and the thresholds, and the same hourly history, of the
  // two-asset book: it doesn't run on a diversified one yet (ADR 5, ADR 6), so the two together are refused.
  for (const { organization, agent, risk, ballast } of parsed.agents) {
    if (risk && !ballast)
      throw new Error(`${path}: ${organization}/${agent} sets risk without ballast: the risk agent needs the mandate's spend terms and profile`);
    if (risk && ballast?.diversification)
      throw new Error(`${path}: ${organization}/${agent} sets risk with a diversified ballast: the risk agent assesses the two-asset book only (ADR 5)`);
  }
  const spent = readsPerHour(parsed.agents);
  if (spent > WATCH_HOURLY_BUDGET) {
    throw new Error(`${path}: these agents would make ${spent} calls an hour, more than watch's ${WATCH_HOURLY_BUDGET} (half the platform's ${APP_HOURLY_LIMIT}): fewer agents, or longer intervals`);
  }
  return parsed.agents.map(({ notify, ...settings }) => ({ ...settings, ...(notify && { notify: notifier(notify as [string, ...string[]]) }) }));
}
