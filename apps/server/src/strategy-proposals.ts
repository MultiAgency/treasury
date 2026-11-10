import { randomBytes } from "node:crypto";
import { ASSETS, type OwnerOutput } from "@multiagency/sdk";
import { z } from "zod";
import { ASSET_REGISTRY, compileMandate, PROPOSAL_ASSETS, type ProfileName } from "../../../packages/core/src/index.ts";
import type { Audit } from "./audit.ts";
import { mandateAnswersOf, type BallastSettings } from "./ballast.ts";
import { MAX_PROPOSAL_REASONS, strategyInput, strategyProposal } from "./contract.ts";
import { createRecords, memoryRecords } from "./records.ts";

/** Records kept in all: the open proposals, and the last closed one of each agent's source. */
const MAX_RECORDS = 1_024;

const source = strategyProposal.shape.source;
export type ProposalSource = z.output<typeof source>;
export type ProposedStrategy = z.output<typeof strategyInput>;

const stored = strategyProposal.extend({
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** Adopted or declined by the owner; superseded by a later proposal from its source, or by a change to the saved strategy. */
  closed: z.strictObject({ at: z.number().int(), outcome: z.enum(["adopted", "declined", "superseded"]) }).nullable(),
});
export type StrategyProposal = z.output<typeof stored>;
/** A proposal as the owner is shown it. */
export type StrategyProposalView = z.output<typeof strategyProposal>;

export type ProposalRecords = Pick<Awaited<ReturnType<typeof createRecords<typeof stored>>>, "all" | "commit">;
export const memoryProposalRecords = (): ProposalRecords => memoryRecords<StrategyProposal>();
/** The proposals file: owner-only like the others on `/data`. */
export const fileProposalRecords = (path: string) => createRecords(path, "proposals", stored, "the strategy proposals agents made");

/**
 * What's wrong with a strategy proposed for an agent whose policy allows `policyAssets` (`"any"`, or the assets it may
 * move): the Strategy page's bounds (`strategyInput`, with the cash floor the platform keeps beside them), and targets only over the policy's assets. Empty when it may be stored.
 */
export function strategyProblems(strategy: unknown, policyAssets: "any" | readonly string[]): string[] {
  const parsed = strategyInput.safeParse(strategy);
  if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join(".") || "strategy"}: ${issue.message}`);
  if (policyAssets === "any") return [];
  return Object.entries(parsed.data.targetBps).filter(([asset, bps]) => bps > 0 && !policyAssets.includes(asset))
    .map(([asset]) => `targetBps: ${asset} is outside the policy's assets`);
}

/** The floor's amount and counted assets; asset order carries no meaning. */
type Floor = { usd: number; assets: readonly string[] };
const sameAssets = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sameFloor = (a: Floor | undefined, b: Floor | undefined) =>
  a?.usd === b?.usd && sameAssets(a?.assets ?? [], b?.assets ?? []);
/** An asset's symbol as the owner reads it, from the registry; its ID when the registry doesn't know it. */
const symbolOf = (id: string) => Object.values(ASSET_REGISTRY).find(entry => entry.id === id)?.symbol ?? id;
/** The targets and cost limit the mandate chooses, apart from its cash floor. */
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
      if (reasons.trim().length === 0 || reasons.length > MAX_PROPOSAL_REASONS) problems.push(`reasons: 1 to ${MAX_PROPOSAL_REASONS} characters`);
      if (problems.length > 0) return { ok: false, problems };
      const at = now(), id = randomBytes(8).toString("hex");
      const proposal: StrategyProposal = { id, agent, source: from, strategy: strategyInput.parse(strategy), reasons, against, createdAt: at, closed: null };
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
 * other fields stay as saved. The targets come from `overview`; the saved strategy is read when the last proposal's
 * floor differs from the compiled one, to preserve any stronger saved floor before comparing them.
 */
