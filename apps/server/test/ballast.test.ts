import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerOutput, ProposalView } from "@multiagency/sdk";
import { createBallast, createEngineState, createPriceHistory, type BallastSettings, type DecisionEntry } from "../src/ballast.ts";
import { chainedFileAudit, verifyChain } from "../src/chain.ts";
import { replayAuditLog } from "../../../packages/core/src/index.ts";
import type { ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createHolds, createRequests } from "../src/requests.ts";
import { createStrategyProposals, memoryProposalRecords } from "../src/strategy-proposals.ts";
import { loadWatchConfig } from "../src/watch-config.ts";
import { createWatch, type WatchedAgent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const ORG = "owner--near", AGENT = "portfolio";
const WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near", USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
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
    target: { [USDC]: 0.85, [WNEAR]: 0.15 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null, ...change,
  } as unknown as OwnerOutput<"overview">;
}

async function world({ seeded = true, seedEth = false, failAudit = false, max, proposals = false, settings = SETTINGS,
  overviewValue }: { seeded?: boolean; seedEth?: boolean; failAudit?: boolean; max?: number; proposals?: boolean; settings?: BallastSettings; overviewValue?: OwnerOutput<"overview"> } = {}) {
  const dir = tempDir("treasury-ballast-");
  const clock = { now: T0 };
  const requests = await createRequests(join(dir, "requests.json"), max === undefined ? {} : { max });
  const history = await createPriceHistory(join(dir, "requests.json.history"));
  const states = await createEngineState(join(dir, "requests.json.engine"));
  if (seeded) await history.seed(WNEAR, fallingHistory(T0), T0);
  if (seedEth) await history.seed(ETH, fallingHistory(T0), T0);
  const answers: { overview: OwnerOutput<"overview">; refuse?: string; create?: ProposalAnswer; consented?: boolean } = { overview: overviewValue ?? overview(3.12, T0) };
  const stored = new Map<string, ProposalView>();
  const sent: unknown[] = [];
  const platform: WatchPlatform = {
    overview: async () => ({ ok: true, value: answers.overview }),
    unresolved: async () => ({ ok: true, value: [] }) as Awaited<ReturnType<WatchPlatform["unresolved"]>>,
    autopilot: async () => ({ ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } }) as Awaited<ReturnType<WatchPlatform["autopilot"]>>,
    strategy: async () => ({ ok: true, value: { strategy: { targetBps: { [USDC]: 8_500, [WNEAR]: 1_500, [ETH]: 0 }, minLegUsd: 1, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 0 } },
      digest: `sha256:${"c".repeat(64)}` } }) as unknown as Awaited<ReturnType<WatchPlatform["strategy"]>>,
    list: async () => ({ ok: true, value: { proposals: [...stored.values()] } }),
    get: async (_o, _a, id) => {
      const found = [...stored.values()].find(view => view.id === id);
      return found ? { ok: true, value: found } : ({ ok: false, kind: "refused", status: 404, code: "not_found", error: "not_found" } as unknown as ProposalAnswer);
    },
    create: async (_o, _a, input) => {
      sent.push(input);
      if (answers.create) return answers.create;
      if (answers.refuse) return { ok: false, kind: "refused", status: 409, code: answers.refuse, error: answers.refuse } as unknown as ProposalAnswer;
      const view = stored.get(input.requestId) ?? proposal({ id: String(stored.size).padStart(32, "0"), requestId: input.requestId, expiresAt: input.expiresAt, state: "proposed" });
      stored.set(input.requestId, view);
      return { ok: true, value: view };
    },
    identity: async agent => ({ answer: { ok: true, value: { agent, owner: "owner.near", agentId: "id-portfolio", created: true, host: "platform.test", deployment: "treasury" } }, cached: false }),
    consents: async () => ({ ok: true, value: { consents: answers.consented ? [{ agent: AGENT, owner: "owner.near", agentId: "id-portfolio", scopes: ["read", "treasury"],
      revoked: false, expiresAt: clock.now + DAY }] : [] } }) as unknown as Awaited<ReturnType<WatchPlatform["consents"]>>,
  };
  // The server's own audit store, so every record passes its checks (canonical JSON, no secret-shaped fields).
  const audit = chainedFileAudit<DecisionEntry>(join(dir, "audit.jsonl"), () => clock.now,
    failAudit ? async () => { throw new Error("disk full"); } : undefined);
  await audit.check();
  const ballast = createBallast({ history, states, audit, now: () => clock.now });
  const holds = await createHolds(join(dir, "requests.json.holds"));
  const strategyProposals = proposals ? createStrategyProposals(memoryProposalRecords(), { audit: { append: async () => {} }, now: () => clock.now }) : undefined;
  const start = () => createWatch({ platform, requests, holds, publicOrigin: "https://treasury.test", now: () => clock.now, ballast, ...(strategyProposals && { strategyProposals }) });
  let watch = start();
  return { dir, clock, answers, stored, sent, history, states, requests, audit, strategyProposals, log: () => readFile(audit.file, "utf8"), tick: (agent = WATCHED) => watch.tick(agent), settings,
    /** A restart: a new watch, with nothing in memory, over the same files. */
    restart: () => { watch = start(); } };
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
  assert.match(String(event.reason), /already proposed in dca-1: dca-1 waits to re-arm/);
  assert.equal(w.requests.of(ORG, AGENT).length, 0, "the ended request is dropped");
});

