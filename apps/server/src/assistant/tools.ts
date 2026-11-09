import type { InputSchema, ToolDefinition } from "./model.ts";
import { ASSETS } from "@multiagency/sdk";
import { z } from "zod";
import type { AuditEntry } from "../audit.ts";
import { policyUpdateRequest } from "../contract.ts";
import type { DecisionEntry } from "../ballast.ts";
import type { ChainRecord } from "../chain.ts";
import type { DaoRequests } from "../dao-requests.ts";
import type { Platform } from "../platform.ts";
import type { StrategyProposals } from "../strategy-proposals.ts";

/**
 * The assistant's tools (#219): typed reads of the signed-in owner's own agent, and drafts. Each tool is scoped to the
 * Organization and agent the route admitted, so no input can reach another's records; there is no tool that writes.
 * The model never sees storage: it asks for a read by name, and gets the read's answer, trimmed to what a question needs.
 */

/** Where an answer's figure came from: the read or record, and when it was read. The model cites it by `id`. */
export type Source = { id: string; label: string; read: string; at: string };

/**
 * A draft for the owner to review: the fields an existing review flow opens with, and what it changes against what is in
 * force. Nothing is created on the platform: the owner submits it through that flow and signs in the wallet (or the
 * DAO votes) exactly as without the assistant, so the send-once rules and request IDs are the flow's own.
 */
export type Draft =
  | { kind: "strategy"; targets: Record<string, number>; schedule?: { everyMin?: number; maxUsd?: number }; changes: Change[]; legs?: Leg[]; note: string }
  | { kind: "policy"; changes: Change[]; fields: PolicyDraftFields; note: string }
  | { kind: "rebalance"; legs?: Leg[]; note: string }
  | { kind: "grant"; note: string }
  | { kind: "freeze"; reason: string; note: string };
/** One field a draft changes: its value in force, and the drafted one, in words. */
export type Change = { field: string; from: string; to: string };
/** A swap a rebalance to drafted targets would make, at the overview's prices: an estimate, quoted again when proposed. */
export type Leg = { sell: string; buy: string; usd: number };
export type PolicyDraftFields = { budget?: { daily_usd: string | null; weekly_usd: string | null; monthly_usd: string | null }; owner_approval?: boolean; max_actions_per_hour?: number | null; swap?: boolean };

/** What a tool answers: its content for the model, the source it read, a draft it made, or why it failed. */
export type ToolOutcome = { content: unknown; source?: Omit<Source, "id">; draft?: Draft } | { error: string };

/** What the tools read, all scoped to one agent: its Organization's platform reads, and this server's own records of it. */
export type ToolScope = {
  platform: Platform;
  organization: string;
  agent: string;
  signer: "wallet" | "dao";
  /** The audit log's records, newest last: Ballast's decisions and the owner actions relayed for this agent are read from it. */
  auditLog?: () => Promise<readonly ChainRecord[]>;
  daoRequests: DaoRequests;
  /** The strategies agents proposed through their tokens (#206), kept by this server: their reasons are text others wrote. */
  strategyProposals?: Pick<StrategyProposals, "open">;
  now: () => number;
};

const SYMBOLS = Object.fromEntries(Object.entries(ASSETS).map(([symbol, id]) => [id, symbol])) as Record<string, string>;
const symbolOf = (asset: string) => SYMBOLS[asset] ?? asset;
const assetOf = (symbol: string) => (ASSETS as Record<string, string>)[symbol];

/** A list trimmed to its newest `limit` entries (the platform answers oldest first), with how many were left out. */
function newest<T>(list: readonly T[], limit: number) {
  const kept = list.slice(-limit);
  return { entries: kept, ...(kept.length < list.length && { omitted: list.length - kept.length }) };
}

const limit = z.number().int().min(1).max(50).default(20);
const noInput = z.strictObject({});
const listInput = z.strictObject({ limit: limit.optional() });

