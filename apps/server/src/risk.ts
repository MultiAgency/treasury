// The stabilization agent's server side (#220): the watch file's `risk` block, the thresholds a mandate may override,
// and the report the owner reads back from the audit log. The assessment itself, and the record it is written as,
// are made in `ballast.ts`, where the same overview, policy, bounds, turnover and state are already read; this module
// holds what both sides share: the configuration schemas, and reading the latest record for `GET …/risk`.
//
// It adds no platform read: the assessment runs on the overview a tick already reads and the price history it keeps.
// Everything fails closed: settings are checked with the core's own checks, a record that can't be read is no
// assessment, and a reader that can't read the log answers nothing rather than guessing.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PROJECTION_DEFAULTS, projectionParamsProblems, riskThresholdProblems, SCENARIO_DEFAULTS,
  scenarioParamsProblems, whatIf, type ProjectionParams, type RiskRecord, type RiskThresholds, type ScenarioParams, type WhatIf,
} from "../../../packages/core/src/index.ts";
import { auditSegments } from "./chain.ts";
import type { RiskHistoryEntry, RiskReport, RiskWhatIfRead } from "./contract.ts";

/**
 * The venues a book can name. SDK 0.5.4 has no venue ID: an agent's assets are held and settle at its NEAR Intents
 * account, which the docs and the scenarios call "NEAR Intents". The shape is here so a second venue is one entry.
 */
/**
 * A deployment's own projection parameters: whatever it names, over the core's defaults, checked with the core's own
 * `projectionParamsProblems`, so a value the projection would fail closed on refuses the watch file at startup instead.
 */
