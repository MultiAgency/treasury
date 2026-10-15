import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { id, iso, type Gap, type JournalHistory, type JournalRecord } from "./run-log-schema.js";

const MAX_BYTES = 8_000_000;
const MAX_LINES = 20_000;
const safeAgent = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/, "Invalid agent ID");
const request = z.object({ request: z.record(z.string(), z.unknown()), kind: id,
  method: z.enum(["swap", "transfer", "shield", "unshield"]).optional(), planId: id.optional() });

/** Pure parsing of a bounded, agent-scoped journal snapshot. Never return raw input in errors. */
export function parseJournalHistory(agentId: string, source: string): JournalHistory {
  safeAgent.parse(agentId);
  const records: JournalRecord[] = [];
  const gaps: Gap[] = [];
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES) return { agentId, records, gaps: [{ code: "journal_too_large" }] };
  const lines = source.split("\n");
  for (let index = 0; index < Math.min(lines.length, MAX_LINES); index++) {
    const line = index + 1;
    if (!lines[index]!.trim()) continue;
    try {
      const raw = JSON.parse(lines[index]!);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
      const idempotencyKey = id.parse(raw.idempotencyKey);
      const tags = ["request", "submissionState", "correlation_id", "refused"].filter((key) => key in raw);
      if (tags.length !== 1) throw new Error();
      const time = iso.safeParse(raw.at);
      const projected: JournalRecord = { line, idempotencyKey, recordedAt: time.success ? time.data : null, type: "request" };
      switch (tags[0]) {
        case "request": {
          const parsed = request.parse(raw);
          if (parsed.method) projected.method = parsed.method;
          if (parsed.planId) projected.planId = parsed.planId;
          break;
        }
        case "submissionState":
          if (raw.submissionState !== "SUBMISSION_ATTEMPTED") throw new Error();
          projected.type = "submission-claim";
          break;
        case "correlation_id":
          projected.type = "status";
          projected.correlationId = id.parse(raw.correlation_id);
          projected.status = id.parse(raw.status);
          break;
        case "refused":
          projected.type = "refusal";
          projected.refusal = id.parse(raw.refused);
          break;
      }
      records.push(projected);
      if (!time.success) gaps.push({ code: raw.at === undefined ? "timestamp_missing" : "timestamp_invalid", line });
    } catch { gaps.push({ code: "malformed_line", line }); }
  }
  if (lines.slice(MAX_LINES).some((line) => line.trim())) gaps.push({ code: "journal_line_limit" });
  return { agentId, records, gaps };
}

/** Reads only .ops/<agent>.jsonl under the explicit state root. No environment, mkdir, recovery or writes. */
export function readJournalHistory(root: string, agentId: string): JournalHistory {
  safeAgent.parse(agentId);
  let fd: number | undefined;
  try {
    fd = openSync(join(root, ".ops", `${agentId}.jsonl`), "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_BYTES) return { agentId, records: [], gaps: [{ code: "journal_too_large" }] };
    return parseJournalHistory(agentId, buffer.subarray(0, size).toString("utf8"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { agentId, records: [], gaps: [{ code: missing ? "journal_missing" : "journal_unavailable" }] };
  } finally { if (fd !== undefined) closeSync(fd); }
}
