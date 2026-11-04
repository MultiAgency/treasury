import type { OwnerOutput } from "@multiagency/sdk";
import { liveConsents } from "./consent.ts";
import type { Notify } from "./notify.ts";
import type { ProposalAnswer, WatchPlatform } from "./platform.ts";
import type { Requests, StoredRequest } from "./requests.ts";

/**
 * How `watch` paces itself. A tick reads 3 times (overview, unresolved, autopilot), or once while a proposal of its own
 * is live; the platform allows the deployment 1,200 calls an hour for every owner and `watch` together, so a 5-minute
 * interval spends 36 an hour per agent. After a refused proposal it waits `backoffTicks` intervals before quoting again.
 */
export const WATCH = { intervalS: 300, minIntervalS: 60, driftPoints: 5, proposalHours: 24, backoffTicks: 6 } as const;
/** The platform refuses a proposal valid for a minute or less (`expiry_invalid`). */
const MIN_VALIDITY_MS = 60_000;

/** An agent `watch` proposes for, as the server's configuration names it. */
export type WatchedAgent = {
  organization: string; agent: string;
  /** Propose once the largest gap from the targets reaches this many points of the total. */
  driftPoints: number;
  intervalS: number;
  /** How long a proposal stays open for the owner. */
  proposalHours: number;
  /** Hears of each proposal once its answer arrives. */
  notify?: Notify;
};
/** What a tick did, for the log: one line per agent per tick. */
export type WatchEvent = { organization: string; agent: string; [detail: string]: unknown };

/** Drift a rebalance can act on: the largest gap in points of the total, and the first leg it would move. */
export type Trigger = { points: number; firstLegUsd: number };
type Skip = { skipped: string; [detail: string]: unknown };

/**
 * The drift rule: propose only if a rebalance's first leg reaches `minLegUsd` and the largest gap reaches `driftPoints`
 * of the total. Mirrors the platform's `planLegs` (`src/treasury.ts`): only assets in the book count, each with its
 * target or 0, and the first leg moves `min(largest surplus, −largest deficit)`. Cost isn't known without quoting.
 */
export function drift({ book, target, rebalance: { minLegUsd } }: OwnerOutput<"overview">, driftPoints: number): Trigger | Skip {
  const unpriced = book.filter(h => h.usd === null).map(h => h.asset);
  // A rebalance values the book at fresh prices and refuses without one.
  if (unpriced.length) return { skipped: "unpriced", assets: unpriced };
  const total = book.reduce((sum, h) => sum + h.usd!, 0);
  if (!(total > 0)) return { skipped: "empty" };
  const gaps = book.map(h => h.usd! - total * (target[h.asset] ?? 0));
  const firstLegUsd = Math.min(Math.max(...gaps), -Math.min(...gaps));
  const points = Math.max(...gaps.map(Math.abs)) / total * 100;
  if (firstLegUsd < minLegUsd) return { skipped: "first leg below minLegUsd", firstLegUsd, minLegUsd };
  if (points < driftPoints) return { skipped: "drift below threshold", points, driftPoints };
  return { points, firstLegUsd };
}

/** Why an agent stopped. `resumable` ones resume once the owner's consent is live again; the others wait for a restart. */
type Stop = { reason: string; resumable: boolean };

/**
 * Proposes rebalances for the configured agents, and nothing else: it can only read and propose (`WatchPlatform`). Each
 * tick first follows the agent's stored requests: one never answered is sent again, unchanged, and one whose proposal
 * is still `proposed` or `approved` holds the agent. Otherwise it reads the agent, and proposes when it has drifted.
 * Every request is stored before it's sent (`Requests`), so a lost answer never becomes a second proposal.
 */
