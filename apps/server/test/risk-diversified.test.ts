// The stabilization agent on the multi-sleeve book (#220, #221, ADR 6): the same assessment as the two-asset book's, over
// every holding with the bridges it crossed, each sleeve's own history, and gold-style price exposures as risk assets.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerOutput } from "@multiagency/sdk";
import type { RiskRecord } from "../../../packages/core/src/index.ts";
import { createBallast, createEngineState, createPriceHistory, type BallastSettings } from "../src/ballast.ts";
import { chainedFileAudit } from "../src/chain.ts";
import type { ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createHolds, createRequests } from "../src/requests.ts";
import { checkAuditLog } from "../src/replay-check.ts";
import { riskReportOf, type RiskEntry } from "../src/risk.ts";
import { createWatch, type WatchedAgent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const ORG = "owner--near", AGENT = "portfolio";
const WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near", USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const DIVERSIFIED: BallastSettings = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"],
  diversification: { sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
    venueCapsPct: { "near-intents": 50, "omft-ethereum": 25 } } };

/** 35 calm days at `price`, then a fall of `pct` percent over the last day: a slide in progress, with a warm EMA. */
function series(price: number, pct: number, now: number) {
  const out: { at: number; price: number }[] = [];
  const from = now - DAY;
  for (let at = now - 36 * DAY; at < now; at += HOUR) {
    const fall = at <= from ? 0 : pct / 100 * (at - from) / (DAY - HOUR);
    out.push({ at, price: price * (1 - fall) });
  }
  return out;
}
/** 50,000 USDC and 25,000 each of wNEAR and ETH: 12,000 of it is the cash floor, and each sleeve is a quarter of the book. */
function overview(now: number): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, price: number, usd: number) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price, priceUpdatedAt: new Date(now - 60_000).toISOString(), priceExpiresAt: new Date(now + 240_000).toISOString(), usd });
  return { agentId: "id-portfolio", book: [row(USDC, "USDC", 6, 1, 50_000), row(WNEAR, "wNEAR", 24, 2, 25_000), row(ETH, "ETH", 18, 1.5, 25_000)],
    unmanaged: [], target: { [WNEAR]: 0.2, [ETH]: 0.2 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null } as unknown as OwnerOutput<"overview">;
}

async function world({ pct = 50, risk = true, autopilotOn = false }: { pct?: number; risk?: boolean; autopilotOn?: boolean } = {}) {
  const dir = tempDir("treasury-risk-div-");
  const clock = { now: T0 };
  const requests = await createRequests(join(dir, "requests.json"));
  const history = await createPriceHistory(join(dir, "requests.json.history"));
  const states = await createEngineState(join(dir, "requests.json.engine"));
  await history.seed(WNEAR, series(2, pct, T0), T0);
  await history.seed(ETH, series(1.5, pct, T0), T0);
  const sent: unknown[] = [];
  const stored = new Map<string, ReturnType<typeof proposal>>();
  const platform: WatchPlatform = {
    overview: async () => ({ ok: true, value: overview(T0) }),
    unresolved: async () => ({ ok: true, value: [] }) as Awaited<ReturnType<WatchPlatform["unresolved"]>>,
    autopilot: async () => ({ ok: true, value: { on: autopilotOn, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } }) as Awaited<ReturnType<WatchPlatform["autopilot"]>>,
    strategy: async () => ({ ok: true, value: { strategy: { targetBps: { [USDC]: 6_000, [WNEAR]: 2_000, [ETH]: 2_000 }, minLegUsd: 1, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 0 } },
      digest: `sha256:${"c".repeat(64)}` } }) as unknown as Awaited<ReturnType<WatchPlatform["strategy"]>>,
    list: async () => ({ ok: true, value: { proposals: [...stored.values()] } }),
    get: async () => ({ ok: false, kind: "refused", status: 404, code: "not_found", error: "not_found" } as unknown as ProposalAnswer),
    create: async (_o, _a, input) => {
      sent.push(input);
      const view = stored.get(input.requestId) ?? proposal({ id: String(stored.size).padStart(32, "0"), requestId: input.requestId, expiresAt: input.expiresAt, state: "proposed" });
      stored.set(input.requestId, view);
      return { ok: true, value: view };
    },
    identity: async agent => ({ answer: { ok: true, value: { agent, owner: "owner.near", agentId: "id-portfolio", created: true, host: "platform.test", deployment: "treasury" } }, cached: false }),
    consents: async () => ({ ok: true, value: { consents: [] } }) as unknown as Awaited<ReturnType<WatchPlatform["consents"]>>,
  };
  const audit = chainedFileAudit<Record<string, unknown>>(join(dir, "audit.jsonl"), () => clock.now);
  await audit.check();
  const ballast = createBallast({ history, states, audit, now: () => clock.now });
  const holds = await createHolds(join(dir, "requests.json.holds"));
  const watch = createWatch({ platform, requests, holds, publicOrigin: "https://treasury.test", now: () => clock.now, ballast });
  const watched: WatchedAgent = { organization: ORG, agent: AGENT, driftPoints: 5, intervalS: 300, proposalHours: 24, ballast: DIVERSIFIED, ...(risk && { risk: {} }) };
  const entries = async () => (await readFile(audit.file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { seq: number; at: string; entry: Record<string, unknown> });
  return { sent, states, requests, audit, entries, tick: () => watch.tick(watched), log: () => readFile(audit.file, "utf8") };
}