test("a rejected buy traded nothing, but its zone still waits to re-arm, and the hold says it was proposed in (#208)", async () => {
  const w = await world();
  await w.tick();
  const [requestId, view] = [...w.stored][0]!;
  w.stored.set(requestId, { ...view, state: "rejected" });
  w.clock.now += 30 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
  const event = await w.tick();
  assert.equal(w.states.find(ORG, AGENT).dcaUnitsUsed, 0);
  assert.equal(event.skipped, "ballast holds");
  assert.equal(event.reason, "a trade was already proposed in dca-1: dca-1 waits to re-arm");
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

test("an invalidated proposal is undone: nobody decided on it, so Ballast decides again under what changed and proposes anew (#217)", async () => {
  const w = await world();
  await w.tick();
  const [requestId, view] = [...w.stored][0]!;
  w.stored.set(requestId, { ...view, state: "invalidated", reason: "the owner's strategy changed" });
  w.clock.now += 30 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  assert.equal(w.sent.length, 2, "proposed again, in the zone the invalidated one was in");
  const state = w.states.find(ORG, AGENT);
  assert.equal(state.dcaUnitsUsed, 0);
  assert.equal(state.proposed.length, 1, "the invalidated one no longer counts");
  assert.notEqual(state.proposed[0]!.requestId, requestId);
});

test("a create the platform refuses stored nothing, so its proposal is undone: the zone armed again, nothing counted (#190)", async () => {
  for (const code of ["not_proposable", "nothing_to_propose", "too_many_proposals"]) {
    const w = await world();
    w.answers.refuse = code;
    await w.tick();
    assert.equal(w.sent.length, 1, code);
    assert.equal(w.requests.of(ORG, AGENT).length, 0, `${code}: the request is dropped`);
    const state = w.states.find(ORG, AGENT);
    assert.deepEqual(state.proposed, [], `${code}: no proposal counted`);
    assert.deepEqual(state.whipsaw, {}, `${code}: the zone is armed, as before the decision`);
  }
});

/** Moves the clock past watch's backoff (6 ticks of 5 minutes), with the overview read anew. */
function pastBackoff(w: Awaited<ReturnType<typeof world>>) {
  w.clock.now += 31 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
}

test("after a not_proposable and the backoff, Ballast proposes again: an agent without a grant recovers once it has one (#190)", async () => {
  const w = await world();
  w.answers.refuse = "not_proposable";
  await w.tick();
  delete w.answers.refuse;
  pastBackoff(w);
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
  assert.equal(w.sent.length, 2);
});

test("after a forbidden with the owner's consent live, and the backoff, Ballast proposes again (#190)", async () => {
  const w = await world();
  w.answers.consented = true;
  w.answers.create = { ok: false, kind: "forbidden", status: 403, error: "Access ended before forwarding" } as unknown as ProposalAnswer;
  const held = await w.tick();
  assert.equal(held.held, "forbidden with a live consent", JSON.stringify(held));
  assert.deepEqual(w.states.find(ORG, AGENT).whipsaw, {}, "the zone is armed again");
  delete w.answers.create;
  pastBackoff(w);
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
});

test("after a plain gateway 4xx stops the agent, a restart lets Ballast propose again (#190)", async () => {
  const w = await world();
  w.answers.create = { ok: false, kind: "unknown", httpStatus: 400, error: "Bad Request" } as unknown as ProposalAnswer;
  const stopped = await w.tick();
  assert.match(String(stopped.stopped), /refused by the gateway \(400\)/);
  assert.deepEqual(w.states.find(ORG, AGENT).whipsaw, {}, "the zone is armed again");
  delete w.answers.create;
  w.restart();
  w.clock.now += 5 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
  const event = await w.tick();
  assert.ok("proposed" in event, JSON.stringify(event));
});

test("a withdrawn proposal was made, under a consent since replaced, so it stays counted and its zone disarmed", async () => {
  const w = await world();
  w.answers.refuse = "withdrawn";
  await w.tick();
  const state = w.states.find(ORG, AGENT);
  assert.equal(state.proposed.length, 1);
  assert.equal(state.whipsaw.disarmed, "dca-1");
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

test("every decision is recorded with its inputs before it's acted on, and the log replays to the same decisions (#54)", async () => {
  const w = await world();
  const proposed = await w.tick();
  assert.ok("proposed" in proposed, JSON.stringify(proposed));
  const log = await w.log();
  assert.equal(verifyChain(log).ok, true);
  const entries = log.trim().split("\n").map(line => (JSON.parse(line) as { entry: DecisionEntry }).entry);
  assert.deepEqual(entries.map(e => [e.kind, e.organization, e.agent, e.intent.action]), [["decision", ORG, AGENT, "buy-volatile"]]);
  // The record is the proposal that was sent: its legs, and the policy's result that let it through.
  const proposal = entries[0]!.proposal;
  assert.deepEqual(proposal?.sizeUsd != null && proposal.legs, { ok: true, legs: (w.sent[0] as { legs: unknown }).legs });
  assert.notEqual(entries[0]!.policy?.result.ok, false);
  assert.deepEqual(replayAuditLog(log), { ok: true, count: 1 });
});

const entriesOf = async (w: Awaited<ReturnType<typeof world>>) =>
  (await w.log()).trim().split("\n").map(line => (JSON.parse(line) as { entry: DecisionEntry }).entry);

test("a proposing decision's record names the request it became: the one stored and sent (#172)", async () => {
  const w = await world();
  assert.ok("proposed" in await w.tick());
  const [entry] = await entriesOf(w);
  const { requestId } = w.sent[0] as { requestId: string };
  assert.equal(entry!.requestId, requestId);
  assert.deepEqual(w.states.find(ORG, AGENT).proposed.map(p => p.requestId), [requestId]);
});

test("with the stored requests full, the decision is recorded with its requestId and no request under it is stored or sent (#172)", async () => {
  const w = await world({ max: 0 });
  assert.equal((await w.tick()).held, "stored requests full");
  const [entry] = await entriesOf(w);
  assert.equal(entry!.intent.action, "buy-volatile");
  assert.match(String(entry!.requestId), /^portfolio_[0-9a-f]{24}$/);
  assert.deepEqual(w.requests.of(ORG, AGENT), []);
  assert.equal(w.sent.length, 0);
});

test("a hold is a decision too: recorded with its frozen reading, and it replays (#54)", async () => {
  const w = await world({ seeded: false });
  const held = await w.tick();
  assert.equal((held as { skipped?: string }).skipped, "ballast holds", JSON.stringify(held));
  const log = await w.log();
  const [entry] = log.trim().split("\n").map(line => (JSON.parse(line) as { entry: DecisionEntry }).entry);
  assert.deepEqual([entry!.intent.action, entry!.reading.frozen, entry!.policy, entry!.proposal], ["hold", true, undefined, undefined]);
  assert.equal("requestId" in entry!, false, "a hold becomes no request (#172)");
  assert.deepEqual(replayAuditLog(log), { ok: true, count: 1 });
});

test("a changed input in the recorded log is named by the replay at its sequence number (#54)", async () => {
  const w = await world();
  await w.tick();
  const lines = (await w.log()).trim().split("\n");
  const record = JSON.parse(lines[0]!) as { seq: number; entry: DecisionEntry };
  record.entry.input.portfolio.reserveUsd /= 2; // the DCA unit is sized from the reserve
  const result = replayAuditLog(JSON.stringify(record));
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && [result.seq, result.part], [1, "intent"]);
});

test("a decision that can't be recorded is never proposed: the tick fails and nothing is sent (#54)", async () => {
  const w = await world({ failAudit: true });
  await assert.rejects(w.tick(), /disk full/);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.states.find(ORG, AGENT).proposed, []);
});

test("the mandate proposer runs on Ballast's tick beside its decision: one strategy proposed, the tick's trade unchanged (#206)", async () => {
  const w = await world({ proposals: true });
  const event = await w.tick();
  assert.ok("proposed" in event, "the DCA buy is still proposed");
  const [open] = w.strategyProposals!.open(AGENT);
  assert.deepEqual(event.strategy, { proposed: open!.id });
  assert.deepEqual([open!.source, open!.strategy.targetBps, open!.against], ["mandate", { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, `sha256:${"c".repeat(64)}`]);
  // Once the trade has ended and the tick reads the agent again, its strategy proposal is still open: no second one.
  const [requestId, view] = [...w.stored][0]!;
  w.stored.set(requestId, { ...view, state: "rejected" });
  w.clock.now += 30 * 60_000;
  w.answers.overview = overview(3.12, w.clock.now);
  assert.deepEqual((await w.tick()).strategy, { skipped: "open", id: open!.id });
  assert.equal(w.strategyProposals!.open(AGENT).length, 1);
});

// The multi-sleeve book (#221): wNEAR and ETH at 20% each in the balanced profile, the account at 50% and the Ethereum
// bridge at 25%. The book is 15,000 each and 70,000 USDC, so the 12,000 USD floor leaves a 58,000 reserve split by target.
const DIVERSIFIED: BallastSettings = { ...SETTINGS, diversification: {
  sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
  venueCapsPct: { "near-intents": 50, "omft-ethereum": 25 },
} };
const WATCHED_DIVERSIFIED: WatchedAgent = { ...WATCHED, ballast: DIVERSIFIED };
/** A steady wNEAR price and a falling ETH price, so the ETH sleeve buys and wNEAR holds: one target, one no trade. */
function diversifiedOverview(now: number): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, price: number, usd: number) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price, priceUpdatedAt: new Date(now - 60_000).toISOString(), priceExpiresAt: new Date(now + 240_000).toISOString(), usd });
  return {
    agentId: "id-portfolio",
    book: [row(USDC, "USDC", 6, 1, 70_000), row(WNEAR, "wNEAR", 24, 4, 15_000), row(ETH, "ETH", 18, 3.12, 15_000)],
    unmanaged: [], target: { [WNEAR]: 0.2, [ETH]: 0.2 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null,
  } as unknown as OwnerOutput<"overview">;
}
function steadyHistory(now: number, price: number) {
  const out: { at: number; price: number }[] = [];
  for (let at = now - 36 * DAY; at < now; at += HOUR) out.push({ at, price });
  return out;
}

