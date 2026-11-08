import { randomBytes } from "node:crypto";
import { ASSETS, type OwnerOutput } from "@multiagency/sdk";
import { z } from "zod";
import { compileMandate, PROPOSAL_ASSETS, type ProfileName } from "../../../packages/core/src/index.ts";
import type { Audit } from "./audit.ts";
import type { BallastSettings } from "./ballast.ts";
import { strategyInput } from "./contract.ts";
import { createRecords, memoryRecords } from "./records.ts";

/** The longest reasons a proposal may give. */
export const MAX_REASONS = 2_000;
/** Records kept in all: the open proposals, and the last closed one of each agent's source. */
const MAX_RECORDS = 1_024;

/** Who proposed: Ballast's mandate compiler, or an agent outside the server by one of its tokens (#139). */
const source = z.string().regex(/^(mandate|token:[a-f0-9]{16})$/);
export type ProposalSource = z.output<typeof source>;
/**
 * A strategy as a proposal carries one: the Strategy page's fields, and the cash floor the platform keeps with them
 * (platform#23), so a proposal that leaves the floor as saved doesn't drop it when adopted.
 */
export const proposedStrategy = strategyInput.extend({
  cashFloor: z.strictObject({
    usd: z.number().int().min(1),
    assets: z.array(z.enum(Object.values(ASSETS) as [string, ...string[]])).min(1).refine(list => new Set(list).size === list.length, "cash floor assets must not repeat"),
  }).optional(),
});
export type ProposedStrategy = z.output<typeof proposedStrategy>;

const stored = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  source,
  strategy: proposedStrategy,
  reasons: z.string().min(1).max(MAX_REASONS),
  /** The digest of the saved strategy it was compared against: adopting saves it over that one, or not at all. */
  against: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: z.number().int(),
  /** Adopted or declined by the owner; superseded by a later proposal from its source, or by a change to the saved strategy. */
  closed: z.strictObject({ at: z.number().int(), outcome: z.enum(["adopted", "declined", "superseded"]) }).nullable(),
});
export type StrategyProposal = z.output<typeof stored>;
/** A proposal as the owner is shown it. */
export type StrategyProposalView = Omit<StrategyProposal, "agent" | "closed">;

export type ProposalRecords = Pick<Awaited<ReturnType<typeof createRecords<typeof stored>>>, "all" | "commit">;
export const memoryProposalRecords = (): ProposalRecords => memoryRecords<StrategyProposal>();
/** The proposals file: owner-only like the others on `/data`. */
export const fileProposalRecords = (path: string) => createRecords(path, "proposals", stored, "the strategy proposals agents made");

/**
 * What's wrong with a strategy proposed for an agent whose policy allows `policyAssets` (`"any"`, or the assets it may
 * move): the Strategy page's bounds (`strategyInput`), and targets only over the policy's assets. Empty when it may be stored.
 */
export function strategyProblems(strategy: unknown, policyAssets: "any" | readonly string[]): string[] {
  const parsed = proposedStrategy.safeParse(strategy);
  if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join(".") || "strategy"}: ${issue.message}`);
  if (policyAssets === "any") return [];
  return Object.entries(parsed.data.targetBps).filter(([asset, bps]) => bps > 0 && !policyAssets.includes(asset))
    .map(([asset]) => `targetBps: ${asset} is outside the policy's assets`);
}

/** The same targets and cost limit: what a mandate proposal is compared by, since the rest stays as saved. */
const sameAim = (a: Pick<ProposedStrategy, "targetBps" | "maxCostBps">, b: Pick<ProposedStrategy, "targetBps" | "maxCostBps">) =>
  a.maxCostBps === b.maxCostBps && Object.keys({ ...a.targetBps, ...b.targetBps }).every(asset => (a.targetBps[asset] ?? 0) === (b.targetBps[asset] ?? 0));

