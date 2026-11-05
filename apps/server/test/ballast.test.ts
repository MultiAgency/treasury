import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerOutput, ProposalView } from "@multiagency/sdk";
import { createBallast, createEngineState, createPriceHistory, type BallastSettings } from "../src/ballast.ts";
import type { ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createHolds, createRequests } from "../src/requests.ts";
import { loadWatchConfig } from "../src/watch-config.ts";
import { createWatch, type WatchedAgent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const ORG = "owner--near", AGENT = "portfolio";
const WNEAR = "nep141:wrap.near", USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const HOUR = 3_600_000, DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const SETTINGS: BallastSettings = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };
const WATCHED: WatchedAgent = { organization: ORG, agent: AGENT, driftPoints: 5, intervalS: 300, proposalHours: 24, ballast: SETTINGS };

/** 31 days at 4 USD, then a steady fall to 3.12 over the last 5 days: 22% under the reference, with no fast move or crash. */
function fallingHistory(now: number) {
  const out: { at: number; price: number }[] = [];
  for (let at = now - 36 * DAY; at < now; at += HOUR) {
    const fall = Math.max(0, Math.min(1, (at - (now - 5 * DAY)) / (5 * DAY - HOUR)));
    out.push({ at, price: 4 - fall * 0.88 });
  }
  return out;
}

/** 15,000 USD of wNEAR at `price` and 85,000 of USDC: inside the balanced bounds, and a buy stays under any venue cap. */
function overview(price: number | null, now: number, change: Partial<OwnerOutput<"overview">> = {}): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, rowPrice: number | null, usd: number | null) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price: rowPrice, priceUpdatedAt: new Date(now - 60_000).toISOString(), priceExpiresAt: new Date(now + 240_000).toISOString(), usd });
  return {
    agentId: "id-portfolio", book: [row(USDC, "USDC", 6, 1, 85_000), row(WNEAR, "wNEAR", 24, price, price === null ? null : 15_000)], unmanaged: [],
    target: { [USDC]: 0.85, [WNEAR]: 0.15 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, notInForce: null, ...change,
  } as unknown as OwnerOutput<"overview">;
}

async function world({ seeded = true }: { seeded?: boolean } = {}) {
  const dir = tempDir("treasury-ballast-");
  const clock = { now: T0 };
  const requests = await createRequests(join(dir, "requests.json"));
  const history = await createPriceHistory(join(dir, "requests.json.history"));
  const states = await createEngineState(join(dir, "requests.json.engine"));
  if (seeded) await history.seed(WNEAR, fallingHistory(T0), T0);
  const answers = { overview: overview(3.12, T0) };
  const stored = new Map<string, ProposalView>();
  const sent: unknown[] = [];
  const platform: WatchPlatform = {
    overview: async () => ({ ok: true, value: answers.overview }),
    unresolved: async () => ({ ok: true, value: [] }) as Awaited<ReturnType<WatchPlatform["unresolved"]>>,
    autopilot: async () => ({ ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } }) as Awaited<ReturnType<WatchPlatform["autopilot"]>>,
    list: async () => ({ ok: true, value: { proposals: [...stored.values()] } }),
    get: async (_o, _a, id) => {
      const found = [...stored.values()].find(view => view.id === id);
      return found ? { ok: true, value: found } : ({ ok: false, kind: "refused", status: 404, code: "not_found", error: "not_found" } as unknown as ProposalAnswer);
    },
    create: async (_o, _a, input) => {
      sent.push(input);
      const view = stored.get(input.requestId) ?? proposal({ id: String(stored.size).padStart(32, "0"), requestId: input.requestId, expiresAt: input.expiresAt, state: "proposed" });
      stored.set(input.requestId, view);
      return { ok: true, value: view };
    },
    identity: async agent => ({ answer: { ok: true, value: { agent, owner: "owner.near", agentId: "id-portfolio", created: true, host: "platform.test", deployment: "treasury" } }, cached: false }),
    consents: async () => ({ ok: true, value: { consents: [] } }) as Awaited<ReturnType<WatchPlatform["consents"]>>,
  };
  const ballast = createBallast({ history, states, now: () => clock.now });
  const watch = createWatch({ platform, requests, holds: await createHolds(join(dir, "requests.json.holds")), publicOrigin: "https://treasury.test", now: () => clock.now, ballast });
  return { dir, clock, answers, stored, sent, history, states, requests, tick: (agent = WATCHED) => watch.tick(agent) };
}

