// "Since you last looked" on Home (#263): what the autopilot, the proposals and the risk assessments did since the
// owner's last visit. Pure apart from the storage it is handed, so it is tested without a browser. With its extension:
// test/since-view.test.ts loads this module under Node.
//
// The last visit is kept in the browser only, per agent and account: no server state. Without one, the last seven
// days are summarized, and the card says so.

export const FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the last visit is kept: one key per account and agent, so another owner on the same browser has their own. */
export const visitKey = (account: string, agent: string) => `treasury:last-visit:${account}:${agent}`;

/** The slice of `Storage` used, so a test can hand it a map and a private window's throwing accessor is survivable. */
export type Keep = Pick<Storage, "getItem" | "setItem">;

/** The saved last visit (ms), or null when there is none, it isn't a time, it lies in the future, or storage can't be read. */
export function lastVisit(keep: Keep | undefined, key: string, now: number): number | null {
  try {
    const raw = keep?.getItem(key);
    const time = raw == null ? NaN : Number(raw);
    return Number.isFinite(time) && time > 0 && time <= now ? time : null;
  } catch { return null; }
}

/** Remembers a visit; storage that is full, blocked or missing is ignored, and the card then falls back to seven days. */
export function rememberVisit(keep: Keep | undefined, key: string, now: number): void {
  try { keep?.setItem(key, String(now)); } catch { /* the page works without it */ }
}

/** The time to summarize from, and whether it is the seven-day fallback because no earlier visit is known. */
export const sinceFrom = (visit: number | null, now: number): { since: number; fallback: boolean } =>
  visit === null ? { since: now - FALLBACK_MS, fallback: true } : { since: visit, fallback: false };

/** A visit is observed only after every input succeeded after it opened; cached/failed reads retain the old cutoff. */
export function observedVisit(openedAt: number, reads: readonly { isSuccess: boolean; dataUpdatedAt: number }[]): number | null {
  return reads.length > 0 && reads.every(read => read.isSuccess && read.dataUpdatedAt >= openedAt) ? openedAt : null;
}

type Dated = { at?: string; createdAt?: string };
const after = (since: number) => (item: Dated) => Date.parse(item.at ?? item.createdAt ?? "") > since;

export type Since = { runs: number; proposals: number; assessments: number; latestLevel: number | null; highestLevel: number | null };

/** What happened after `since`. An entry whose time can't be read isn't counted, and the latest assessment is the newest by time. */
export function summarize({ since, runs, proposals, assessments }: {
  since: number; runs: readonly { at: string }[]; proposals: readonly { createdAt: string }[]; assessments: readonly { at: string; level: number }[];
}): Since {
  const recent = assessments.filter(after(since)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    runs: runs.filter(after(since)).length, proposals: proposals.filter(after(since)).length, assessments: recent.length,
    latestLevel: recent[0]?.level ?? null, highestLevel: recent.length ? Math.max(...recent.map(entry => entry.level)) : null,
  };
}

const times = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The summary's lines, in words; empty when nothing happened. `levelName` names a risk level (`levelView(level).label`). */
export function sinceLines(since: Since, levelName: (level: number) => string): string[] {
  const lines: string[] = [];
  if (since.runs > 0) lines.push(`Autopilot ran ${times(since.runs, "time")}.`);
  if (since.proposals > 0) lines.push(`${times(since.proposals, "proposal")} ${since.proposals === 1 ? "was" : "were"} made.`);
  if (since.assessments > 0 && since.latestLevel !== null && since.highestLevel !== null) {
    lines.push(`The risk was assessed ${times(since.assessments, "time")}; the latest is ${levelName(since.latestLevel)}${since.highestLevel > since.latestLevel ? `, and it reached ${levelName(since.highestLevel)}` : ""}.`);
  }
  return lines;
}