test("a crash on the multi-sleeve book raises the level and proposes one de-risk sell of the largest asset the swap can price, for the owner to approve", async () => {
  const w = await world();
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  const risk = event.risk as { level: number; recommendations: string[]; derisk: { sizeUsd: number } | null };
  assert.ok(risk.level >= 2);
  // Half the book at risk falling by half is past the freeze step too: recommended only, never proposed.
  assert.deepEqual(risk.recommendations, ["hold-buys", "de-risk", "recommend-freeze"]);
  assert.equal(w.sent.length, 1, "one proposal: the de-risk, and none of Ballast's sleeves");
  const sent = w.sent[0] as { legs: { from: string; to: string }[]; note: string; requestId: string };
  // ETH and wNEAR tie at 25,000; the tie breaks on the asset id, so ETH, which crossed the bridge, is the sale.
  assert.deepEqual([sent.legs[0]!.from, sent.legs[0]!.to], [ETH, USDC]);
  assert.match(sent.note, /^Stabilization de-risk: sell 2000\.00 USD of ETH/);
  // It counts against the ETH sleeve alone: its cooldown and zone, the other sleeve's untouched.
  const state = w.states.find(ORG, AGENT);
  assert.deepEqual(state.proposed.map(p => [p.requestId, p.asset, p.sizeUsd]), [[sent.requestId, "ETH", 2_000]]);
  assert.equal(state.sleeves?.ETH?.whipsaw.lastAction, "sell-volatile");
  assert.equal(state.sleeves?.wNEAR, undefined);
  // The record comes first, with every input and the request it became, and Ballast's sleeves record no decision of their own.
  const entries = await w.entries();
  assert.deepEqual(entries.map(e => e.entry.kind), ["risk"]);
  assert.equal(entries[0]!.entry.requestId, sent.requestId);
});

test("the record's book names each holding's bridge, and the scenarios include each bridge's outage, which cuts off what crossed it", async () => {
  const w = await world();
  await w.tick();
  const [{ entry }] = (await w.entries()) as unknown as [{ entry: RiskEntry }];
  assert.deepEqual(entry.input.book.map(h => [h.symbol, h.class, h.venue, h.via ?? null]), [
    ["USDC", "stable", "NEAR Intents", null], ["wNEAR", "volatile", "NEAR Intents", null], ["ETH", "volatile", "NEAR Intents", ["Ethereum bridge (omft)"]],
  ]);
  const bridge = entry.assessment.scenarios.find(s => s.id === "venue:Ethereum bridge (omft):7d");
  assert.ok(bridge, entry.assessment.scenarios.map(s => s.id).join(", "));
  assert.equal(bridge.tradable, false, "ETH can't be traded while its bridge is down");
  assert.equal(entry.assessment.scenarios.find(s => s.id === "venue:NEAR Intents:1d")!.tradable, false);
  // Each volatile sleeve's own hourly history is in the input, so the projection draws on both.
  assert.deepEqual(Object.keys(entry.input.history).sort(), [ETH, WNEAR].sort());
  // The owner's report reads it like any other.
  const report = riskReportOf({ seq: 1, at: new Date(T0).toISOString(), entry });
  assert.ok(report.scenarios.some(s => s.id === "venue:Ethereum bridge (omft):7d"));
  assert.equal(report.proposed, true);
});

test("the log replays: the assessment of the multi-sleeve book is made again from its inputs, and a changed input is named", async () => {
  const w = await world();
  await w.tick();
  const log = await w.log();
  assert.equal(checkAuditLog(log).ok, true, checkAuditLog(log).message);
});

test("without a risk block the multi-sleeve book decides as before: no assessment recorded", async () => {
  const w = await world({ risk: false });
  await w.tick();
  assert.ok(!(await w.entries()).some(e => e.entry.kind === "risk"));
});

test("with autopilot on the multi-sleeve book is still assessed and may be told to pause it, while nothing is proposed", async () => {
  const w = await world({ autopilotOn: true });
  const event = await w.tick();
  assert.equal(event.held, "autopilot", JSON.stringify(event));
  const risk = event.risk as { recommendations: string[] };
  assert.ok(risk.recommendations.includes("pause-autopilot"));
  assert.equal(w.sent.length, 0);
  assert.deepEqual((await w.entries()).map(e => e.entry.kind), ["risk"]);
  assert.equal("requestId" in (await w.entries())[0]!.entry, false);
});

test("a calm market raises nothing: the assessment is recorded at L0 and Ballast's sleeves decide, with the risk event beside the hold", async () => {
  const w = await world({ pct: 0 });
  const event = await w.tick();
  const kinds = (await w.entries()).map(e => e.entry.kind);
  assert.equal(kinds[0], "risk");
  const risk = event.risk as { level: number } | undefined;
  assert.equal(risk?.level, 0, JSON.stringify(event));
  const record = (await w.entries())[0]!.entry as unknown as RiskRecord;
  assert.equal(record.assessment.derisk, null);
});