export async function proposeMandate({ agent, settings, overview, strategy, proposals }: {
  agent: string; settings: BallastSettings; overview: OwnerOutput<"overview">;
  /** The saved strategy, read when the overview and last proposal don't establish a match. */
  strategy: () => Promise<{ ok: true; value: OwnerOutput<"strategy/get"> } | { ok: false; kind: string }>;
  proposals: StrategyProposals;
}): Promise<MandateNote> {
  const total = overview.book.reduce((sum, h) => sum + (h.usd ?? Number.NaN), 0);
  if (!(total > 0)) return { skipped: "unpriced" };
  const policy = overview.policy.policy;
  if (!policy) return { skipped: "no policy" };
  const compiled = compileMandate(mandateAnswersOf(settings, total), settings.profile as ProfileName);
  if (!compiled.ok) return { skipped: "mandate refused", problems: compiled.problems };
  const { weights, limits, diversification } = compiled.mandate;
  const targetBps: Record<string, number> = Object.fromEntries(Object.values(ASSETS).map(asset => [asset, 0]));
  if (diversification) {
    // Each sleeve is one platform asset's target; the reserve and cash split across the stablecoins the platform manages,
    // by the mandate's split. A coin it doesn't manage stays at 0, as the platform's strategy has no target for it.
    let sleeveBps = 0;
    for (const sleeve of diversification.sleeves) {
      const id = ASSET_REGISTRY[sleeve.asset]?.id;
      if (id && id in targetBps) { targetBps[id] = Math.round(sleeve.targetPct * 100); sleeveBps += targetBps[id]!; }
    }
    const stableTotal = 10_000 - sleeveBps;
    const split = Object.entries(diversification.stableSplit);
    let assigned = 0;
    for (const [coin, share] of split) {
      const id = ASSET_REGISTRY[coin]?.id;
      if (!id || !(id in targetBps)) continue;
      targetBps[id] = Math.round(stableTotal * share / 100);
      assigned += targetBps[id]!;
    }
    const firstManaged = split.map(([coin]) => ASSET_REGISTRY[coin]?.id).find(id => id !== null && id !== undefined && id in targetBps);
    if (firstManaged) targetBps[firstManaged] = (targetBps[firstManaged] ?? 0) + (stableTotal - assigned);
  } else {
    targetBps[PROPOSAL_ASSETS.wNEAR] = weights.volatilePct * 100;
    targetBps[PROPOSAL_ASSETS.USDC] = (weights.reservePct + weights.cashPct) * 100;
  }
  const aim = { targetBps, maxCostBps: limits.policy.maxSlippageBps };
  // The mandate's cash floor (ADR 4) on the platform: its months of operating cash times the monthly spend, rounded up to
  // the whole dollars the platform takes, counted in the stablecoins it manages for this book.
  const stableIds = diversification
    ? Object.keys(diversification.stableSplit).map(coin => ASSET_REGISTRY[coin]?.id).filter((id): id is string => typeof id === "string" && id in targetBps)
    : [PROPOSAL_ASSETS.USDC];
  const mandateFloor = stableIds.length > 0 ? { usd: Math.ceil(compiled.cashFloorUsd), assets: [...stableIds].sort() } : undefined;
  const saved = { targetBps: Object.fromEntries(Object.entries(overview.target).map(([asset, share]) => [asset, Math.round(share * 10_000)])), maxCostBps: overview.rebalance.maxCostBps };
  if (sameAim(aim, saved)) return { skipped: "matches the saved strategy" };
  const last = proposals.last(agent, "mandate");
  // An exact match needs no read. A different floor may be the owner's stronger saved one: read it before deciding,
  // rather than treating a changed mandate as the one already open or declined.
  const previousMatch = (floor: Floor | undefined): MandateNote | undefined => {
    if (!last || !sameAim(aim, last.strategy) || !sameFloor(floor, last.strategy.cashFloor)) return undefined;
    if (!last.closed) return { skipped: "open", id: last.id };
    if (last.closed.outcome === "declined") return { skipped: "declined", id: last.id };
    return undefined;
  };
  const matching = previousMatch(mandateFloor);
  if (matching) return matching;

  const read = await strategy();
  if (!read.ok) return { skipped: "strategy unread", kind: read.kind };
  const { strategy: now, digest } = read.value;
  // Amounts are comparable only over the same assets. Narrowing the set also changes which swaps count as recovery
  // under the floor, so different sets need separate constraints, which the platform's single floor can't hold.
  const savedFloor = now.cashFloor ? { usd: now.cashFloor.usd, assets: now.cashFloor.assets } : undefined;
  let floor = savedFloor ?? mandateFloor;
  if (savedFloor && mandateFloor) {
    if (!sameAssets(savedFloor.assets, mandateFloor.assets)) {
      if (last && !last.closed) await proposals.close(agent, last.id, "superseded");
      return { skipped: "cash floor assets conflict" };
    }
    floor = { usd: Math.max(savedFloor.usd, mandateFloor.usd), assets: mandateFloor.assets };
  }
  if (sameAim(aim, now) && sameFloor(floor, savedFloor)) return { skipped: "matches the saved strategy" };
  const unchanged = previousMatch(floor);
  if (unchanged) return unchanged;
  const answers = `monthly spend ${settings.monthlySpendUsd} USD, ${settings.operatingCashMonths} months of operating cash, approvers ${settings.approvers.join(", ")}, destinations ${settings.destinations.join(", ")}`;
  const proposed = await proposals.propose({
    agent, from: "mandate", against: digest, policyAssets: policy.assets,
    strategy: { ...aim, minLegUsd: now.minLegUsd, autopilot: { everyMin: now.autopilot.everyMin, maxUsd: now.autopilot.maxUsd },
      ...(floor && { cashFloor: floor }) },
    reasons: (`Ballast's ${settings.profile} profile: ${weights.volatilePct}% volatile${diversification
        ? ` across ${diversification.sleeves.map(s => `${s.asset} ${s.targetPct}%`).join(", ")}`
        : " in wNEAR"}, and ${weights.reservePct}% reserve and ${weights.cashPct}% operating cash${diversification
        ? ` across ${Object.entries(diversification.stableSplit).map(([coin, share]) => `${coin} ${share}%`).join(", ")}`
        : " in USDC"}; every other asset 0. The cost limit is the profile's slippage limit, ${aim.maxCostBps / 100}%.${floor
        ? ` The cash floor is ${floor.usd} USD in ${floor.assets.map(symbolOf).join(", ")}; adopting a changed floor asks for the grant again.` : ""} The owner's answers: ${answers}.`).slice(0, MAX_PROPOSAL_REASONS),
  });
  if (proposed.ok) return { proposed: proposed.id };
  return "full" in proposed ? { skipped: "proposals full" } : { skipped: "invalid", problems: proposed.problems };
}