export function createWatch({ platform, requests, publicOrigin, now = Date.now }: {
  platform: WatchPlatform; requests: Requests;
  /** This server's origin, where the owner opens a proposal. */
  publicOrigin: string;
  now?: () => number;
}) {
  const agents = new Map<string, { backoffUntil: number; stopped?: Stop }>();
  const stateOf = ({ organization, agent }: WatchedAgent) => {
    const key = `${organization}/${agent}`;
    if (!agents.has(key)) agents.set(key, { backoffUntil: 0 });
    return agents.get(key)!;
  };

  /** Whether the owner's consent for this app is live: what a `forbidden` answer on the app route turns on (#20). */
  const connected = async ({ organization, agent }: WatchedAgent) => {
    const [{ answer: identity }, listed] = await Promise.all([platform.identity(agent, { fresh: true }), platform.consents(organization)]);
    return identity.ok && listed.ok && liveConsents(listed.value.consents, identity.value, now()).length > 0;
  };
  /** Stops the agent after a `forbidden`: until the owner connects again, or, with a live consent, until a restart. */
  const stop = async (watched: WatchedAgent, event: (detail: Record<string, unknown>) => WatchEvent) => {
    const state = stateOf(watched);
    if (await connected(watched)) {
      state.stopped = { reason: "forbidden with a live consent", resumable: false };
      return event({ stopped: state.stopped.reason, note: "the platform refused a call this app's consent covers: a bug to report, never retried" });
    }
    state.stopped = { reason: "not connected", resumable: true };
    return event({ stopped: state.stopped.reason, note: "the owner's consent for this app has ended: they connect again on the proposals page" });
  };

  /** Sends `request` and records what its answer says. A lost answer keeps it, to be sent again unchanged. */
  const send = async (watched: WatchedAgent, request: StoredRequest, event: (detail: Record<string, unknown>) => WatchEvent, points?: number) => {
    const { organization, agent } = watched, state = stateOf(watched);
    const answer: ProposalAnswer = await platform.create(organization, agent, requests.input(request));
    if (answer.ok) {
      const { id, expiresAt } = answer.value;
      await requests.settle(request, id);
      const proposed = event({ proposed: id, requestId: request.requestId, expiresAt, ...(points !== undefined && { points }) });
      if (!watched.notify) return proposed;
      const secondsLeft = Math.max(0, Math.floor((Date.parse(expiresAt) - now()) / 1000));
      const notified = await watched.notify({ organization, agent, proposalId: id, expiresAt, secondsLeft, ...(points !== undefined && { points }),
        page: `${publicOrigin}/agents/${agent}/proposals/${id}` });
      return { ...proposed, notified };
    }
    const backoff = () => { state.backoffUntil = now() + WATCH.backoffTicks * watched.intervalS * 1000; };
    if (answer.kind === "refused") {
      // A refusal stores nothing, so the request can go.
      await requests.drop(request);
      switch (answer.code) {
        case "not_proposable": backoff(); return event({ skipped: "not proposable", error: answer.error, backoffTicks: WATCH.backoffTicks });
        case "too_many_proposals": backoff(); return event({ held: "too many proposals", backoffTicks: WATCH.backoffTicks });
        // Made under a consent that has since ended.
        case "withdrawn": return stop(watched, event);
      }
      state.stopped = { reason: `refused: ${answer.code ?? answer.error}`, resumable: false };
      return event({ stopped: state.stopped.reason, note: "a request this server built was refused: a bug to report" });
    }
    if (answer.kind === "forbidden") { await requests.drop(request); return stop(watched, event); }
    // The gateway answers a request it refuses with a plain 4xx, which the SDK reports as unknown: nothing reached the agent.
    if (answer.kind === "unknown" && answer.httpStatus !== undefined && answer.httpStatus >= 400 && answer.httpStatus < 500 && answer.httpStatus !== 408 && answer.httpStatus !== 429) {
      await requests.drop(request);
      state.stopped = { reason: `refused by the gateway (${answer.httpStatus})`, resumable: false };
      return event({ stopped: state.stopped.reason, note: "a request this server built was refused: a bug to report" });
    }
    return event({ failed: "proposals/create", kind: answer.kind, requestId: request.requestId, note: "sent again, unchanged, next tick" });
  };

  return {
    /** One tick for `watched`: at most one proposal, and one event describing what happened. */
    async tick(watched: WatchedAgent): Promise<WatchEvent> {
      const { organization, agent } = watched, state = stateOf(watched);
      const event = (detail: Record<string, unknown>): WatchEvent => ({ organization, agent, ...detail });

      if (state.stopped) {
        if (!state.stopped.resumable) return event({ skipped: "stopped", stopped: state.stopped.reason });
        if (!await connected(watched)) return event({ skipped: "not connected" });
        state.stopped = undefined;
      }

      for (const request of requests.of(organization, agent)) {
        if (request.proposalId === null) {
          // Unanswered: send it again, unchanged, unless the platform would refuse it as expiring (it answers a stored
          // one whatever its expiry, so one stored and expired this close is harmless to forget).
          if (Date.parse(requests.input(request).expiresAt) - now() <= MIN_VALIDITY_MS) { await requests.drop(request); continue; }
          return send(watched, request, event);
        }
        const read = await platform.get(organization, agent, request.proposalId);
        if (!read.ok) {
          if (read.kind === "forbidden") return stop(watched, event);
          if (read.kind === "refused" && read.code === "not_found") { await requests.drop(request); continue; }
          return event({ failed: "proposals/get", kind: read.kind, proposalId: request.proposalId });
        }
        const { state: proposalState } = read.value;
        if (proposalState === "proposed" || proposalState === "approved") return event({ skipped: "live proposal", proposalId: request.proposalId, state: proposalState });
        // Claimed or closed: no longer ours to hold for. An execution still in doubt holds the agent through `unresolved`.
        await requests.drop(request);
      }

      const [overview, unresolved, autopilot] = await Promise.all([
        platform.overview(organization, agent), platform.unresolved(organization, agent), platform.autopilot(organization, agent)]);
      if (!overview.ok || !unresolved.ok || !autopilot.ok) {
        const failed = Object.entries({ overview, unresolved, "autopilot/get": autopilot }).flatMap(([name, result]) => result.ok ? [] : [{ name, kind: result.kind }]);
        if (failed.some(({ kind }) => kind === "forbidden")) return stop(watched, event);
        return event({ failed: failed.map(({ name }) => name), kinds: failed.map(({ kind }) => kind) });
      }
      if (unresolved.value.length) return event({ held: "unresolved", operations: unresolved.value.length });
      // Two proposers on one agent would race; turning autopilot off is the owner's call.
      if (autopilot.value.on) return event({ held: "autopilot" });
      if (overview.value.notInForce) return event({ held: "policy not in force", notInForce: overview.value.notInForce });
      if (now() < state.backoffUntil) return event({ skipped: "backoff", until: new Date(state.backoffUntil).toISOString() });
      const trigger = drift(overview.value, watched.driftPoints);
      if ("skipped" in trigger) return event(trigger);

      const request = await requests.add(organization, agent, {
        legs: "strategy", expiresAt: new Date(now() + watched.proposalHours * 3_600_000).toISOString(),
        note: `Drift ${trigger.points.toFixed(1)} points from the targets`,
      });
      if (!request) return event({ held: "stored requests full" });
      return send(watched, request, event, trigger.points);
    },
  };
}

/**
 * Runs `watch` for each agent on its own interval until `signal` ends it: a tick, its event logged, then a sleep. Once
 * stopped, no tick starts, and the returned promise ends after the ticks in flight have finished and been logged, so
 * the server stops with every stored request written. A tick that throws (the request store couldn't be written) is
 * logged by its message, and the agent goes on at its next interval.
 */
export async function runWatch({ watch, agents, log, sleep, signal }: {
  watch: { tick(agent: WatchedAgent): Promise<WatchEvent> };
  agents: readonly WatchedAgent[];
  log: (event: WatchEvent) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}) {
  await Promise.all(agents.map(async agent => {
    while (!signal.aborted) {
      try { log(await watch.tick(agent)); } catch (error) {
        log({ organization: agent.organization, agent: agent.agent, failed: "tick", error: error instanceof Error ? error.message : String(error) });
      }
      if (!signal.aborted) await sleep(agent.intervalS * 1000, signal);
    }
  }));
}