/**
 * Strategies proposed for an owner's agents (#206), kept apart from the saved strategy until the owner adopts one. At
 * most one is open per agent per source: a source's new proposal supersedes its open one. Each proposal is validated
 * before it's stored, and recorded in the audit trail, by its source; the owner's answers are recorded by their routes.
 */
export function createStrategyProposals(records: ProposalRecords, { audit, now = Date.now }: { audit: Audit; now?: () => number }) {
  const close = (proposal: StrategyProposal, outcome: NonNullable<StrategyProposal["closed"]>["outcome"], at: number): StrategyProposal =>
    ({ ...proposal, closed: { at, outcome } });
  /** The open proposals, and the last closed one of each agent's source: what decides whether a declined strategy is proposed again. */
  const prune = (all: readonly StrategyProposal[]) => {
    const last = new Map<string, StrategyProposal>();
    for (const p of all) if (p.closed && (last.get(`${p.agent}/${p.source}`)?.closed?.at ?? -1) <= p.closed.at) last.set(`${p.agent}/${p.source}`, p);
    return all.filter(p => !p.closed || last.get(`${p.agent}/${p.source}`) === p);
  };

  return {
    /** The agent's open proposals, oldest first. */
    open: (agent: string): StrategyProposalView[] => records.all().filter(p => p.agent === agent && !p.closed)
      .sort((a, b) => a.createdAt - b.createdAt).map(({ agent: _, closed: __, ...view }) => view),
    /** An open proposal of the agent's, by its ID. */
    find: (agent: string, id: string) => records.all().find(p => p.agent === agent && p.id === id && !p.closed),
    /** The source's last proposal for the agent, open or closed. */
    last: (agent: string, from: ProposalSource) => records.all().filter(p => p.agent === agent && p.source === from).sort((a, b) => b.createdAt - a.createdAt)[0],

    /**
     * Stores a proposal once it's validated, superseding the source's open one: `problems` when it isn't valid, `full`
     * when the server holds as many as it may. Recorded before it's stored and after, by its source.
     */
    async propose({ agent, from, strategy, reasons, against, policyAssets }: {
      agent: string; from: ProposalSource; strategy: unknown; reasons: string; against: string; policyAssets: "any" | readonly string[];
    }): Promise<{ ok: true; id: string } | { ok: false; problems: string[] } | { ok: false; full: true }> {
      const problems = strategyProblems(strategy, policyAssets);
      if (reasons.trim().length === 0 || reasons.length > MAX_REASONS) problems.push(`reasons: 1 to ${MAX_REASONS} characters`);
      if (problems.length > 0) return { ok: false, problems };
      const at = now(), id = randomBytes(8).toString("hex");
      const proposal: StrategyProposal = { id, agent, source: from, strategy: proposedStrategy.parse(strategy), reasons, against, createdAt: at, closed: null };
      await audit.append({ who: from, action: "strategy-propose", agent, subject: id, stage: "attempt" });
      const written = await records.commit(current => {
        const kept = prune(current.map(p => p.agent === agent && p.source === from && !p.closed ? close(p, "superseded", at) : p));
        return kept.length >= MAX_RECORDS ? null : [...kept, proposal];
      });
      await audit.append({ who: from, action: "strategy-propose", agent, subject: id, stage: "result",
        answer: written ? { ok: true } : { ok: false, kind: "refused", code: "too_many_proposals" } });
      return written ? { ok: true, id } : { ok: false, full: true };
    },

    /** Closes an open proposal of the agent's; false when it has none open by that ID. */
    close: (agent: string, id: string, outcome: NonNullable<StrategyProposal["closed"]>["outcome"]) => {
      const at = now();
      return records.commit(current => current.some(p => p.agent === agent && p.id === id && !p.closed)
        ? prune(current.map(p => p.agent === agent && p.id === id && !p.closed ? close(p, outcome, at) : p)) : null);
    },
  };
}
export type StrategyProposals = ReturnType<typeof createStrategyProposals>;

/** What the mandate proposer did on a tick, for `watch`'s log line. */
export type MandateNote = { proposed: string } | { skipped: string; [detail: string]: unknown };

