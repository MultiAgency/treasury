import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerOutput } from "@multiagency/sdk";
import { RISK_PROFILE_DEFAULTS, type RiskThresholds } from "../../../packages/core/src/index.ts";
import { createBallast, createEngineState, createPriceHistory, type BallastSettings } from "../src/ballast.ts";
import { chainedFileAudit } from "../src/chain.ts";
import type { ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createHolds, createRequests } from "../src/requests.ts";
import { checkAuditLog } from "../src/replay-check.ts";
import { latestRiskRecord, riskReportOf, type RiskSettings } from "../src/risk.ts";
import { loadWatchConfig } from "../src/watch-config.ts";
import { createWatch, type WatchedAgent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const ORG = "owner--near", AGENT = "portfolio";
const WNEAR = "nep141:wrap.near", USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const SETTINGS: BallastSettings = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };
const RISK: RiskSettings = {};

/** 35 calm days at 4 USD, then a fall of `pct` percent over `days`: a slide in progress, with a warm EMA. */
function crash(pct: number, now: number, days = 1) {
  const out: { at: number; price: number }[] = [];
  const from = now - days * DAY;
  for (let at = now - 36 * DAY; at < now; at += HOUR) {
    const fall = at <= from ? 0 : pct / 100 * (at - from) / (days * DAY - HOUR);
    out.push({ at, price: 4 * (1 - fall) });
  }
  return out;
}

/** `volatileUsd` of wNEAR at `price` and `stableUsd` of USDC, with the cash floor the balanced mandate carries. */
function overview(price: number, volatileUsd: number, stableUsd: number, now: number, change: Partial<OwnerOutput<"overview">> = {}): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, rowPrice: number, usd: number) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price: rowPrice, priceUpdatedAt: new Date(now - 60_000).toISOString(), priceExpiresAt: new Date(now + 240_000).toISOString(), usd });
  return {
    agentId: "id-portfolio", book: [row(USDC, "USDC", 6, 1, stableUsd), row(WNEAR, "wNEAR", 24, price, volatileUsd)], unmanaged: [],
    target: { [USDC]: 0.85, [WNEAR]: 0.15 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null, ...change,
  } as unknown as OwnerOutput<"overview">;
}

