import { open, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Tick } from "./evidence.js";
import { tickLog } from "./agui.js";
import { readProgress } from "./run-progress.js";
import { readJournalHistory } from "./journal-history.js";
import { DisplaySchema, PlanSchema, SeenSchema, StartSchema, id, iso, text, type Gap } from "./run-log-schema.js";

const MAX_LINE_BYTES = 8_000_000;
// Budget stays unknown here: tickLog projects only the recognized budget fields and reports gaps.
const seen = z.union([SeenSchema.options[0], SeenSchema.options[1].extend({ budget: z.unknown() })]);
const EndSchema = z.object({ progressIncomplete: z.boolean().optional(), kind: z.literal("end"), id, endedAt: iso, before: seen, after: seen,
  plan: PlanSchema.nullable(), steps: z.array(z.object({ index: z.number().int().nonnegative(), status: id,
    correlationId: z.string().max(200), failureCode: text.nullable() })).max(500),
  shields: z.array(z.object({ asset: id, status: id, correlationId: z.string().max(200) })).max(500),
  rejected: z.array(text).max(500), refusal: text.nullable(), outcome: text });

/** Read the same append-only byte snapshot on both passes, without retaining the history. */
async function* evidenceLines(file: FileHandle, size: number) {
  const buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let position = 0;
  let line = 0;
  while (position < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) throw new Error("Evidence was truncated during export");
    position += bytesRead;
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    let offset = 0;
    for (let end; (end = pending.indexOf(10, offset)) !== -1;) {
      if (end - offset > MAX_LINE_BYTES) throw new Error("Evidence record exceeds the export limit");
      yield { line: ++line, text: pending.subarray(offset, end).toString("utf8") };
      offset = end + 1;
    }
    pending = pending.subarray(offset);
    if (pending.length > MAX_LINE_BYTES) throw new Error("Evidence record exceeds the export limit");
  }
  if (pending.length) yield { line: ++line, text: pending.toString("utf8") };
}

async function selectTick(root: string, agentId: string, tickId?: string): Promise<{ tick: Tick; gaps: Gap[] }> {
  z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).parse(agentId);
  let file: FileHandle | undefined;
  try {
    file = await open(join(root, ".evidence", `${agentId}.jsonl`), "r");
    const size = (await file.stat()).size;
    // Latest means latest timestamp, with file order breaking ties as before.
    if (tickId === undefined) {
      let latest = -Infinity;
      const startTag = z.object({ kind: z.literal("start") });
      for await (const row of evidenceLines(file, size)) {
        let raw: unknown;
        try { raw = JSON.parse(row.text); } catch { continue; }
        if (!startTag.safeParse(raw).success) continue;
        const parsed = StartSchema.safeParse(raw);
        if (parsed.success && parsed.data.agentId === agentId && Date.parse(parsed.data.at) >= latest) {
          latest = Date.parse(parsed.data.at);
          tickId = parsed.data.id;
        }
      }
    }
    let tick: Tick | undefined;
    let invalid = false;
    let foreign = false;
    const gaps: Gap[] = [];
    const gap = (code: Gap["code"], line: number) => {
      if (gaps.length >= 20_000) throw new Error("Too many evidence gaps to export");
      gaps.push({ code, line });
    };
    const tagSchema = z.object({ kind: z.enum(["start", "end"]), id });
    for await (const row of evidenceLines(file, size)) {
      if (!row.text.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(row.text); } catch { gap("evidence_malformed_line", row.line); continue; }
      const tag = tagSchema.safeParse(raw);
      if (!tag.success) { gap("evidence_malformed_line", row.line); continue; }
      const selected = tag.data.id === tickId;
      if (tag.data.kind === "start") {
        const start = StartSchema.safeParse(raw);
        if (!start.success) {
          if (selected) invalid = true;
          gap("evidence_malformed_line", row.line); continue;
        }
        if (start.data.agentId !== agentId) {
          if (selected) foreign = true;
          gap("evidence_agent_mismatch", row.line); continue;
        }
        if (!selected) continue;
        if (tick) invalid = true;
        else tick = { ...start.data, end: null };
      } else if (selected) {
        const end = EndSchema.safeParse(raw);
        if (!end.success || !tick || tick.end) {
          invalid = true; gap("evidence_invalid_end", row.line); continue;
        }
        const { kind: _kind, id: _id, ...value } = end.data;
        tick.end = value;
      }
    }
    if (!tick || foreign) throw new ORPCError("NOT_FOUND", { message: "No recorded tick was found for this agent." });
    if (invalid) throw new ORPCError("PRECONDITION_FAILED", { message: "This tick has invalid or duplicate evidence records; review them before exporting." });
    return { tick, gaps };
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ORPCError("NOT_FOUND", { message: "No recorded tick was found for this agent." });
    throw new ORPCError("PRECONDITION_FAILED", { message: "The evidence could not be read within the recording record and gap limits." });
  } finally { await file?.close(); }
}