test("a diversified agent proposes one ETH sleeve buy, with its own state and a decision record carrying the book check", async () => {
  const w = await world({ seedEth: true, settings: DIVERSIFIED, overviewValue: diversifiedOverview(T0) });
  // wNEAR's own history is steady, so its sleeve holds; ETH's falls, so its DCA buys and the sell-first order doesn't matter.
  await w.history.seed(WNEAR, steadyHistory(T0, 4), T0);
  const event = await w.tick(WATCHED_DIVERSIFIED);
  assert.ok("proposed" in event, JSON.stringify(event));
  const input = w.sent[0] as { legs: { from: string; to: string; amount: string }[]; note: string; requestId: string };
  assert.deepEqual([input.legs[0]!.from, input.legs[0]!.to], [USDC, ETH]);
  // One DCA unit: 20% of ETH's half of the 58,000 reserve over 10 units = 580 USD, in USDC's 6 decimals.
  assert.equal(input.legs[0]!.amount, "580000000");
  assert.match(input.note, /^Ballast dca-1: buy 580\.00 USD of ETH/);
  const state = w.states.find(ORG, AGENT);
  assert.equal(state.sleeves?.ETH?.whipsaw.disarmed, "dca-1", "the ETH sleeve is disarmed");
  assert.equal(state.sleeves?.wNEAR, undefined, "the wNEAR sleeve is untouched");
  assert.deepEqual(state.whipsaw, {}, "the two-asset state isn't used by the multi-sleeve book");
  assert.deepEqual(state.proposed.map(p => [p.requestId, p.asset]), [[input.requestId, "ETH"]]);
  const decided = JSON.parse((await w.log()).trim().split("\n").find(line => line.includes('"kind":"decision"'))!);
  assert.equal(decided.entry.requestId, input.requestId);
  assert.equal(decided.entry.policy?.book?.limits?.venueCapsPct["omft-ethereum"], 25);
  assert.ok(decided.entry.policy?.book?.ctx?.venueUsd?.["omft-ethereum"] >= 15_000, "the book check counted ETH at its bridge");
  assert.deepEqual(replayAuditLog(await w.log()), { ok: true, count: 1 });
});