/**
 * The mandate proposer (#206), on `watch`'s tick for an agent configured with Ballast: proposes the strategy the agent's
 * profile compiles to, when that differs from the saved one, none of its own is open, and the owner didn't decline that
 * same strategy (a declined one isn't proposed again until what the profile compiles to changes). Its weights map as
 * volatile → wNEAR, reserve and cash → USDC, every other asset 0; the cost limit is the profile's slippage limit, and the
 * other fields stay as saved. It reads the saved strategy only when it proposes; the targets come from `overview`.
 */
export async function proposeMandate({ agent, settings, overview, strategy, proposals }: {
  agent: string; settings: BallastSettings; overview: OwnerOutput<"overview">;
  /** The saved strategy, read only when there is something to propose. */
  strategy: () => Promise<{ ok: true; value: OwnerOutput<"strategy/get"> } | { ok: false; kind: string }>;
  proposals: StrategyProposals;
}): Promise<MandateNote> {
  const total = overview.book.reduce((sum, h) => sum + (h.usd ?? Number.NaN), 0);
  if (!(total > 0)) return { skipped: "unpriced" };
  const policy = overview.policy.policy;
  if (!policy) return { skipped: "no policy" };
  const compiled = compileMandate({ ...settings, treasuryValueUsd: total, volatileAssets: ["wNEAR"], stablecoins: ["USDC"] }, settings.profile as ProfileName);
  if (!compiled.ok) return { skipped: "mandate refused", problems: compiled.problems };
  const { weights, limits } = compiled.mandate;
  const aim = {
    targetBps: Object.fromEntries(Object.values(ASSETS).map(asset => [asset,
      asset === PROPOSAL_ASSETS.wNEAR ? weights.volatilePct * 100 : asset === PROPOSAL_ASSETS.USDC ? (weights.reservePct + weights.cashPct) * 100 : 0])),
    maxCostBps: limits.policy.maxSlippageBps,
  };
  const saved = { targetBps: Object.fromEntries(Object.entries(overview.target).map(([asset, share]) => [asset, Math.round(share * 10_000)])), maxCostBps: overview.rebalance.maxCostBps };
  if (sameAim(aim, saved)) return { skipped: "matches the saved strategy" };
  const last = proposals.last(agent, "mandate");
  if (last && sameAim(aim, last.strategy) && !last.closed) return { skipped: "open", id: last.id };
  if (last && sameAim(aim, last.strategy) && last.closed?.outcome === "declined") return { skipped: "declined", id: last.id };

  const read = await strategy();
  if (!read.ok) return { skipped: "strategy unread", kind: read.kind };
  const { strategy: now, digest } = read.value;
  if (sameAim(aim, now)) return { skipped: "matches the saved strategy" };
  const answers = `monthly spend ${settings.monthlySpendUsd} USD, ${settings.operatingCashMonths} months of operating cash, approvers ${settings.approvers.join(", ")}, destinations ${settings.destinations.join(", ")}`;
  const proposed = await proposals.propose({
    agent, from: "mandate", against: digest, policyAssets: policy.assets,
    strategy: { ...aim, minLegUsd: now.minLegUsd, autopilot: { everyMin: now.autopilot.everyMin, maxUsd: now.autopilot.maxUsd },
      ...(now.cashFloor && { cashFloor: { usd: now.cashFloor.usd, assets: now.cashFloor.assets } }) },
    reasons: (`Ballast's ${settings.profile} profile: ${weights.volatilePct}% volatile in wNEAR, and ${weights.reservePct}% reserve and ${weights.cashPct}% operating cash in USDC; `
      + `every other asset 0. The cost limit is the profile's slippage limit, ${aim.maxCostBps / 100}%. The owner's answers: ${answers}.`).slice(0, MAX_REASONS),
  });
  if (proposed.ok) return { proposed: proposed.id };
  return "full" in proposed ? { skipped: "proposals full" } : { skipped: "invalid", problems: proposed.problems };
}
