import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { ENV_FILE } from "./env.js";
import { DEFAULT_STRATEGY, Strategy } from "./strategy-digest.js";
import { writeAtomic } from "./synced.js";

/** This instance's strategy file, `.strategy/<settings file>.json`; without one, the defaults apply. */
export const STRATEGY_FILE = join(".strategy", `${basename(ENV_FILE)}.json`);

/** This instance's strategy, read on use so an edit applies at once; refuses a file that doesn't parse. */
export function loadStrategy(): Strategy {
  if (!existsSync(STRATEGY_FILE)) return DEFAULT_STRATEGY;
  const parsed = Strategy.safeParse(JSON.parse(readFileSync(STRATEGY_FILE, "utf8")));
  if (!parsed.success) throw new Error(`${STRATEGY_FILE}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Replaces this instance's strategy, whole: checked first, then written and renamed over the old file. */
export function saveStrategy(strategy: Strategy) {
  const checked = Strategy.parse(strategy);
  mkdirSync(dirname(STRATEGY_FILE), { recursive: true });
  writeAtomic(STRATEGY_FILE, `${JSON.stringify(checked, null, 2)}\n`);
}