test("the Ethereum bridge's cap refuses the ETH buy before anything is stored: a decision says why, and no request is sent", async () => {
  const capped: BallastSettings = { ...DIVERSIFIED, diversification: { ...DIVERSIFIED.diversification!, venueCapsPct: { "near-intents": 50, "omft-ethereum": 14 } } };
  const w = await world({ seedEth: true, settings: capped, overviewValue: diversifiedOverview(T0) });
  await w.history.seed(WNEAR, steadyHistory(T0, 4), T0);
  const event = await w.tick({ ...WATCHED_DIVERSIFIED, ballast: capped });
  assert.equal(event.skipped, "policy refused", JSON.stringify(event));
  assert.equal(event.rule, "VENUE_EXPOSURE");
  assert.match(String(event.reason), /Ethereum bridge/);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.states.find(ORG, AGENT).proposed, []);
  const decided = JSON.parse((await w.log()).trim().split("\n").find(line => line.includes('"kind":"decision"'))!);
  assert.equal(decided.entry.policy?.result?.rule, "VENUE_EXPOSURE");
  assert.equal(decided.entry.proposal, undefined);
});

test("a sleeve the book check refuses doesn't stop the next: ETH's buy is over its bridge's cap, so wNEAR's buy is proposed", async () => {
  // ETH first in the sleeves' order, its bridge capped below its holding; both prices have fallen, so both sleeves buy.
  const capped: BallastSettings = { ...SETTINGS, diversification: {
    sleeves: [{ asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }],
    venueCapsPct: { "near-intents": 50, "omft-ethereum": 14 },
  } };
  const both = diversifiedOverview(T0);
  both.book[1] = { ...both.book[1]!, price: 3.12 };
  const w = await world({ seedEth: true, settings: capped, overviewValue: both });
  const event = await w.tick({ ...WATCHED_DIVERSIFIED, ballast: capped });
  assert.ok("proposed" in event, JSON.stringify(event));
  const input = w.sent[0] as { legs: { from: string; to: string }[]; note: string };
  assert.deepEqual([input.legs[0]!.from, input.legs[0]!.to], [USDC, WNEAR]);
  assert.match(input.note, /USD of wNEAR/);
  // Both sleeves' decisions are recorded: ETH's refusal, then wNEAR's proposal, so the log explains the tick.
  const decisions = (await w.log()).trim().split("\n").map(line => JSON.parse(line)).filter(line => line.entry.kind === "decision");
  assert.deepEqual(decisions.map(d => [d.entry.policy?.result?.rule ?? null, Boolean(d.entry.requestId)]), [["VENUE_EXPOSURE", false], [null, true]]);
  assert.deepEqual(replayAuditLog(await w.log()), { ok: true, count: 2 });
});