/** The percent each asset should hold, by symbol, adding up to 100. */
const targetsInput = z.partialRecord(z.enum(Object.keys(ASSETS) as [string, ...string[]]), z.number().min(0).max(100))
  .refine(targets => Math.abs(Object.values(targets).reduce((sum: number, pct) => sum + (pct ?? 0), 0) - 100) < 1e-9, "targets must add up to 100 percent");
const policyChanges = policyUpdateRequest.shape.changes;
/** The part of the policy the assistant may draft: budgets, approval, the action rate and swaps. Destinations, withdrawals and per-asset caps are edited by the owner directly. */
const policyDraftInput = z.strictObject({
  budget: policyChanges.shape.budget,
  owner_approval: z.boolean().optional(),
  max_actions_per_hour: z.number().int().positive().nullable().optional(),
  swap: z.boolean().optional(),
}).refine(input => Object.keys(input).length > 0, "a policy draft must change at least one field");

type Tool<I extends z.ZodType> = { definition: ToolDefinition; input: I; run(input: z.output<I>, scope: ToolScope): Promise<ToolOutcome> };
const tool = <I extends z.ZodType>(name: string, description: string, input: I, inputSchema: InputSchema, run: Tool<I>["run"]): Tool<I> =>
  ({ definition: { name, description, input_schema: inputSchema }, input, run });

const EMPTY: InputSchema = { type: "object", properties: {}, additionalProperties: false };
const LIST: InputSchema = { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "How many of the newest entries to read (default 20)." } }, additionalProperties: false };
const TARGETS: InputSchema = {
  type: "object", additionalProperties: false, required: ["targets"],
  properties: { targets: { type: "object", description: `The percent each asset should hold, by symbol (${Object.keys(ASSETS).join(", ")}), adding up to 100. Name every asset of the saved strategy.`,
    additionalProperties: { type: "number", minimum: 0, maximum: 100 } } },
};

/** A platform read, relayed for the agent: its answer, or why it couldn't be read, never a guess. */
async function read<T>(scope: ToolScope, label: string, name: string, call: () => Promise<{ ok: true; value: T } | { ok: false; kind: string }>,
  shape: (value: T) => unknown = value => value): Promise<ToolOutcome> {
  let answer: { ok: true; value: T } | { ok: false; kind: string };
  try { answer = await call(); } catch { answer = { ok: false, kind: "unavailable" }; }
  if (!answer.ok) return { error: `The ${label.toLowerCase()} could not be read (${answer.kind}).` };
  return { content: shape(answer.value), source: { label, read: name, at: new Date(scope.now()).toISOString() } };
}

type Overview = Extract<Awaited<ReturnType<Platform["reads"]["overview"]>>, { ok: true }>["value"];
/** The book as the model reads it: per asset its symbol, units, price and USD value, the targets, and the policy's budget use. */
const overviewView = (overview: Overview) => ({
  holdings: overview.book.map(holding => ({ symbol: holding.symbol, asset: holding.asset, decimals: holding.decimals,
    public_units: String(holding.public), confidential_units: String(holding.confidential), price_usd: holding.price, price_at: holding.priceUpdatedAt, usd: holding.usd })),
  unmanaged: overview.unmanaged.map(holding => ({ symbol: holding.symbol, units: String(holding.amount), decimals: holding.decimals, usd: holding.usd })),
  target_percent: Object.fromEntries(Object.entries(overview.target).map(([asset, bps]) => [symbolOf(asset), bps / 100])),
  rebalance: overview.rebalance,
  policy: { revision: overview.policy.revision, status: overview.policy.status, budget_usage: overview.policy.usage.budget,
    in_force: overview.policy.policy, not_in_force: overview.notInForce },
  grants: overview.grants,
});