async function world({ pct = 50, days = 1, seeded = true, withRisk = true, risk = RISK, ballast: ballastChanges = SETTINGS,
  price = 2, volatileUsd = 40_000, stableUsd = 60_000, autopilotOn = false }:
  { pct?: number; days?: number; seeded?: boolean; withRisk?: boolean; risk?: RiskSettings; ballast?: BallastSettings; price?: number; volatileUsd?: number; stableUsd?: number; autopilotOn?: boolean } = {}) {
  const dir = tempDir("treasury-risk-");
  const clock = { now: T0 };
  const requests = await createRequests(join(dir, "requests.json"));
  const history = await createPriceHistory(join(dir, "requests.json.history"));
  const states = await createEngineState(join(dir, "requests.json.engine"));
  if (seeded) await history.seed(WNEAR, crash(pct, T0, days), T0);
  const answers: { overview: OwnerOutput<"overview">; create?: ProposalAnswer } = { overview: overview(price, volatileUsd, stableUsd, T0) };
  const stored = new Map<string, ReturnType<typeof proposal>>();
  const sent: unknown[] = [];
  const platform: WatchPlatform = {
    overview: async () => ({ ok: true, value: answers.overview }),
    unresolved: async () => ({ ok: true, value: [] }) as Awaited<ReturnType<WatchPlatform["unresolved"]>>,
    autopilot: async () => ({ ok: true, value: { on: autopilotOn, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } }) as Awaited<ReturnType<WatchPlatform["autopilot"]>>,
    strategy: async () => ({ ok: true, value: { strategy: { targetBps: { [USDC]: 6_000, [WNEAR]: 4_000 }, minLegUsd: 1, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 0 } },
      digest: `sha256:${"c".repeat(64)}` } }) as unknown as Awaited<ReturnType<WatchPlatform["strategy"]>>,
    list: async () => ({ ok: true, value: { proposals: [...stored.values()] } }),
    get: async (_o, _a, id) => {
      const found = [...stored.values()].find(view => view.id === id);
      return found ? { ok: true, value: found } : ({ ok: false, kind: "refused", status: 404, code: "not_found", error: "not_found" } as unknown as ProposalAnswer);
    },
    create: async (_o, _a, input) => {
      sent.push(input);
      if (answers.create) return answers.create;
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
  const watched: WatchedAgent = { organization: ORG, agent: AGENT, driftPoints: 5, intervalS: 300, proposalHours: 24, ballast: ballastChanges,
    ...(withRisk ? { risk } : {}) };
  const entries = async () => (await readFile(audit.file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { seq: number; at: string; entry: Record<string, unknown> });
  return { dir, clock, answers, stored, sent, history, states, requests, audit, watch, watched, entries,
    tick: () => watch.tick(watched), log: () => readFile(audit.file, "utf8") };
}

test("with autopilot on, the risk agent still assesses and recommends pausing it, while Ballast proposes nothing", async () => {
  const w = await world({ autopilotOn: true });
  const event = await w.tick();
  assert.equal(event.held, "autopilot", JSON.stringify(event));
  const risk = event.risk as { level: number; recommendations: string[] };
  assert.ok(risk.level >= 2, JSON.stringify(risk));
  assert.ok(risk.recommendations.includes("pause-autopilot"), JSON.stringify(risk));
  assert.equal(w.sent.length, 0, "nothing proposed while autopilot runs");
  const entries = await w.entries();
  assert.deepEqual(entries.map(e => e.entry.kind), ["risk"], "an assessment, and no Ballast decision");
  assert.equal("requestId" in entries[0]!.entry, false, "no request named for a de-risk that isn't proposed");
});

test("a crash raises the forward level and proposes one de-risk sell for the owner, recorded before anything acts", async () => {
  const w = await world();
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  const risk = event.risk as { level: number; reason: string; recommendations: string[]; derisk: { sizeUsd: number; blocked: string | null } | null };
  assert.ok(risk.level >= 2, risk.reason);
  assert.deepEqual(risk.recommendations, ["hold-buys", "de-risk"]);
  assert.ok(risk.derisk && risk.derisk.sizeUsd > 0 && risk.derisk.sizeUsd <= 2_000, JSON.stringify(risk.derisk));
  // One proposal, the de-risk sell: within the balanced order cap (2% of 100,000), explicit legs, stored before it is sent.
  assert.equal(w.sent.length, 1);
  const sent = w.sent[0] as { legs: { from: string; to: string; amount: string; minAmountOut: string }[]; note: string; requestId: string };
  assert.deepEqual([sent.legs[0]!.from, sent.legs[0]!.to], [WNEAR, USDC]);
  assert.match(sent.note, /^Stabilization de-risk: sell 2000\.00 USD of wNEAR into USDC/);
  assert.equal(w.requests.of(ORG, AGENT).length, 1);
  assert.equal(w.requests.of(ORG, AGENT)[0]!.requestId, sent.requestId);
  // The engine state counts it like a Ballast proposal, so the cooldown and turnover apply to the next tick.
  assert.deepEqual(w.states.find(ORG, AGENT).proposed.map(p => [p.requestId, p.sizeUsd]), [[sent.requestId, 2_000]]);
  assert.deepEqual(w.states.find(ORG, AGENT).whipsaw, { lastActionAt: T0, lastAction: "sell-volatile" });
  // The risk record comes first, with every input and the request it became; Ballast's own decision follows and claims none.
  const entries = await w.entries();
  assert.deepEqual(entries.map(e => e.entry.kind), ["risk", "decision"]);
  assert.equal(entries[0]!.entry.requestId, sent.requestId);
  assert.deepEqual((entries[0]!.entry.input as { book: unknown[] }).book.length, 2);
  assert.equal("requestId" in entries[1]!.entry, false);
  // Every record replays from its inputs.
  assert.equal(checkAuditLog(await w.log()).ok, true, checkAuditLog(await w.log()).message);
});

test("the latest risk record reads back for the owner's report, with its time and sequence number", async () => {
  const w = await world();
  await w.tick();
  const stored = await latestRiskRecord(w.audit.file, ORG, AGENT);
  assert.ok(stored);
  assert.equal(stored.seq, 1);
  assert.equal(stored.at, new Date(T0).toISOString());
  assert.equal(await latestRiskRecord(w.audit.file, ORG, "another"), null);
  const report = riskReportOf(stored);
  assert.ok(report.level >= 2);
  assert.match(report.reason, /expected shortfall|drawdown/);
  assert.equal(report.seq, 1);
  assert.equal(report.scenarios.length, 9);
  assert.equal(report.scenarios[0]!.id, `drop:${WNEAR}:80`);
  assert.deepEqual(report.recommendations.map(r => r.action), ["hold-buys", "de-risk"]);
  assert.ok(report.derisk && report.derisk.sizeUsd === 2_000 && report.derisk.blocked === null);
  assert.equal(report.proposed, true);
  assert.ok(report.projection.projectedDrawdownPct > 0);
});

test("without the risk block nothing is recorded and Ballast decides alone", async () => {
  const w = await world({ withRisk: false });
  const event = await w.tick();
  assert.equal("risk" in event, false);
  const entries = await w.entries();
  assert.deepEqual(entries.map(e => e.entry.kind), ["decision"]);
  assert.equal(checkAuditLog(await w.log()).ok, true);
});

test("a forward L1 holds Ballast's buys: the detections join the same tick's regime, once", async () => {
  // A 50% slide over a week: no market detector fires, so the hold below is the forward detections' doing.
  const w = await world({ pct: 50, days: 7, price: 2 });
  const event = await w.tick();
  const risk = event.risk as { level: number; recommendations: string[] };
  assert.equal(risk.level, 1, JSON.stringify(risk));
  assert.deepEqual(risk.recommendations, ["hold-buys"]);
  assert.equal(event.skipped, "ballast holds", JSON.stringify(event));
  assert.match(String(event.reason), /regime forward-risk/);
  assert.equal(w.sent.length, 0);
  const riskEntry = (await w.entries())[0]!.entry as { assessment: { level: number } };
  assert.equal(riskEntry.assessment.level, 1);
});

test("a de-risk inside the cooldown is recommended, not proposed, and the record names no request", async () => {
  const w = await world();
  await w.states.change(ORG, AGENT, s => ({ ...s, whipsaw: { lastActionAt: T0 - 30 * 60_000, lastAction: "buy-volatile" } }));
  const event = await w.tick();
  const risk = event.risk as { derisk: { sizeUsd: number; blocked: string } | null };
  assert.match(risk.derisk!.blocked!, /^a trade was proposed within the cooldown/);
  assert.equal("requestId" in (await w.entries())[0]!.entry, false);
  assert.equal(w.requests.of(ORG, AGENT).length, 0);
});

test("a freeze is only ever recommended, never proposed: the request flow carries only a de-risk sell or Ballast's own", async () => {
  // A low freeze step makes the recommendation certain: this test is about never acting on it, not about its threshold.
  const thresholds: RiskThresholds = { ...RISK_PROFILE_DEFAULTS.balanced, freezeShortfallPct: 1 };
  const w = await world({ pct: 70, price: 1.2, ballast: { ...SETTINGS, risk: thresholds } });
  const event = await w.tick();
  const risk = event.risk as { recommendations: string[] };
  assert.ok(risk.recommendations.includes("recommend-freeze"), JSON.stringify(risk));
  // A freeze is not a proposal this server can make: the only request is the de-risk sell (or Ballast's own trade).
  for (const request of w.requests.of(ORG, AGENT)) assert.doesNotMatch(request.body, /freeze/i);
  const entries = await w.entries();
  assert.ok(entries.every(e => e.entry.action !== "freeze"), "no freeze action is recorded");
  assert.ok(!JSON.stringify(entries).includes('"type":"agent_freeze"'));
});

test("the watch file takes a risk block only with Ballast, and checks its parameters and any threshold override", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const dir = tempDir("treasury-risk-config-");
  const file = join(dir, "watch.json");
  const write = async (agent: Record<string, unknown>) => { await writeFile(file, JSON.stringify({ agents: [agent] })); await chmod(file, 0o600); };
  await write({ organization: ORG, agent: AGENT, ballast: SETTINGS, risk: { projection: { paths: 200 } } });
  assert.deepEqual((await loadWatchConfig(file))[0]!.risk, { projection: { paths: 200 } });
  await write({ organization: ORG, agent: AGENT, ballast: SETTINGS, risk: { projection: { paths: 0 } } });
  await assert.rejects(loadWatchConfig(file), /risk\.projection/);
  await write({ organization: ORG, agent: AGENT, ballast: SETTINGS, risk: { scenarios: { spendFactor: 1 } } });
  await assert.rejects(loadWatchConfig(file), /risk\.scenarios/);
  await write({ organization: ORG, agent: AGENT, risk: {} });
  await assert.rejects(loadWatchConfig(file), /risk without ballast/);
  await write({ organization: ORG, agent: AGENT, ballast: { ...SETTINGS, risk: { ...SETTINGS } }, risk: {} });
  await assert.rejects(loadWatchConfig(file), /ballast\.risk/);
});