test("a holding sleeve re-arms at its own bands, as the replay does, not the engine's defaults", async () => {
  // ETH's DCA-1 line is at -10% (the default is -20%), and DCA-1 is disarmed. At 15% under its average, ETH hasn't come
  // back inside its own line, so DCA-1 stays disarmed; at the default line it would have re-armed.
  const banded: BallastSettings = { ...DIVERSIFIED, diversification: { ...DIVERSIFIED.diversification!,
    sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25, bands: { trim: [20, 30, 45], dca: [-10, -30, -40], buyHalt: -50 } }] } };
  const dipped = diversifiedOverview(T0);
  dipped.book[2] = { ...dipped.book[2]!, price: 3.4 };
  const w = await world({ seeded: false, settings: banded, overviewValue: dipped });
  await w.history.seed(WNEAR, steadyHistory(T0, 4), T0);
  // Steady at 4, then 3.4 for the last six hours: its recent average sits about 15% under its 30-day one.
  await w.history.seed(ETH, steadyHistory(T0, 4).map(s => s.at >= T0 - 6 * HOUR ? { ...s, price: 3.4 } : s), T0);
  const disarmed = { lastActionAt: T0 - 3 * DAY, lastAction: "buy-volatile" as const, disarmed: "dca-1" as const };
  await w.states.change(ORG, AGENT, s => ({ ...s, sleeves: { ETH: { dcaUnitsUsed: 1, whipsaw: disarmed } } }));
  const event = await w.tick({ ...WATCHED_DIVERSIFIED, ballast: banded });
  assert.equal(event.skipped, "ballast holds", JSON.stringify(event));
  assert.deepEqual(w.states.find(ORG, AGENT).sleeves?.ETH?.whipsaw, disarmed, "still disarmed at its own -10% line");
});

