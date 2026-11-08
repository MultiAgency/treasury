// A7.2 (#54): every decision is recorded with the inputs it was made from, so replaying the log through the engines
// gives the same decision, and a replay that doesn't names the first record that differs.
//
// A record holds the oracle reading, the engine's input (portfolio, bounds, sizing and anti-whipsaw state, regime) and
// config, the intent the band engine made, the policy's context, config and result when the intent went to the policy,
// and, when the policy let it through, the proposal: its size in cents and the legs `legsFor` made from the prices it
// was given. It is stored as the log stores everything, as JSON: `decide` builds the record from the JSON form of its
// inputs, so the decision it reports is the one a replay of the stored record makes.

import { checkPolicy, type FullContext, type PolicyConfig } from "./check.ts";
import { canonicalJson } from "./digest.ts";
import { evaluateBands, type EngineConfig, type EngineInput } from "./engine.ts";
import type { Intent } from "./bands.ts";
import { centsDown, legsFor, type LegsInput, type LegsResult } from "./legs.ts";
import type { OracleReading } from "./oracle.ts";
import type { PolicyResult } from "./policy.ts";

/** What `legsFor` takes besides the decision: the assets, their prices and decimals, and the slippage bound. */
export type LegsPricing = Omit<LegsInput, "decision">;

/** One decision with everything it was made from. `kind` is the audit log's (`chain.ts`'s `AUDIT_KINDS`). */
export type DecisionRecord = {
  kind: "decision";
  reading: OracleReading;
  input: EngineInput;
  engine: EngineConfig;
  intent: Intent;
  /** Every trade is checked by the policy; a hold never is, so a hold has none. */
  policy?: { ctx: FullContext; config: PolicyConfig; result: PolicyResult };
  /**
   * A trade the policy didn't refuse: its size in whole cents (`centsDown`; null below a cent, which proposes nothing)
   * and, when it has one, the legs made at `pricing`.
   */
  proposal?: { pricing: LegsPricing; sizeUsd: null } | { pricing: LegsPricing; sizeUsd: string; legs: LegsResult };
};

/** The part of a record a replay compares. */
export type DecisionPart = "intent" | "policy" | "proposal";

/** What an intent decides: all of it but its reason, which only words the decision and may be reworded (#208). */
const decided = (intent: unknown) => typeof intent === "object" && intent !== null ? { ...intent, reason: undefined } : intent;

/** A value as it reads back from the log: JSON drops undefined fields and writes NaN and Infinity as null. */
const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The proposal for a trade the policy let through: its size in cents, then its legs. */
function proposalFor(intent: Intent, pricing: LegsPricing): NonNullable<DecisionRecord["proposal"]> {
  const sizeUsd = centsDown(intent.sizeUsd);
  if (sizeUsd === undefined || intent.action === "hold") return { pricing, sizeUsd: null };
  return { pricing, sizeUsd, legs: legsFor({ ...pricing, decision: { action: intent.action, sizeUsd } }) };
}

/**
 * Makes a decision and its record: the band engine's intent for `reading`, then, unless it holds, the policy's result,
 * then, unless the policy refuses, the proposal. The policy's and the legs' inputs are required: no trade is decided
 * without its check. Inputs are taken in their stored form first, so a value JSON can't hold (NaN) is decided on as
 * `null`, exactly as a replay will see it, and the engines fail closed on it.
 */
export function decide(reading: OracleReading, input: EngineInput, engine: EngineConfig,
  policy: { ctx: FullContext; config: PolicyConfig }, pricing: LegsPricing): DecisionRecord {
  const stored = asStored({ reading, input, engine, policy, pricing });
  const intent = evaluateBands(stored.reading, stored.input, stored.engine);
  const record: DecisionRecord = { kind: "decision", reading: stored.reading, input: stored.input, engine: stored.engine, intent };
  if (intent.action !== "hold") {
    const result = checkPolicy(intent, stored.policy.ctx, stored.policy.config);
    record.policy = { ...stored.policy, result };
    if (result.ok !== false) record.proposal = proposalFor(intent, stored.pricing);
  }
  return asStored(record);
}

export type DecisionReplay =
  | { ok: true; /** Decisions replayed. */ count: number }
  | { ok: false; /** 0-based index of the first decision that differs. */ index: number; /** Its sequence number in the log, when known. */ seq?: number;
    part: DecisionPart; recorded: unknown; replayed: unknown };

/**
 * Replays recorded decisions through the engines and compares each intent (all but its reason), policy result and
 * proposal with the one recorded, as canonical JSON. Stops at the first that differs and names it. A record whose shape
 * is broken counts as differing: a log that can't be replayed doesn't prove its decisions.
 */
export function replayDecisions(records: readonly DecisionRecord[], seqs?: readonly number[]): DecisionReplay {
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const differs = (part: DecisionPart, recorded: unknown, replayed: unknown): DecisionReplay =>
      ({ ok: false, index, ...(seqs?.[index] === undefined ? {} : { seq: seqs[index]! }), part, recorded, replayed });
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

    let intent: Intent;
    try { intent = asStored(evaluateBands(record.reading, record.input, record.engine)); }
    catch (error) { return differs("intent", record.intent, `the engine threw: ${String(error)}`); }
    if (!same(decided(intent), decided(record.intent))) return differs("intent", record.intent, intent);
    if (intent.action === "hold") {
      if (record.policy !== undefined) return differs("policy", record.policy.result, "a hold isn't checked");
      if (record.proposal !== undefined) return differs("proposal", record.proposal, "a hold proposes nothing");
      continue;
    }

    if (!record.policy) return differs("policy", undefined, "a trade must have been checked by the policy");
    let result: PolicyResult;
    try { result = asStored(checkPolicy(intent, record.policy.ctx, record.policy.config)); }
    catch (error) { return differs("policy", record.policy.result, `the policy threw: ${String(error)}`); }
    if (!same(result, record.policy.result)) return differs("policy", record.policy.result, result);
    if (result.ok === false) {
      if (record.proposal !== undefined) return differs("proposal", record.proposal, "a refused trade proposes nothing");
      continue;
    }

    if (!record.proposal) return differs("proposal", undefined, "a trade the policy let through must have its proposal");
    let proposal: NonNullable<DecisionRecord["proposal"]>;
    try { proposal = asStored(proposalFor(intent, record.proposal.pricing)); }
    catch (error) { return differs("proposal", record.proposal, `the legs threw: ${String(error)}`); }
    if (!same(proposal, record.proposal)) return differs("proposal", record.proposal, proposal);
  }
  return { ok: true, count: records.length };
}

const isDecision = (entry: unknown): entry is DecisionRecord =>
  typeof entry === "object" && entry !== null && (entry as DecisionRecord).kind === "decision";

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
