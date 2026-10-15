import { closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendSynced } from "./synced.js";
import { ProgressRecordSchema, type ProgressEvent, type ProgressRecord } from "./run-progress-schema.js";

const MAX_BYTES = 1_000_000;
const pathFor = (root: string, agentId: string, tickId: string) => {
  if (![agentId, tickId].every(id => /^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new Error("Invalid progress identity");
  return join(root, ".evidence", "progress", agentId, `${tickId}.jsonl`);
};

/** Supplementary observations only. Failure never changes submission or settlement decisions. */
export function progressRecorder(root: string, agentId: string, tickId: string) {
  let sequence = 0;
  let failed = false;
  const record = (event: ProgressEvent) => {
    if (failed) return;
    try {
      const path = pathFor(root, agentId, tickId);
      const row = ProgressRecordSchema.parse({ version: 1, agentId, tickId, sequence: ++sequence, at: new Date().toISOString(), event });
      mkdirSync(dirname(path), { recursive: true });
      appendSynced(path, row);
    } catch {
      failed = true;
      console.warn(`Run progress unavailable for ${tickId}; the operation journal remains authoritative.`);
    }
  };
  return { record, get failed() { return failed; } };
}

/** Return only a validated prefix. A torn/conflicting record never manufactures a finished stage. */
export function readProgress(root: string, agentId: string, tickId: string, startedAt: string, endedAt?: string) {
  const records: ProgressRecord[] = [];
  const gaps: { code: string }[] = [];
  let fd: number | undefined;
  try {
    fd = openSync(pathFor(root, agentId, tickId), "r");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_BYTES) throw new Error("Progress too large");
    const active = new Set<string>(), finished = new Set<string>();
    let previous = Date.parse(startedAt);
    for (const line of bytes.subarray(0, size).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = ProgressRecordSchema.parse(JSON.parse(line));
      const time = Date.parse(row.at);
      if (row.agentId !== agentId || row.tickId !== tickId || row.sequence !== records.length + 1 || time < previous || (endedAt && time > Date.parse(endedAt))) throw new Error("Progress identity/order mismatch");
      const event = row.event;
      if (event.type === "STEP_STARTED") {
        if (active.has(event.stepName) || finished.has(event.stepName)) throw new Error("Repeated stage");
        active.add(event.stepName);
      } else if (event.type === "STEP_FINISHED") {
        if (!active.delete(event.stepName)) throw new Error("Stage never started");
        finished.add(event.stepName);
      }
      previous = time;
      records.push(row);
    }
    if (!records.length) gaps.push({ code: "progress_unavailable" });
    // A completed run can still have a stage that threw or lost its last observation.
    if (endedAt && active.size) gaps.push({ code: "progress_incomplete" });
  } catch { gaps.push({ code: "progress_unavailable" }); }
  finally { if (fd !== undefined) closeSync(fd); }
  return { records, gaps };
}