test("a stablecoin the mandate didn't split into holds the tick, so the floor isn't counted from an unapproved coin", async () => {
  const overview = diversifiedOverview(T0);
  overview.book.push({ asset: "nep141:usdt.tether-token.near", symbol: "USDT", decimals: 6, public: 0n, confidential: 0n, price: 1,
    priceUpdatedAt: new Date(T0 - 60_000).toISOString(), priceExpiresAt: new Date(T0 + 240_000).toISOString(), usd: 0 });
  const w = await world({ seedEth: true, settings: DIVERSIFIED, overviewValue: overview });
  const event = await w.tick(WATCHED_DIVERSIFIED);
  assert.equal(event.skipped, "the book holds a stablecoin outside the mandate's split");
  assert.deepEqual(event.assets, ["USDT"]);
  assert.equal(w.sent.length, 0);
});

test("assessment-only records replayable risk without decisions or proposal request IDs", async () => {
  const w = await world();
  const engine = createBallast({ history: w.history, states: w.states, audit: w.audit, now: () => T0 });
  const result = await engine.decide(ORG, AGENT, SETTINGS, w.answers.overview, 1, {}, false, true);
  assert.equal("skipped" in result && result.skipped, "assessment only");
  const records = (await w.log()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.ok(!("requestId" in records[0].entry));
  assert.equal(records[0].entry.kind, "risk");
  assert.equal(replayAuditLog(await w.log()).ok, true);
  assert.deepEqual(w.states.find(ORG, AGENT).proposed, []);
  assert.deepEqual(w.sent, []);
});

test("assessment-only fails closed when the canonical audit append fails", async () => {
  const w = await world({ failAudit: true });
  const engine = createBallast({ history: w.history, states: w.states, audit: w.audit, now: () => T0 });
  await assert.rejects(engine.decide(ORG, AGENT, SETTINGS, w.answers.overview, 1, {}, false, true), /disk full/);
  assert.deepEqual(w.sent, []);
});


test("assessment-only with missing history records an explicit unusable projection", async () => {
  const w = await world({ seeded: false });
  const engine = createBallast({ history: w.history, states: w.states, audit: w.audit, now: () => T0 });
  await engine.decide(ORG, AGENT, SETTINGS, w.answers.overview, 1, {}, false, true);
  const record = JSON.parse((await w.log()).trim());
  assert.equal(record.entry.assessment.projection.usable, false);
  assert.ok(record.entry.assessment.projection.reasons.length > 0);
  assert.deepEqual(w.sent, []);
});