/** The decisions Ballast recorded for this agent, newest last: what it decided and why, the level and the policy's verdict. */
function decisionsView(records: readonly ChainRecord[], agent: string, count: number) {
  const decisions = records.map(record => ({ at: record.at, seq: record.seq, entry: record.entry as Partial<DecisionEntry> }))
    .filter(({ entry }) => entry.kind === "decision" && entry.agent === agent);
  return newest(decisions.map(({ at, seq, entry }) => ({
    at, audit_seq: seq,
    reading: entry.reading && ("frozen" in entry.reading && entry.reading.frozen ? { frozen: true, reason: (entry.reading as { reason?: string }).reason } : { frozen: false, median: (entry.reading as { median?: number }).median }),
    action: entry.intent?.action, zone: entry.intent?.zone, size_usd: entry.intent?.sizeUsd, reason: entry.intent?.reason,
    level: entry.policy?.ctx.level, policy: entry.policy && (entry.policy.result.ok === true ? "allowed" : entry.policy.result.ok === "needs-approval" ? "needs the owner's approval" : { refused: entry.policy.result.rule, failed: entry.policy.result.failed }),
    proposed_usd: entry.proposal?.sizeUsd ?? null, request_id: entry.requestId,
  })), count);
}

/** The owner actions this server relayed for the agent, as the audit log recorded them: hashes and outcomes, never what was signed. */
function auditView(records: readonly ChainRecord[], agent: string, count: number) {
  const actions = records.filter(record => { const entry = record.entry as Partial<AuditEntry>; return typeof entry.action === "string" && entry.agent === agent && entry.stage === "result"; });
  return newest(actions.map(record => { const entry = record.entry as AuditEntry & { stage: "result" }; return { at: record.at, audit_seq: record.seq, action: entry.action, who: entry.who, subject: entry.subject, answer: entry.answer }; }), count);
}

const fmtPct = (pct: number | undefined) => pct === undefined ? "none" : `${Number(pct.toFixed(2))}%`;
const fmtUsd = (usd: string | null | undefined) => usd == null ? "no limit" : `$${usd}`;

/** The swaps a move from the book to `targets` would make, at the overview's prices: sells fund buys, smallest first never mattering. */
export function legsTo(book: readonly { symbol: string; usd: number | null }[], targets: Record<string, number>): Leg[] | undefined {
  if (book.some(holding => holding.usd === null)) return undefined;
  const total = book.reduce((sum, holding) => sum + holding.usd!, 0);
  const gap = Object.keys({ ...targets, ...Object.fromEntries(book.map(holding => [holding.symbol, 0])) }).map(symbol =>
    ({ symbol, usd: (targets[symbol] ?? 0) / 100 * total - (book.find(holding => holding.symbol === symbol)?.usd ?? 0) }));
  const sells = gap.filter(entry => entry.usd < -0.005).map(entry => ({ ...entry, usd: -entry.usd })), buys = gap.filter(entry => entry.usd > 0.005);
  const legs: Leg[] = [];
  for (const buy of buys) for (const sell of sells) {
    const usd = Math.min(buy.usd, sell.usd);
    if (usd < 0.005) continue;
    legs.push({ sell: sell.symbol, buy: buy.symbol, usd: Math.round(usd * 100) / 100 });
    buy.usd -= usd; sell.usd -= usd;
  }
  return legs;
}