test("a warmed-up history 22% under its reference proposes one DCA buy of explicit legs, stored before it's sent", async () => {
  const w = await world();
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  assert.equal(w.sent.length, 1);
  const input = w.sent[0] as { legs: { from: string; to: string; amount: string; minAmountOut: string }[]; note: string; requestId: string };
  assert.equal(input.legs.length, 1);
  const [leg] = input.legs;
  assert.deepEqual([leg!.from, leg!.to], [USDC, WNEAR], "a buy spends the reserve's USDC for wNEAR");
  // One DCA unit: 20% of the reserve (85,000 less the 12,000 floor) over 10 units, 1,460 USD, in USDC's 6 decimals.
  assert.equal(leg!.amount, "1460000000");
  assert.ok(BigInt(leg!.minAmountOut) > 0n);
  assert.match(input.note, /^Ballast dca-1: buy 1460\.00 USD of wNEAR/);
  // The proposal is counted, and its zone disarmed, under the request's own id.
  const state = w.states.find(ORG, AGENT);
  assert.deepEqual(state.proposed.map(p => [p.requestId, p.sizeUsd, p.dcaUnits, p.settled]), [[input.requestId, 1460, 1, false]]);
  assert.deepEqual([state.whipsaw.lastAction, state.whipsaw.disarmed], ["buy-volatile", "dca-1"]);
  assert.equal(state.dcaUnitsUsed, 0, "units are spent only once it executes");

  const next = await w.tick();
  assert.equal(next.skipped, "live proposal", "one proposal at a time");
  assert.equal(w.sent.length, 1);
});

test("an executed buy spends its DCA units once; afterwards its zone waits to re-arm", async () => {
  const w = await world();
  await w.tick();
  const [requestId, view] = [...w.stored][0]!;
  w.stored.set(requestId, { ...view, state: "executed" });
  w.clock.now += 30 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
  const event = await w.tick();
  assert.equal(w.states.find(ORG, AGENT).dcaUnitsUsed, 1);
  assert.equal(event.skipped, "ballast holds");
  assert.match(String(event.reason), /dca-1 already traded/);
  assert.equal(w.requests.of(ORG, AGENT).length, 0, "the ended request is dropped");
});

test("a rejected or expired proposal spends no DCA units, but still counts towards the day's turnover", async () => {
  for (const ended of ["rejected", "expired"] as const) {
    const w = await world();
    await w.tick();
    const [requestId, view] = [...w.stored][0]!;
    w.stored.set(requestId, { ...view, state: ended });
    w.clock.now += 2 * HOUR;
    w.answers.overview = overview(3.12, w.clock.now);
    await w.tick();
    const state = w.states.find(ORG, AGENT);
    assert.equal(state.dcaUnitsUsed, 0, ended);
    assert.deepEqual(state.proposed.map(p => p.settled), [true], ended);
  }
});

test("with no history the oracle warms up: a hold, and every reading joins the history", async () => {
  const w = await world({ seeded: false });
  const event = await w.tick();
  assert.equal(event.skipped, "ballast holds");
  assert.equal(event.frozen, "warming-up");
  assert.equal(w.sent.length, 0);
  assert.equal(w.history.of(WNEAR).length, 1);
  for (let i = 0; i < 3; i++) { w.clock.now += 10 * 60_000; w.answers.overview = overview(3.12, w.clock.now); await w.tick(); }
  assert.equal(w.history.of(WNEAR).length, 4, "readings of the last two hours are all kept, for the TWAP");
  assert.equal(w.history.hourly(WNEAR).length, 1, "the detectors see one an hour");
});

test("readings older than two hours are thinned to the first of each hour", async () => {
  const w = await world({ seeded: false });
  for (let i = 0; i < 4 * 12; i++) { w.answers.overview = overview(3.12, w.clock.now); await w.tick(); w.clock.now += 5 * 60_000; }
  const kept = w.history.of(WNEAR), last = kept.at(-1)!.at;
  assert.ok(kept.filter(s => s.at < last - 2 * HOUR).every((s, i, old) => i === 0 || Math.floor(s.at / HOUR) !== Math.floor(old[i - 1]!.at / HOUR)));
  assert.ok(kept.filter(s => s.at >= last - 2 * HOUR).length >= 24, "the last two hours keep every 5-minute reading");
});

