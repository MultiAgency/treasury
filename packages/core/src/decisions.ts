// A7.2 (#54): every decision is recorded with the inputs it was made from, so replaying the log through the engines
// gives the same decision, and a replay that doesn't names the first record that differs.
//
// A record holds the oracle reading, the engine's input (portfolio, bounds, sizing and anti-whipsaw state, regime) and
// config, the intent the band engine made, and, when the intent went to the policy, the policy's context, config and
// result. It is stored as the log stores everything, as JSON: `decide` builds the record from the JSON form of its
// inputs, so the decision it reports is the one a replay of the stored record makes. Wiring the engines into the
// server's loop, which then appends these records to the audit log, is A10.1 (#60).

import { checkPolicy, type FullContext, type PolicyConfig } from "./check.ts";
import { canonicalJson } from "./digest.ts";
import { evaluateBands, type EngineConfig, type EngineInput } from "./engine.ts";
import type { Intent } from "./bands.ts";
import type { OracleReading } from "./oracle.ts";
import type { PolicyResult } from "./policy.ts";

/** One decision with everything it was made from. `kind` is the audit log's (`chain.ts`'s `AUDIT_KINDS`). */
export type DecisionRecord = {
  kind: "proposal";
  reading: OracleReading;
  input: EngineInput;
  engine: EngineConfig;
  intent: Intent;
  /** Every trade is checked by the policy; a hold never is, so a hold has none. */
  policy?: { ctx: FullContext; config: PolicyConfig; result: PolicyResult };
};

/** A value as it reads back from the log: JSON drops undefined fields and writes NaN and Infinity as null. */
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Makes a decision and its record: the band engine's intent for `reading`, then, unless it holds, the policy's result.
 * The policy's inputs are required: no trade is decided without its check. Inputs are taken in their stored form first, so a value JSON can't hold (NaN) is decided
 * on as `null`, exactly as a replay will see it, and the engines fail closed on it.
 */
export function decide(reading: OracleReading, input: EngineInput, engine: EngineConfig,
  policy: { ctx: FullContext; config: PolicyConfig }): DecisionRecord {
  const stored = asStored({ reading, input, engine, policy });
  const intent = evaluateBands(stored.reading, stored.input, stored.engine);
  const record: DecisionRecord = { kind: "proposal", reading: stored.reading, input: stored.input, engine: stored.engine, intent };
  if (intent.action !== "hold")
    record.policy = { ...stored.policy, result: checkPolicy(intent, stored.policy.ctx, stored.policy.config) };
  return asStored(record);
}

export type DecisionReplay =
  | { ok: true; /** Decisions replayed. */ count: number }
  | { ok: false; /** 0-based index of the first decision that differs. */ index: number; /** Its sequence number in the log, when known. */ seq?: number;
    part: "intent" | "policy"; recorded: unknown; replayed: unknown };

/**
 * Replays recorded decisions through the engines and compares each intent and policy result with the one recorded,
 * as canonical JSON. Stops at the first that differs and names it. A record whose shape is broken counts as differing:
 * a log that can't be replayed doesn't prove its decisions.
 */
export function replayDecisions(records: readonly DecisionRecord[], seqs?: readonly number[]): DecisionReplay {
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const at = seqs?.[index] === undefined ? {} : { seq: seqs[index]! };
    let intent: Intent;
    try { intent = asStored(evaluateBands(record.reading, record.input, record.engine)); }
    catch (error) { return { ok: false, index, ...at, part: "intent", recorded: record.intent, replayed: `the engine threw: ${String(error)}` }; }
    if (canonicalJson(intent) !== canonicalJson(record.intent)) return { ok: false, index, ...at, part: "intent", recorded: record.intent, replayed: intent };
    if (intent.action === "hold") {
      if (record.policy === undefined) continue;
      return { ok: false, index, ...at, part: "policy", recorded: record.policy.result, replayed: "a hold isn't checked" };
    }
    if (!record.policy) return { ok: false, index, ...at, part: "policy", recorded: undefined, replayed: "a trade must have been checked by the policy" };
    let result: PolicyResult;
    try { result = asStored(checkPolicy(intent, record.policy.ctx, record.policy.config)); }
    catch (error) { return { ok: false, index, ...at, part: "policy", recorded: record.policy.result, replayed: `the policy threw: ${String(error)}` }; }
    if (canonicalJson(result) !== canonicalJson(record.policy.result)) return { ok: false, index, ...at, part: "policy", recorded: record.policy.result, replayed: result };
  }
  return { ok: true, count: records.length };
}

const isDecision = (entry: unknown): entry is DecisionRecord =>
  typeof entry === "object" && entry !== null && (entry as DecisionRecord).kind === "proposal"
  && "reading" in entry && "input" in entry && "engine" in entry && "intent" in entry;

/**
 * Replays every decision in an audit log's text (the chained store's JSON lines), naming the first that differs by its
 * sequence number. Checking the chain itself is the store's job (`verifyChain`); this checks what the records say.
 */
export function replayAuditLog(text: string): DecisionReplay {
  const records: DecisionRecord[] = [], seqs: number[] = [];
  for (const line of text.split("\n")) {
    let parsed: { seq?: unknown; entry?: unknown };
    try { parsed = JSON.parse(line); } catch { continue; }
    if (isDecision(parsed?.entry)) { records.push(parsed.entry); seqs.push(typeof parsed.seq === "number" ? parsed.seq : NaN); }
  }
  return replayDecisions(records, seqs);
}
