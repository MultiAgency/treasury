import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { executes, saveEnv } from "./env.js";
import { Strategy, strategyDigest } from "./strategy-digest.js";
import { loadStrategy, saveStrategy, STRATEGY_FILE } from "./strategy.js";
import { readStrategyStatus } from "./strategy-status.js";

// These controls serialize dashboard configuration on one host, not distributed executors.
// No owner or money lock is acquired here; dispatch still checks each individual operation.
async function controlled<T>(work: (assertHeld: () => void) => Promise<T> | T): Promise<T> {
  if (!executes()) throw new Error("Change strategy settings on the executor.");
  mkdirSync(dirname(STRATEGY_FILE), { recursive: true });
  let held = true;
  const release = await lockfile.lock(`${STRATEGY_FILE}.control`, {
    realpath: false, stale: 10_000,
    retries: { retries: 100, minTimeout: 100, maxTimeout: 100 },
    onCompromised: () => { held = false; },
  });
  const assertHeld = () => { if (!held) throw new Error("Strategy settings lock lost; refresh before trying again."); };
  try { assertHeld(); return await work(assertHeld); }
  finally { if (held) { held = false; await release(); } }
}

const snapshot = () => {
  const strategy = loadStrategy();
  return { strategy, digest: strategyDigest(strategy), on: process.env.AUTOPILOT === "on" };
};
function reviewed(expectedDigest: string) {
  const current = snapshot();
  if (current.digest !== expectedDigest) throw new Error("The saved strategy changed. Compare it with your draft and review again.");
  return current;
}

/** Persist off first: a failed strategy replacement or process exit cannot enable the new strategy. */
function saveOff(strategy: Strategy) {
  saveEnv({ AUTOPILOT: "" });
  saveStrategy(strategy);
  return snapshot();
}
export function saveReviewedStrategy(strategy: Strategy, expectedDigest: string) {
  const checked = Strategy.parse(strategy);
  if (checked.autopilot.everyMin > 1440 || checked.autopilot.maxUsd > 1_000_000)
    throw new Error("Schedule must be at most 1440 minutes and the automatic ceiling at most $1,000,000.");
  return controlled(() => { reviewed(expectedDigest); return saveOff(checked); });
}
async function enable(expectedDigest: string, assertHeld: () => void) {
  reviewed(expectedDigest);
  const observation = await readStrategyStatus();
  assertHeld();
  reviewed(expectedDigest);
  if (observation.digest !== expectedDigest) throw new Error("The strategy changed during authorization review.");
  if (!observation.readiness.canEnable) throw new Error(observation.readiness.reasons.join(" "));
  saveEnv({ AUTOPILOT: "on" });
  return snapshot();
}
export const enableSchedule = (expectedDigest: string) => controlled(assertHeld => enable(expectedDigest, assertHeld));

/** Stop does not read strategy, grant, policy or operation state. */
export const stopSchedule = () => controlled(() => { saveEnv({ AUTOPILOT: "" }); return { on: false as const }; });

/** Compatibility route: old clients may stop, but cannot overwrite a strategy or silently enable it. */
export function setLegacySchedule(input: { on: boolean; everyMin: number; maxUsd: number; expectedDigest?: string }) {
  return controlled(async assertHeld => {
    const current = snapshot();
    const changed = input.everyMin !== current.strategy.autopilot.everyMin || input.maxUsd !== current.strategy.autopilot.maxUsd;
    if (!input.on && !changed) { saveEnv({ AUTOPILOT: "" }); return snapshot(); }
    if (!input.expectedDigest) throw new Error("Review the strategy digest before changing or enabling the schedule.");
    reviewed(input.expectedDigest);
    if (input.on) {
      if (changed) throw new Error("Save changed settings with the schedule off, then enable separately.");
      return enable(input.expectedDigest, assertHeld);
    }
    return saveOff({ ...current.strategy, autopilot: { everyMin: input.everyMin, maxUsd: input.maxUsd } });
  });
}