export const TOOLS = [
  tool("get_overview", "The book: each holding's units, price and USD value, the target allocation, the signed policy in force with its budget windows (limit, spent, remaining, reset), and the agent's grants.",
    noInput, EMPTY, (_, scope) => read(scope, "Overview", "overview", () => scope.platform.reads.overview(scope.organization, scope.agent), overviewView)),
  tool("get_strategy", "The saved strategy (targets in basis points, swap limits, autopilot interval and ceiling, cash floor), its digest, and whether the grant binds it.",
    noInput, EMPTY, (_, scope) => read(scope, "Saved strategy", "strategy/get", () => scope.platform.autopilot.strategy(scope.organization, scope.agent))),
  tool("get_autopilot", "Whether autopilot is on, its interval and ceiling, and its last and next runs.",
    noInput, EMPTY, (_, scope) => read(scope, "Autopilot status", "autopilot/get", () => scope.platform.autopilot.status(scope.organization, scope.agent))),
  tool("get_runs", "The autopilot's recorded runs (ticks), newest last: when each ran and what it did or why it held.",
    listInput, LIST, ({ limit: count = 20 }, scope) => read(scope, "Autopilot runs", "autopilot/evidence", () => scope.platform.reads.runs(scope.organization, scope.agent),
      runs => ({ ...runs, ticks: newest(runs.ticks, count) }))),
  tool("get_activity", "Everything the agent did (swaps, payments, shields), newest last, with each one's status.",
    listInput, LIST, ({ limit: count = 20 }, scope) => read(scope, "Activity", "activity", () => scope.platform.reads.activity(scope.organization, scope.agent), list => newest(list, count))),
  tool("get_unresolved", "Operations without a proven outcome. While any is open, new sends are blocked.",
    noInput, EMPTY, (_, scope) => read(scope, "Unresolved operations", "unresolved", () => scope.platform.reads.unresolved(scope.organization, scope.agent))),
  tool("get_held", "Payouts held for the owner's approval.",
    noInput, EMPTY, (_, scope) => read(scope, "Held payouts", "held", () => scope.platform.reads.held(scope.organization, scope.agent))),
  tool("list_proposals", "The agent's proposals with their status (open, approved, rejected, executed, expired), newest last.",
    listInput, LIST, ({ limit: count = 20 }, scope) => read(scope, "Proposals", "proposals/list", () => scope.platform.proposals.list(scope.organization, scope.agent),
      list => ({ ...list, proposals: newest(list.proposals, count) }))),
  tool("get_proposal", "One proposal by its ID, with its legs, quote and status.",
    z.strictObject({ id: z.string().min(1).max(200) }), { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    ({ id }, scope) => read(scope, `Proposal ${id}`, "proposals/get", () => scope.platform.proposals.get(scope.organization, scope.agent, id))),
  tool("get_owner_actions", "The owner's actions (grants, freezes, policy edits, revocations) and where each stands, as the platform records them.",
    noInput, EMPTY, (_, scope) => read(scope, "Owner actions", "owner/actions", () => scope.platform.reads.ownerActions(scope.organization, scope.agent))),
  tool("get_policy_history", "The policy's revisions, each with its time and digest, and the mandate digest.",
    noInput, EMPTY, (_, scope) => read(scope, "Policy history", "policyHistory", () => scope.platform.reads.policyHistory(scope.organization, scope.agent))),
  tool("get_account", "The agent's account: its wallet and the grants its executor holds, with their expiry.",
    noInput, EMPTY, (_, scope) => read(scope, "Account", "account", () => scope.platform.reads.account(scope.organization, scope.agent))),
  tool("get_ballast_decisions", "Ballast's recorded decisions for this agent, newest last: the price reading, the action and size it decided (or hold), its reason, the escalation level, and the policy's verdict (allowed, needs approval, or the rule that refused it). Use it to explain why autopilot did or didn't rebalance.",
    listInput, LIST, async ({ limit: count = 20 }, scope) => {
      if (!scope.auditLog) return { error: "This server keeps no audit log to read decisions from." };
      return { content: decisionsView(await scope.auditLog(), scope.agent, count), source: { label: "Ballast decisions (audit log)", read: "audit/decisions", at: new Date(scope.now()).toISOString() } };
    }),
  tool("get_audit_trail", "The owner actions this server relayed for the agent, as its hash-chained audit log recorded them, newest last: the action, who, and the platform's answer.",
    listInput, LIST, async ({ limit: count = 20 }, scope) => {
      if (!scope.auditLog) return { error: "This server keeps no audit log." };
      return { content: auditView(await scope.auditLog(), scope.agent, count), source: { label: "Audit trail", read: "audit/actions", at: new Date(scope.now()).toISOString() } };
    }),
  tool("get_dao_requests", "For a DAO-owned agent, the requests waiting for the DAO's vote: its consent and its verdicts on proposals.",
    noInput, EMPTY, async (_, scope) => ({
      content: scope.signer !== "dao" ? { requests: [], note: "The agent is owned by a wallet, not a DAO." }
        : { requests: scope.daoRequests.open().filter(request => request.kind !== "setup" && request.organization === scope.organization && request.agent === scope.agent)
          .map(request => request.kind === "vote" ? { kind: request.kind, proposal: request.proposal } : { kind: request.kind }) },
      source: { label: "DAO requests", read: "dao-requests", at: new Date(scope.now()).toISOString() },
    })),
  tool("list_strategy_proposals", "Strategies the agent's software proposed through its access tokens and the owner hasn't adopted or declined, oldest first: the targets, the reasons the software gave (text it wrote), and when.",
    noInput, EMPTY, async (_, scope) => {
      if (!scope.strategyProposals) return { error: "This server keeps no strategy proposals." };
      const open = scope.strategyProposals.open(scope.agent).map(proposal => ({ id: proposal.id, source: proposal.source, created_at: new Date(proposal.createdAt).toISOString(),
        target_percent: Object.fromEntries(Object.entries(proposal.strategy.targetBps).map(([asset, bps]) => [symbolOf(asset), bps / 100])), reasons: proposal.reasons }));
      return { content: { proposals: open }, source: { label: "Strategy proposals (this server's records)", read: "strategy-proposals", at: new Date(scope.now()).toISOString() } };
    }),
  tool("draft_rebalance", "Opens the rebalance proposal form for the saved strategy as it is, with the swaps a rebalance would make at current prices. Sends nothing: the owner proposes it there, and it executes nothing until approved. Use draft_strategy instead when the owner names new targets.",
    noInput, EMPTY, async (_, scope) => {
      const overview = await scope.platform.reads.overview(scope.organization, scope.agent).catch(() => null);
      if (!overview?.ok) return { error: "The book could not be read, so nothing was drafted." };
      const targets = Object.fromEntries(Object.entries(overview.value.target).map(([asset, bps]) => [symbolOf(asset), bps / 100]));
      const legs = legsTo(overview.value.book.map(holding => ({ symbol: holding.symbol, usd: holding.usd })), targets);
      if (legs && legs.length === 0) return { error: "The book is at the saved strategy's targets already: there is nothing to rebalance." };
      const draft: Draft = { kind: "rebalance", ...(legs && { legs }),
        note: "Proposing quotes the swaps again and opens a proposal for a day; nothing executes until it's approved and signed." };
      return { content: { drafted: draft, target_percent: targets }, draft, source: { label: "Overview (book and targets)", read: "overview", at: new Date(scope.now()).toISOString() } };
    }),
  tool("draft_strategy", "Drafts a change to the saved strategy's target allocation (and optionally its autopilot schedule) for the owner to review in the strategy editor. Sends nothing. Use it for \"rebalance to X% wNEAR\": a rebalance proposal moves the book to the saved strategy, so the targets are saved first, then authorized, then a rebalance is proposed. Answers the changes against the saved strategy and the swaps a rebalance would make at current prices.",
    z.strictObject({ targets: targetsInput, everyMin: z.number().int().min(5).max(1_440).optional(), maxUsd: z.number().int().min(0).max(1_000_000).optional() }),
    { ...TARGETS, properties: { ...(TARGETS.properties as Record<string, unknown>), everyMin: { type: "integer", minimum: 5, maximum: 1440, description: "Autopilot's interval in minutes, only if the owner asked to change it." },
      maxUsd: { type: "integer", minimum: 0, maximum: 1000000, description: "Autopilot's automatic rebalance ceiling in USD, only if the owner asked to change it." } } },
    async ({ targets, everyMin, maxUsd }, scope) => {
      const [strategy, overview] = await Promise.all([scope.platform.autopilot.strategy(scope.organization, scope.agent).catch(() => null), scope.platform.reads.overview(scope.organization, scope.agent).catch(() => null)]);
      if (!strategy?.ok) return { error: "The saved strategy could not be read, so nothing was drafted." };
      const saved = strategy.value.strategy;
      const savedPct = Object.fromEntries(Object.entries(saved.targetBps).map(([asset, bps]) => [symbolOf(asset), bps / 100]));
      const unknown = Object.keys(targets).filter(symbol => !assetOf(symbol) || !(assetOf(symbol)! in saved.targetBps));
      if (unknown.length) return { error: `The saved strategy manages ${Object.keys(savedPct).join(", ")}; ${unknown.join(", ")} can't be targeted. Nothing was drafted.` };
      const full = Object.fromEntries(Object.keys(savedPct).map(symbol => [symbol, targets[symbol] ?? 0]));
      const changes: Change[] = Object.keys(savedPct).filter(symbol => Math.abs(savedPct[symbol]! - full[symbol]!) > 1e-9)
        .map(symbol => ({ field: `${symbol} target`, from: fmtPct(savedPct[symbol]), to: fmtPct(full[symbol]) }));
      if (everyMin !== undefined && everyMin !== saved.autopilot.everyMin) changes.push({ field: "Autopilot interval", from: `${saved.autopilot.everyMin} min`, to: `${everyMin} min` });
      if (maxUsd !== undefined && maxUsd !== saved.autopilot.maxUsd) changes.push({ field: "Automatic rebalance ceiling", from: `$${saved.autopilot.maxUsd}`, to: `$${maxUsd}` });
      if (!changes.length) return { error: "That is the saved strategy already: nothing to draft." };
      const legs = overview?.ok ? legsTo(overview.value.book.map(holding => ({ symbol: holding.symbol, usd: holding.usd })), full) : undefined;
      const draft: Draft = { kind: "strategy", targets: full, ...((everyMin !== undefined || maxUsd !== undefined) && { schedule: { everyMin, maxUsd } }), changes, ...(legs && { legs }),
        note: "Saving turns autopilot off; the new strategy then needs authorizing (a grant) before a rebalance to it can be proposed. Swaps are quoted again when proposed." };
      return { content: { drafted: draft }, draft, source: { label: "Saved strategy", read: "strategy/get", at: new Date(scope.now()).toISOString() } };
    }),
  tool("draft_policy_edit", "Drafts an edit to the signed policy for the owner to review in the policy editor: USD budget windows (decimal strings, or null for no limit), whether owner approval is required, the most actions an hour, and whether swaps are allowed. Sends nothing: the owner reviews and signs it. Destinations, withdrawals and per-asset caps aren't drafted here.",
    policyDraftInput, {
      type: "object", additionalProperties: false,
      properties: {
        budget: { type: "object", additionalProperties: false, required: ["daily_usd", "weekly_usd", "monthly_usd"], description: "All three windows, each a decimal USD string or null for no limit. Copy the ones not being changed from the policy in force.",
          properties: Object.fromEntries(["daily_usd", "weekly_usd", "monthly_usd"].map(key => [key, { anyOf: [{ type: "string", pattern: "^\\d+(\\.\\d+)?$" }, { type: "null" }] }])) },
        owner_approval: { type: "boolean" }, max_actions_per_hour: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, swap: { type: "boolean" },
      },
    },
    async (fields, scope) => {
      const overview = await scope.platform.reads.overview(scope.organization, scope.agent).catch(() => null);
      if (!overview?.ok) return { error: "The policy in force could not be read, so nothing was drafted." };
      const policy = overview.value.policy.policy as { owner_approval?: boolean; max_actions_per_hour?: number | null; actions?: string[]; budget?: Record<string, string | null> } | null;
      const budget = overview.value.policy.usage.budget;
      const changes: Change[] = [];
      if (fields.budget) for (const window of ["daily", "weekly", "monthly"] as const) {
        const from = policy?.budget?.[`${window}_usd`] ?? budget[window]?.limit_usd ?? null, to = fields.budget[`${window}_usd`];
        if (from !== to) changes.push({ field: `${window[0]!.toUpperCase()}${window.slice(1)} budget`, from: fmtUsd(from), to: fmtUsd(to) });
      }
      if (fields.owner_approval !== undefined && fields.owner_approval !== policy?.owner_approval) changes.push({ field: "Owner approval", from: policy?.owner_approval ? "required" : "not required", to: fields.owner_approval ? "required" : "not required" });
      if (fields.max_actions_per_hour !== undefined && fields.max_actions_per_hour !== (policy?.max_actions_per_hour ?? null))
        changes.push({ field: "Actions an hour", from: String(policy?.max_actions_per_hour ?? "no limit"), to: String(fields.max_actions_per_hour ?? "no limit") });
      const swaps = policy?.actions?.includes("swap");
      if (fields.swap !== undefined && fields.swap !== swaps) changes.push({ field: "Swaps", from: swaps ? "allowed" : "not allowed", to: fields.swap ? "allowed" : "not allowed" });
      if (!changes.length) return { error: "That is the policy in force already: nothing to draft." };
      const draft: Draft = { kind: "policy", changes, fields: fields as PolicyDraftFields, note: "A policy edit is signed by the owner (or voted by the DAO) and applies as the next revision." };
      return { content: { drafted: draft }, draft, source: { label: "Overview (policy in force)", read: "overview", at: new Date(scope.now()).toISOString() } };
    }),
  tool("draft_grant", "Opens the grant flow for the saved strategy, so the owner can authorize it (or renew an expiring grant). Sends nothing.",
    noInput, EMPTY, async () => { const draft: Draft = { kind: "grant", note: "A grant binds the saved strategy by its digest; the owner signs it in the wallet (or the DAO votes)." }; return { content: { drafted: draft }, draft }; }),
  tool("draft_freeze", "Opens the freeze review, so the owner can freeze the agent. Sends nothing. Only when the owner asks to freeze or stop everything.",
    z.strictObject({ reason: z.string().min(1).max(300) }), { type: "object", properties: { reason: { type: "string", maxLength: 300, description: "Why, in the owner's words." } }, required: ["reason"], additionalProperties: false },
    async ({ reason }) => { const draft: Draft = { kind: "freeze", reason, note: "Freezing blocks new actions across grants; the owner signs it. It doesn't prove an operation already committed will stop." }; return { content: { drafted: draft }, draft }; }),
] as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map(entry => entry.definition);
const BY_NAME = new Map<string, Tool<z.ZodType>>(TOOLS.map(entry => [entry.definition.name, entry as unknown as Tool<z.ZodType>]));

/** Runs a tool the model asked for, its input checked against the tool's schema first: an unknown tool or bad input is an error result, never a call. */
export async function runTool(name: string, input: unknown, scope: ToolScope): Promise<ToolOutcome> {
  const entry = BY_NAME.get(name);
  if (!entry) return { error: `There is no tool named ${name}.` };
  const parsed = entry.input.safeParse(input ?? {});
  if (!parsed.success) return { error: `Invalid input for ${name}: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}` };
  try { return await entry.run(parsed.data, scope); } catch { return { error: `${name} failed while reading.` }; }
}

/** Tools that read the platform: each call spends from the deployment's hourly budget. */
export const PLATFORM_TOOLS = new Set(["get_overview", "get_strategy", "get_autopilot", "get_runs", "get_activity", "get_unresolved", "get_held", "list_proposals", "get_proposal",
  "get_owner_actions", "get_policy_history", "get_account", "draft_strategy", "draft_policy_edit", "draft_rebalance"]);