test("a stale platform price freezes the reading: nothing is proposed, and nothing joins the history", async () => {
  const w = await world();
  const before = w.history.of(WNEAR).length;
  w.answers.overview = overview(3.12, T0 - 10 * 60_000);
  const event = await w.tick();
  assert.equal(event.skipped, "ballast holds");
  assert.equal(event.frozen, "stale");
  assert.equal(w.history.of(WNEAR).length, before);
  assert.equal(w.sent.length, 0);
});

test("an unpriced asset, a book without both assets, or a mandate the treasury can't meet proposes nothing, and says why", async () => {
  const unpriced = await world();
  unpriced.answers.overview = overview(null, T0);
  assert.equal((await unpriced.tick()).skipped, "unpriced");

  const missing = await world();
  missing.answers.overview = overview(3.12, T0, { book: overview(3.12, T0).book.slice(0, 1) } as never);
  assert.equal((await missing.tick()).skipped, "ballast needs wNEAR and USDC in the book");

  const floor = await world();
  // A 30,000 USD floor (5,000 a month for 6 months) is over the balanced profile's 25% cash share of 100,000.
  const event = await floor.tick({ ...WATCHED, ballast: { ...SETTINGS, monthlySpendUsd: 5_000 } });
  assert.equal(event.skipped, "mandate refused");
  for (const w of [unpriced, missing, floor]) assert.equal(w.sent.length, 0);
});

test("the conservative profile starts at L2: its buy is still proposed, for the owner to approve", async () => {
  const w = await world();
  const event = await w.tick({ ...WATCHED, ballast: { ...SETTINGS, profile: "conservative", operatingCashMonths: 9, approvers: ["owner.near", "cfo.near"] } });
  // Conservative caps one order at 1% of the treasury: sized to 1,000 USD, not the default 2%.
  assert.ok("proposed" in event, JSON.stringify(event));
  assert.equal((w.sent[0] as { legs: { amount: string }[] }).legs[0]!.amount, "1000000000");
  assert.match((w.sent[0] as { note: string }).note, /L2: a human must approve this order/);
});

test("the engine state and the history survive a restart", async () => {
  const w = await world();
  await w.tick();
  const states = await createEngineState(join(w.dir, "requests.json.engine"));
  const history = await createPriceHistory(join(w.dir, "requests.json.history"));
  assert.deepEqual(states.find(ORG, AGENT), w.states.find(ORG, AGENT));
  assert.equal(history.of(WNEAR).length, w.history.of(WNEAR).length);
});

test("watch's config takes an agent's Ballast settings, and refuses them read less than hourly", async () => {
  const dir = tempDir("treasury-ballast-config-");
  const file = join(dir, "watch.json");
  const write = async (agent: Record<string, unknown>) => { await writeFile(file, JSON.stringify({ agents: [agent] })); await chmod(file, 0o600); };
  await write({ organization: ORG, agent: AGENT, ballast: SETTINGS });
  assert.deepEqual((await loadWatchConfig(file))[0]!.ballast, SETTINGS);
  await write({ organization: ORG, agent: AGENT, intervalS: 7200, ballast: SETTINGS });
  await assert.rejects(loadWatchConfig(file), /needs a reading at least hourly/);
  await write({ organization: ORG, agent: AGENT, ballast: { ...SETTINGS, profile: "aggressive" } });
  await assert.rejects(loadWatchConfig(file), /ballast\.profile/);
});

test("a history 24% over its reference proposes a trim: wNEAR sold for USDC, within the volatile floor", async () => {
  const w = await world({ seeded: false });
  const rising: { at: number; price: number }[] = [];
  for (let at = T0 - 36 * DAY; at < T0; at += HOUR) rising.push({ at, price: 4 + Math.max(0, Math.min(1, (at - (T0 - 5 * DAY)) / (5 * DAY - HOUR))) * 0.96 });
  await w.history.seed(WNEAR, rising, T0);
  w.answers.overview = overview(4.96, T0);
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  const [leg] = (w.sent[0] as { legs: { from: string; to: string; amount: string }[] }).legs;
  assert.deepEqual([leg!.from, leg!.to], [WNEAR, USDC]);
  // trim-1 sells 5% of the 15,000 USD of wNEAR: 750 USD at 4.96, in wNEAR's 24 decimals, rounded down.
  assert.equal(leg!.amount, String(750n * 10n ** 24n * 100n / 496n));
  assert.equal(w.states.find(ORG, AGENT).proposed[0]!.dcaUnits, 0, "a sell spends no DCA units");
});
