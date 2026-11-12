import { PROPOSAL_ASSETS } from "../../../packages/core/src/index.ts";
import { createBallast, type BallastSettings, type EngineStates, type PriceHistory } from "./ballast.ts";
import type { ChainRecord } from "./chain.ts";
import type { WatchPlatform } from "./platform.ts";
import type { RiskEntry, StoredRisk } from "./risk.ts";

export class AssessmentBusy extends Error {}
export const MAX_ACTIVE_ASSESSMENTS = 8;

/** Explicit local recording: only platform reads, no watcher or proposal capability. */
export function createAssessment({ platform, history, states, audit, now = Date.now }: {
  platform: Pick<WatchPlatform, "overview" | "autopilot">;
  history: PriceHistory; states: EngineStates;
  audit: { appendRecord(entry: RiskEntry): Promise<ChainRecord<RiskEntry>> };
  now?: () => number;
}) {
  const active = new Set<string>();
  return async (organization: string, agent: string, terms: BallastSettings): Promise<StoredRisk | null> => {
    if (active.has(organization) || active.size >= MAX_ACTIVE_ASSESSMENTS) throw new AssessmentBusy("assessment capacity unavailable");
    active.add(organization);
    try {
      const reads = await Promise.allSettled([platform.overview(organization, agent), platform.autopilot(organization, agent)]);
      const [overviewRead, autopilotRead] = reads;
      if (overviewRead.status === "rejected" || autopilotRead.status === "rejected") throw new Error("assessment prerequisites unavailable");
      const overview = overviewRead.value, autopilot = autopilotRead.value;
      if (!overview.ok || !autopilot.ok) throw new Error("assessment prerequisites unavailable");
      if (!terms.diversification && overview.value.book.some(row =>
        row.asset !== PROPOSAL_ASSETS.wNEAR && row.asset !== PROPOSAL_ASSETS.USDC)) return null;
      const at = now();
      if (overview.value.book.some(row => row.usd === null || !Number.isFinite(row.usd) || row.usd < 0 ||
        row.price === null || !Number.isFinite(row.price) || row.price <= 0 ||
        !Number.isFinite(Date.parse(row.priceUpdatedAt ?? "")) || Date.parse(row.priceUpdatedAt!) > at ||
        !Number.isFinite(Date.parse(row.priceExpiresAt ?? "")) || Date.parse(row.priceExpiresAt!) <= at)) return null;
      let recorded: StoredRisk | null = null;
      const engine = createBallast({ history, states, now: () => at, audit: {
        append: async entry => {
          if (entry.kind !== "risk") throw new Error("assessment attempted a decision record");
          const record = await audit.appendRecord(entry);
          recorded = { seq: record.seq, at: record.at, entry: record.entry };
        },
      } });
      const decide = terms.diversification ? engine.decideDiversified : engine.decide;
      await decide(organization, agent, terms, overview.value, 1, {}, autopilot.value.on, true);
      return recorded;
    } finally { active.delete(organization); }
  };
}
