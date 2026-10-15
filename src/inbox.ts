import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { join } from "node:path";
import { agentId } from "./env.js";
import { appendSynced } from "./synced.js";
import { readRecordLines } from "./record-lines.js";

/**
 * What the agent tells its owner while no one is watching, `.inbox/<agent id>.jsonl`, append-only
 * like the ops log. A `run` entry records one autopilot tick; `warn` and `action` entries ask for the
 * owner and stay open until dismissed.
 */

type Level = "run" | "warn" | "action";
type Entry = { id: string; at: string; level: Level; text: string; dismissed?: boolean };

type Line = Omit<Entry, "dismissed"> | { dismiss: string };
const storedLine = z.union([
  z.object({ id: z.string().min(1), at: z.string().refine(value => Number.isFinite(Date.parse(value))),
    level: z.enum(["run", "warn", "action"]), text: z.string() }),
  z.object({ dismiss: z.string().min(1) }),
]);

const file = () => {
  mkdirSync(".inbox", { recursive: true });
  return join(".inbox", `${agentId()}.jsonl`);
};

export function post(level: Level, text: string): Entry {
  const entry = { id: randomUUID(), at: new Date().toISOString(), level, text };
  appendSynced(file(), entry satisfies Line);
  return entry;
}

export function dismiss(id: string) {
  appendSynced(file(), { dismiss: id } satisfies Line);
}

/** Every entry, newest first, with whether the owner dismissed it. */
export function readInbox(): Entry[] {
  const path = file();
  if (!existsSync(path)) return [];
  const entries = new Map<string, Entry>();
  for (const line of readRecordLines(path, storedLine)) {
    if ("dismiss" in line) {
      const entry = entries.get(line.dismiss);
      if (entry) entry.dismissed = true;
    } else entries.set(line.id, { ...line });
  }
  return [...entries.values()].reverse();
}