export const riskProjectionSettings = z.strictObject({
  horizonDays: z.number().optional(), paths: z.number().optional(), lookbackDays: z.number().optional(),
  confidencePct: z.number().optional(), seed: z.number().optional(), liquidationHaircutPct: z.number().optional(),
  volHalfLifeHours: z.number().optional(), maxGapMs: z.number().optional(), maxAgeMs: z.number().optional(),
}).superRefine((value, ctx) => {
  for (const problem of projectionParamsProblems({ ...PROJECTION_DEFAULTS, ...value })) ctx.addIssue({ code: "custom", message: problem });
});
/** A deployment's own scenario parameters, checked the same way. */
export const riskScenarioSettings = z.strictObject({
  volatileDropsPct: z.array(z.number()).min(1).optional(), stablePrices: z.array(z.number()).min(1).optional(),
  venueOutageDays: z.array(z.number()).min(1).optional(), staleDays: z.number().optional(), spendFactor: z.number().optional(),
}).superRefine((value, ctx) => {
  for (const problem of scenarioParamsProblems({ ...SCENARIO_DEFAULTS, ...value })) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * An agent's `risk` block in the watch file: it turns the stabilization step on, and may name its projection and
 * scenario parameters. The thresholds come from the mandate's profile, unless the agent's `ballast.risk` overrides them.
 */
export const riskWatchSettings = z.strictObject({
  projection: riskProjectionSettings.optional(),
  scenarios: riskScenarioSettings.optional(),
});
export type RiskSettings = z.output<typeof riskWatchSettings>;

/** The projection parameters a risk block names, over the core's defaults. */
export const projectionOf = (settings?: RiskSettings): ProjectionParams =>
  ({ ...PROJECTION_DEFAULTS, ...(settings?.projection ?? {}) }) as ProjectionParams;
/** The scenario parameters a risk block names, over the core's defaults. */
export const scenariosOf = (settings?: RiskSettings): ScenarioParams =>
  ({ ...SCENARIO_DEFAULTS, ...(settings?.scenarios ?? {}) }) as ScenarioParams;

const riskSteps = z.strictObject({ l1: z.number(), l2: z.number(), l3: z.number() });
/**
 * A mandate's risk thresholds, as `ballast.risk` may set them (a mandate parameter, profile defaults otherwise). The
 * core's `riskThresholdProblems` is the check: a set it refuses refuses the watch file, so nothing is sized on it.
 */
export const riskThresholdSettings = z.strictObject({
  drawdownPct: riskSteps, shortfallPct: riskSteps, breachProbabilityPct: riskSteps,
  monthsToFloor: z.strictObject({ l1: z.number(), l2: z.number() }),
  freezeShortfallPct: z.number(), targetDrawdownPct: z.number(),
}).superRefine((value, ctx) => {
  for (const problem of riskThresholdProblems(value as RiskThresholds)) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * A risk record as the audit log keeps it: the core's record (every input and the assessment made from them, enough to
 * replay it) plus the agent, and for a de-risk sell that passed, the `requestId` its request is stored and sent under.
 */
export type RiskEntry = RiskRecord & { organization: string; agent: string; requestId?: string };
/** One risk record read back from the log, with the chain's time and sequence number. */
export type StoredRisk = { seq: number; at: string; entry: RiskEntry };
/** The latest risk record for an agent, or null when none was recorded: the route computes nothing. */
export type LatestRisk = (organization: string, agent: string) => Promise<StoredRisk | null>;

/**
 * The latest risk record for an agent, read from the log's segments newest first: the open segment nearly always holds
 * it, and an agent quiet since the last rotation is found in the closed ones only when it isn't there. A line that isn't
 * a record is skipped (a crash can tear the last write); no risk record is null, whatever else the log holds.
 */
export async function latestRiskRecord(file: string, organization: string, agent: string): Promise<StoredRisk | null> {
  const segments = await auditSegments(file);
  for (const segment of [...segments].reverse()) {
    const text = await readFile(segment, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: { seq?: unknown; at?: unknown; entry?: unknown };
      try { parsed = JSON.parse(lines[i]!) as typeof parsed; } catch { continue; }
      const entry = parsed?.entry as Partial<RiskEntry> | undefined;
      if (entry?.kind !== "risk" || entry.organization !== organization || entry.agent !== agent) continue;
      if (typeof parsed.seq !== "number" || typeof parsed.at !== "string" || !entry.input || !entry.assessment) continue;
      return { seq: parsed.seq, at: parsed.at, entry: entry as RiskEntry };
    }
  }
  return null;
}

/** The reader the server's route uses: answers one agent's latest risk record from the audit log, and no platform read. */
export const createRiskReader = (file: string): LatestRisk => (organization, agent) => latestRiskRecord(file, organization, agent);

/**
 * A stored record as the owner's pages read it: the level and its reasons, the projection's figures, every scenario, and
 * what the agent would do (all four actions, and for a de-risk sell its size and why it isn't proposed when it isn't).
 * `derisk` is the recommendation's, not a proposal: the server's own `requestId` in the record is the proof one was
 * proposed, and the audit log keeps the whole assessment for a replay.
 */
export function riskReportOf({ seq, at, entry }: StoredRisk): RiskReport {
  const { assessment } = entry;
  const derisk = assessment.recommendations.find(r => r.action === "de-risk");
  return {
    at,
    seq,
    level: assessment.level,
    reason: assessment.detections.length > 0
      ? assessment.detections.map(d => d.reason).join("; ")
      : "no forward risk detected: the projection and every stress scenario are within their steps",
    projection: {
      usable: assessment.projection.usable, reasons: assessment.projection.reasons,
      projectedDrawdownPct: assessment.projection.projectedDrawdownPct, expectedShortfallPct: assessment.projection.expectedShortfallPct,
      breachProbabilityPct: assessment.projection.breachProbabilityPct, runwayMonths: assessment.projection.runwayMonths,
      monthsToFloor: assessment.projection.monthsToFloor, volatileSharePct: assessment.projection.volatileSharePct,
    },
    scenarios: assessment.scenarios.map(s => ({ id: s.id, label: s.label, valueUsd: s.valueUsd, lossUsd: s.lossUsd, drawdownPct: s.drawdownPct,
      stableUsd: s.stableUsd, runwayMonths: s.runwayMonths, floorUsd: s.floorUsd, floorBreached: s.floorBreached, unfundedUsd: s.unfundedUsd, tradable: s.tradable })),
    recommendations: assessment.recommendations.map(r => r.action === "de-risk"
      ? { action: r.action, asset: r.asset, into: r.into, sizeUsd: r.sizeUsd, reason: r.reason, blocked: r.blocked }
      : { action: r.action, reason: r.reason }),
    derisk: derisk?.action === "de-risk" ? { sizeUsd: derisk.sizeUsd, blocked: derisk.blocked } : null,
    proposed: entry.requestId !== undefined,
  };
}

/** The latest records of an agent, newest first: at most `limit` (the log is read newest segment first, so this stops early). */
export type RiskHistory = (organization: string, agent: string, limit: number) => Promise<StoredRisk[]>;

/**
 * An agent's newest risk records, newest first, read from the log's segments newest first and stopping once `limit` are
 * found. A line that isn't a record is skipped, as in `latestRiskRecord`; none is an empty list, whatever else the log holds.
 */
export async function riskRecords(file: string, organization: string, agent: string, limit: number): Promise<StoredRisk[]> {
  const found: StoredRisk[] = [];
  if (!(limit >= 1)) return found;
  for (const segment of [...(await auditSegments(file))].reverse()) {
    const text = await readFile(segment, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
      let parsed: { seq?: unknown; at?: unknown; entry?: unknown };
      try { parsed = JSON.parse(lines[i]!) as typeof parsed; } catch { continue; }
      const entry = parsed?.entry as Partial<RiskEntry> | undefined;
      if (entry?.kind !== "risk" || entry.organization !== organization || entry.agent !== agent) continue;
      if (typeof parsed.seq !== "number" || typeof parsed.at !== "string" || !entry.input || !entry.assessment) continue;
      found.push({ seq: parsed.seq, at: parsed.at, entry: entry as RiskEntry });
    }
    if (found.length >= limit) break;
  }
  return found;
}

export const createRiskHistoryReader = (file: string): RiskHistory => (organization, agent, limit) => riskRecords(file, organization, agent, limit);

/** One record as the agent's activity list reads it: when, the level and why, what it would do, and whether it proposed. */
export function riskHistoryEntryOf({ seq, at, entry }: StoredRisk): RiskHistoryEntry {
  const report = riskReportOf({ seq, at, entry });
  return { at, seq, level: report.level, reason: report.reason, actions: report.recommendations.map(r => r.action), proposed: report.proposed,
    drawdownPct: report.projection.usable ? report.projection.projectedDrawdownPct : null };
}

/**
 * The owner's what-if over the latest record's book and spend terms: the same stress run the agent's scenarios use, so
 * the answer is the agent's own arithmetic, not a second model of it. It reads no platform and writes nothing. No record
 * is no answer, said as such; an event the core refuses comes back with its reasons.
 */
export function riskWhatIfOf(stored: StoredRisk | null, event: WhatIf): RiskWhatIfRead {
  if (!stored) return { result: null, problems: ["no risk assessment has been recorded for this agent yet, so there is no book to run the event on"] };
  const { input } = stored.entry;
  const run = whatIf(input.book, input.terms, event);
  if (!run.ok) return { result: null, problems: run.problems };
  return { problems: [], result: { basedOn: { at: stored.at, seq: stored.seq }, label: run.label, now: run.now, after: run.after } };
}