type Token = { asset_id: string; symbol: string; decimals: number };
type TokenSnapshot = { tokens: Token[]; asOf: string };
// Display only. One bounded cache entry per server; never cache evidence or outcomes.
let tokenCache: { root: string; agentId: string; startedAt: number; value: Promise<TokenSnapshot> } | undefined;
function displayTokens(root: string, agentId: string, getTokens: () => Promise<Token[]>): Promise<TokenSnapshot> {
  root = resolve(root);
  const now = Date.now();
  if (tokenCache && tokenCache.root === root && tokenCache.agentId === agentId &&
      now >= tokenCache.startedAt && now - tokenCache.startedAt < 5 * 60_000) return tokenCache.value;
  const entry = { root, agentId, startedAt: now,
    value: Promise.resolve().then(getTokens).then(tokens => ({ tokens, asOf: new Date().toISOString() })) };
  tokenCache = entry;
  // Share in-flight reads, but allow the next request to retry any failure.
  entry.value = entry.value.catch(error => {
    if (tokenCache === entry) tokenCache = undefined;
    throw error;
  });
  return entry.value;
}
/** Called only after gateway access checks. Agent identity comes from the server, never RPC input. */
export async function exportRunLog(root: string, agentId: string, tickId: string | undefined, getTokens: () => Promise<Token[]>) {
  const { tick, gaps } = await selectTick(root, agentId, tickId);
  const needed = new Set<string>();
  if (tick.end) {
    for (const seen of [tick.end.before, tick.end.after]) if (!("error" in seen)) for (const row of seen.book) needed.add(row.asset);
    for (const leg of tick.end.plan?.legs ?? []) { needed.add(leg.from); needed.add(leg.to); }
    for (const shield of tick.end.shields) needed.add(shield.asset);
  }
  const assets: z.infer<typeof DisplaySchema>["assets"] = [];
  let displayAsOf: string | undefined;
  if (needed.size) {
    try {
      const { tokens, asOf } = await displayTokens(root, agentId, getTokens);
      displayAsOf = asOf;
      for (const asset of needed) {
        const matches = tokens.filter((t) => t.asset_id === asset);
        if (matches.length !== 1) continue;
        const parsed = DisplaySchema.shape.assets.element.safeParse({ asset, symbol: matches[0]!.symbol, decimals: matches[0]!.decimals });
        if (parsed.success) assets.push(parsed.data);
      }
    } catch { gaps.push({ code: "asset_display_unavailable" }); }
  }
  const progress = tick.progressVersion ? readProgress(root, agentId, tick.id, tick.at, tick.end?.endedAt) : { records: [], gaps: [] };
  const journal = tick.end ? readJournalHistory(root, agentId) : { agentId, records: [], gaps: [] };
  journal.gaps.push(...gaps);
  const exportedAt = new Date().toISOString();
  // A clock adjustment must not make supplementary progress hide the core record.
  // Drop the entire suffix so stage pairing and sequence order remain intact.
  const future = progress.records.findIndex(row => Date.parse(row.at) > Date.parse(exportedAt));
  if (future !== -1) {
    progress.records.splice(future);
    progress.gaps.push({ code: "clock_inconsistent" }, { code: "progress_incomplete" });
  }
  try {
    return tickLog(tick, journal, { exportedAt, display: { asOf: displayAsOf ?? exportedAt, assets }, progress: progress.records, progressGaps: progress.gaps });
  } catch {
    throw new ORPCError("PRECONDITION_FAILED", { message: "The recorded data could not be exported within the recording schema and size limits." });
  }
}
