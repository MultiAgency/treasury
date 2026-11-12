import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerFailure, OwnerOutput, ProposalView } from "@multiagency/sdk";
import type { ConsentRecord, ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createHolds, createRequests } from "../src/requests.ts";
import { createWatch, drift, runWatch, WATCH, type WatchedAgent, type WatchEvent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const ORG = "owner--near", AGENT = "portfolio", USDC = "nep141:usdc", WNEAR = "nep141:wrap.near";
const WATCHED: WatchedAgent = { organization: ORG, agent: AGENT, driftPoints: 5, intervalS: 300, proposalHours: 24 };
const T0 = Date.parse("2026-11-05T12:00:00.000Z");

/** A book worth $100, `usdcUsd` of it in USDC and the rest in wNEAR, against 50/50 targets. */
function overview(usdcUsd: number, change: Partial<OwnerOutput<"overview">> = {}): OwnerOutput<"overview"> {
  const holding = (asset: string, symbol: string, usd: number | null) => ({ asset, symbol, decimals: 6, public: 0n, confidential: 0n, price: 1, priceUpdatedAt: null, priceExpiresAt: null, usd });
  return {
    agentId: "id-portfolio", book: [holding(USDC, "USDC", usdcUsd), holding(WNEAR, "wNEAR", 100 - usdcUsd)], unmanaged: [],
    target: { [USDC]: 0.5, [WNEAR]: 0.5 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, notInForce: null, ...change,
  } as unknown as OwnerOutput<"overview">;
}
const consent = (change: Partial<ConsentRecord> = {}) => ({
  id: "c".repeat(64), host: "platform.test", deployment: "treasury", organization: ORG, owner: "owner.near", agent: AGENT, agentId: "id-portfolio",
  scopes: ["read", "treasury"], expiresAt: T0 + 86_400_000, createdAt: 0, publicKey: "ed25519:x", revoked: false, revokedAt: null, ...change,
}) as unknown as ConsentRecord;
const failure = (kind: OwnerFailure["kind"], extra: Record<string, unknown> = {}) => ({ ok: false, kind, error: kind, ...extra }) as unknown as OwnerFailure;
const refused = (code: string) => ({ ok: false, kind: "refused", status: 409, code, error: code }) as unknown as ProposalAnswer;

/** The platform as `watch` sees it, for one agent: answers set per test, and every call recorded. */
async function world({ max }: { max?: number } = {}) {
  const dir = tempDir("treasury-watch-");
  const requestsFile = join(dir, "requests.json"), holdsFile = join(dir, "requests.json.holds");
  let requests = await createRequests(requestsFile, max === undefined ? {} : { max });
  let holds = await createHolds(holdsFile);
  const clock = { now: T0 };
  const calls: string[] = [];
  const answers = {
    overview: { ok: true, value: overview(80) } as Awaited<ReturnType<WatchPlatform["overview"]>>,
    unresolved: { ok: true, value: [] } as Awaited<ReturnType<WatchPlatform["unresolved"]>>,
    autopilot: { ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as Awaited<ReturnType<WatchPlatform["autopilot"]>>,
    consents: [consent()] as ConsentRecord[],
    /** When set, the consents read fails with it. */
    consentsFailure: undefined as OwnerFailure | undefined,
    /** Answers the next creates give, in order; then each stores a proposal under its requestId and answers it. */
    create: [] as ProposalAnswer[],
  };
  /** Proposals as the platform keeps them, by requestId: a resend answers the stored one. */
  const stored = new Map<string, ProposalView>();
  const sent: unknown[] = [];
  /** What the request store held when each create was sent. */
  const heldAtCreate: number[] = [];
  const platform: WatchPlatform = {
    overview: async () => { calls.push("overview"); return answers.overview; },
    unresolved: async () => { calls.push("unresolved"); return answers.unresolved; },
    autopilot: async () => { calls.push("autopilot/get"); return answers.autopilot; },
    strategy: async () => { calls.push("strategy/get"); return { ok: false, kind: "unavailable" } as Awaited<ReturnType<WatchPlatform["strategy"]>>; },
    list: async () => { calls.push("proposals/list"); return { ok: true, value: { proposals: [...stored.values()] } }; },
    get: async (_o, _a, id) => {
      calls.push("proposals/get");
      const found = [...stored.values()].find(view => view.id === id);
      return found ? { ok: true, value: found } : refused("not_found");
    },
    create: async (_o, _a, input) => {
      calls.push("proposals/create");
      sent.push(input);
      heldAtCreate.push(requests.of(ORG, AGENT).length);
      const queued = answers.create.shift();
      if (queued) return queued;
      const view = stored.get(input.requestId) ?? proposal({ id: String(stored.size).padStart(32, "0"), requestId: input.requestId, expiresAt: input.expiresAt, state: "proposed" });
      stored.set(input.requestId, view);
      return { ok: true, value: view };
    },
    identity: async agent => { calls.push("identity"); return { answer: { ok: true, value: { agent, owner: "owner.near", agentId: "id-portfolio", created: true, host: "platform.test", deployment: "treasury" } }, cached: false }; },
    consents: async () => { calls.push("consents"); return (answers.consentsFailure ?? { ok: true, value: { consents: answers.consents } }) as Awaited<ReturnType<WatchPlatform["consents"]>>; },
  };
  const notified: unknown[] = [];
  const notifyAnswers: ({ ok: true } | { ok: false; error: string })[] = [];
  const build = () => createWatch({ platform, requests, holds, publicOrigin: "https://treasury.test", now: () => clock.now });
  let watch = build();
  const tick = (agent: WatchedAgent = WATCHED) => { calls.length = 0; return watch.tick(agent); };
  /** A restart: the server reads its stored requests and holds from their files again, and the watch starts afresh. */
  const restart = async () => {
    requests = await createRequests(requestsFile, max === undefined ? {} : { max });
    holds = await createHolds(holdsFile);
    watch = build();
  };
  const notify = async (payload: unknown) => { notified.push(payload); return notifyAnswers.shift() ?? { ok: true as const }; };
  return { get requests() { return requests; }, get holds() { return holds; }, restart, clock, calls, answers, stored, sent, heldAtCreate, tick, notify, notified, notifyAnswers };
}

test("the drift rule: the largest gap in points of the total, and the first leg a rebalance toward the targets moves", () => {
  assert.deepEqual(drift(overview(80), 5), { points: 30, firstLegUsd: 30 });
  assert.deepEqual(drift(overview(53), 5), { skipped: "drift below threshold", points: 3, driftPoints: 5 });
  assert.deepEqual(drift(overview(80, { rebalance: { minLegUsd: 40, maxCostBps: 50 } } as never), 5), { skipped: "first leg below minLegUsd", firstLegUsd: 30, minLegUsd: 40 });
  const unpriced = overview(80);
  unpriced.book[1]!.usd = null;
  assert.deepEqual(drift(unpriced, 5), { skipped: "unpriced", assets: [WNEAR] });
  assert.deepEqual(drift(overview(0, { book: [] } as never), 5), { skipped: "empty" });
});

test("the first leg is the smaller of the largest surplus and the largest deficit: on an uneven book they differ", () => {
  // $70 USDC, $20 wNEAR and $10 ETH against 50/25/25: gaps +20, -5 and -15, so the first leg moves min(20, 15) = $15.
  const ETH = "nep141:eth.omft.near";
  const row = (asset: string, usd: number) => ({ asset, symbol: asset, decimals: 6, public: 0n, confidential: 0n, price: 1, priceUpdatedAt: null, priceExpiresAt: null, usd });
  const uneven = (minLegUsd: number) => overview(70, { book: [row(USDC, 70), row(WNEAR, 20), row(ETH, 10)], target: { [USDC]: 0.5, [WNEAR]: 0.25, [ETH]: 0.25 },
    rebalance: { minLegUsd, maxCostBps: 50 } } as never);
  assert.deepEqual(drift(uneven(1), 5), { points: 20, firstLegUsd: 15 });
  assert.deepEqual(drift(uneven(16), 5), { skipped: "first leg below minLegUsd", firstLegUsd: 15, minLegUsd: 16 }, "not the $20 surplus");
});

test("past the threshold: the request is stored, then created with the strategy's legs, and its proposal recorded", async () => {
  const w = await world();
  const event = await w.tick();
  assert.deepEqual(w.calls, ["overview", "unresolved", "autopilot/get", "proposals/create"]);
  assert.deepEqual(w.heldAtCreate, [1], "on disk before it was sent");
  const [stored] = w.requests.of(ORG, AGENT);
  assert.deepEqual(w.sent, [{ requestId: stored!.requestId, legs: "strategy", expiresAt: "2026-11-06T12:00:00.000Z", note: "Drift 30.0 points from the targets" }]);
  assert.equal(stored!.proposalId, w.stored.get(stored!.requestId)!.id);
  assert.deepEqual(event, { organization: ORG, agent: AGENT, proposed: stored!.proposalId, requestId: stored!.requestId, expiresAt: "2026-11-06T12:00:00.000Z", points: 30 });
});

test("below the threshold, or nothing a rebalance could act on: no proposal", async () => {
  const w = await world();
  w.answers.overview = { ok: true, value: overview(53) };
  assert.equal((await w.tick()).skipped, "drift below threshold");
  assert.ok(!w.calls.includes("proposals/create"));
  assert.deepEqual(w.requests.of(ORG, AGENT), []);
});

test("held while operations are unresolved, while autopilot is on, or while the policy isn't in force", async () => {
  const w = await world();
  w.answers.unresolved = { ok: true, value: [{ key: "k", at: "x", kind: "swap", request: {}, status: null, sent: true }] } as never;
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, held: "unresolved", operations: 1 });
  w.answers.unresolved = { ok: true, value: [] };
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  assert.equal((await w.tick()).held, "autopilot");
  w.answers.autopilot = { ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  w.answers.overview = { ok: true, value: overview(80, { notInForce: "the policy isn't applied" } as never) };
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, held: "policy not in force", notInForce: "the policy isn't applied" });
  assert.equal(w.sent.length, 0);
});

test("a live proposal holds the agent: it's read alone, and none of the three reads is spent", async () => {
  const w = await world();
  const { proposed } = await w.tick();
  // `executing` and `unknown` hold too: claimed before its first swap is journaled, a proposal can read `executing`
  // while `unresolved` is still empty, and `unknown` is read later, never proposed over.
  for (const state of ["proposed", "approved", "executing", "unknown"] as const) {
    w.stored.forEach(view => { view.state = state; });
    assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, skipped: "live proposal", proposalId: proposed, state });
    assert.deepEqual(w.calls, ["proposals/get"]);
  }
});

test("a proposal that reached a final state is forgotten, and the agent may propose again in the same tick", async () => {
  for (const state of ["executed", "stopped", "rejected", "withdrawn", "expired", "invalidated"] as const) {
    const w = await world();
    const first = await w.tick();
    w.stored.forEach(view => { view.state = state; });
    const next = await w.tick();
    assert.deepEqual(w.calls, ["proposals/get", "overview", "unresolved", "autopilot/get", "proposals/create"], state);
    assert.notEqual(next.proposed, first.proposed, state);
    assert.deepEqual(w.requests.of(ORG, AGENT).map(record => record.proposalId), [next.proposed], state);
  }
});

test("a lost create answer: the same request is sent again, byte for byte, before anything else, and no new one is made", async () => {
  for (const lost of [failure("unknown"), failure("unavailable"), failure("busy")]) {
    const w = await world();
    w.answers.create.push(lost as ProposalAnswer);
    const first = await w.tick();
    assert.equal(first.failed, "proposals/create", lost.kind);
    assert.deepEqual(w.requests.of(ORG, AGENT).map(record => record.proposalId), [null], "kept, unanswered");
    w.clock.now += 300_000;
    const second = await w.tick();
    assert.deepEqual(w.calls, ["proposals/create"], "the resend comes first, and alone");
    assert.deepEqual(w.sent[1], w.sent[0], "identical input");
    assert.equal(second.proposed, w.requests.of(ORG, AGENT)[0]!.proposalId);
    assert.equal(w.requests.of(ORG, AGENT).length, 1);
  }
});

test("a resend of a request too close to its expiry is dropped, not sent: the platform would refuse it as expiry_invalid", async () => {
  const w = await world();
  w.answers.create.push(failure("unavailable") as ProposalAnswer);
  await w.tick();
  w.clock.now += 24 * 3_600_000 - 30_000;
  const event = await w.tick();
  assert.equal(w.sent.length, 2, "a fresh request, not the stale one");
  assert.notDeepEqual(w.sent[1], w.sent[0]);
  assert.ok(event.proposed);
});

test("not_proposable or nothing_to_propose: nothing was stored, so the request is dropped, and the agent backs off before quoting again", async () => {
  // nothing_to_propose: the strategy picks no leg worth its cost, which drift() can't see (`service.ts:110`).
  for (const code of ["not_proposable", "nothing_to_propose"]) {
  const w = await world();
  w.answers.create.push(refused(code));
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, skipped: "not proposable", error: code, backoffTicks: WATCH.backoffTicks });
  assert.deepEqual(w.requests.of(ORG, AGENT), []);
  for (let i = 1; i < WATCH.backoffTicks; i++) {
    w.clock.now += 300_000;
    assert.equal((await w.tick()).skipped, "backoff");
  }
  w.clock.now += 300_000;
  assert.ok((await w.tick()).proposed);
  }
});

test("rate-limited or a provider failure on a create: the request is kept, the agent backs off, then it's sent again unchanged", async () => {
  for (const answer of [failure("rate_limited", { status: 429, retryAfterSeconds: 60 }), failure("unknown", { httpStatus: 429 }), failure("provider")]) {
    const w = await world();
    w.answers.create.push(answer as ProposalAnswer);
    const first = await w.tick();
    assert.equal(first.backoffTicks, WATCH.backoffTicks, JSON.stringify(first));
    assert.deepEqual(w.requests.of(ORG, AGENT).map(record => record.proposalId), [null], answer.kind);
    for (let i = 1; i < WATCH.backoffTicks; i++) {
      w.clock.now += 300_000;
      assert.equal((await w.tick()).skipped, "backoff", answer.kind);
      assert.deepEqual(w.calls, [], "nothing sent during the backoff");
    }
    w.clock.now += 300_000;
    assert.ok((await w.tick()).proposed, answer.kind);
    assert.deepEqual(w.sent[1], w.sent[0], "the same request");
  }
});

test("a rate-limited read backs the agent off", async () => {
  for (const limited of [failure("rate_limited", { status: 429, retryAfterSeconds: 60 }), failure("unavailable", { httpStatus: 429 })]) {
    const w = await world();
    w.answers.overview = limited as never;
    assert.equal((await w.tick()).backoffTicks, WATCH.backoffTicks, limited.kind);
    w.answers.overview = { ok: true, value: overview(80) };
    w.clock.now += 300_000;
    assert.equal((await w.tick()).skipped, "backoff", limited.kind);
    assert.deepEqual(w.calls, [], "nothing read during the backoff");
  }
});

test("too_many_proposals: dropped, and held for the backoff", async () => {
  const w = await world();
  w.answers.create.push(refused("too_many_proposals"));
  assert.equal((await w.tick()).held, "too many proposals");
  assert.deepEqual(w.requests.of(ORG, AGENT), []);
  w.clock.now += 300_000;
  assert.equal((await w.tick()).skipped, "backoff");
});

test("request_conflict, expiry_invalid or a gateway's 4xx is a bug: dropped, and the agent stops until the server restarts", async () => {
  for (const answer of [refused("request_conflict"), refused("expiry_invalid"), failure("unknown", { httpStatus: 400 }) as ProposalAnswer]) {
    const w = await world();
    w.answers.create.push(answer);
    const event = await w.tick();
    assert.ok(event.stopped, JSON.stringify(event));
    assert.deepEqual(w.requests.of(ORG, AGENT), []);
    w.clock.now += 300_000;
    assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, skipped: "stopped", stopped: event.stopped });
    assert.deepEqual(w.calls, [], "it asks the platform nothing more");
  }
});

test("forbidden without a live consent: the agent stops, reads why, and resumes once the owner connects again", async () => {
  const w = await world();
  w.answers.overview = failure("forbidden") as never;
  w.answers.consents = [consent({ revoked: true } as never)];
  const event = await w.tick();
  assert.deepEqual(event, { organization: ORG, agent: AGENT, stopped: "not connected", note: "the owner's consent for this app has ended: they connect again in the app" });
  assert.ok(w.calls.includes("identity") && w.calls.includes("consents"));
  w.clock.now += 300_000;
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, skipped: "not connected" });
  assert.deepEqual(w.calls, ["identity", "consents"], "only the check that tells it to resume");
  w.answers.consents = [consent()];
  w.answers.overview = { ok: true, value: overview(80) };
  w.clock.now += 300_000;
  assert.ok((await w.tick()).proposed, "resumed");
});

test("forbidden with a live consent holds the agent for the backoff, then it reads again: a platform stopping answers so too", async () => {
  // "Access ended before forwarding" (`app-routes.ts:462-466`) comes while the platform stops, the consent still live.
  const w = await world();
  w.answers.overview = failure("forbidden") as never;
  const event = await w.tick();
  assert.equal(event.held, "forbidden with a live consent", JSON.stringify(event));
  assert.equal(event.backoffTicks, WATCH.backoffTicks);
  for (let i = 1; i < WATCH.backoffTicks; i++) {
    w.clock.now += 300_000;
    assert.equal((await w.tick()).skipped, "backoff");
    assert.deepEqual(w.calls, [], "the refused call isn't retried during the backoff");
  }
  w.answers.overview = { ok: true, value: overview(80) };
  w.clock.now += 300_000;
  assert.ok((await w.tick()).proposed, "read again after the backoff");
});

test("forbidden when the consents can't be read: the agent waits for a live consent, and isn't stopped for good", async () => {
  const w = await world();
  w.answers.overview = failure("forbidden") as never;
  w.answers.consentsFailure = failure("unavailable");
  assert.equal((await w.tick()).stopped, "not connected");
  w.answers.consentsFailure = undefined;
  w.answers.overview = { ok: true, value: overview(80) };
  w.clock.now += 300_000;
  assert.ok((await w.tick()).proposed, "resumed once the consents read answers");
});

test("withdrawn on a resend: made under a consent since replaced, so it's dropped and the agent proposes again, not stopped", async () => {
  // The platform answers withdrawn only through a live consent (`app-routes.ts:411-413`): the owner connected again
  // after a lost answer, and the proposal made under the old consent was withdrawn (`service.ts:52-58`).
  const w = await world();
  w.answers.create.push(failure("unavailable") as ProposalAnswer, refused("withdrawn"));
  await w.tick();
  w.clock.now += 300_000;
  const event = await w.tick();
  assert.equal(event.skipped, "withdrawn", JSON.stringify(event));
  assert.deepEqual(w.requests.of(ORG, AGENT), []);
  w.clock.now += 300_000;
  assert.ok((await w.tick()).proposed, "not stopped: it proposes again under the live consent");
});

test("a read that fails otherwise is reported, and nothing is proposed this tick", async () => {
  const w = await world();
  w.answers.unresolved = failure("unavailable") as never;
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, failed: ["unresolved"], kinds: ["unavailable"] });
  assert.equal(w.sent.length, 0);
});

test("when the stored requests are full, nothing is sent", async () => {
  const w = await world({ max: 0 });
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, held: "stored requests full" });
  assert.ok(!w.calls.includes("proposals/create"));
});

test("each proposal is notified once, with a link to its page in the app; a failed notifier is reported, not retried", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.notifyAnswers.push({ ok: false, error: "exited with 3: channel down" });
  const event = await w.tick(agent);
  const id = event.proposed as string;
  assert.deepEqual(w.notified, [{ kind: "proposed", organization: ORG, agent: AGENT, proposalId: id, expiresAt: "2026-11-06T12:00:00.000Z", secondsLeft: 86_400,
    points: 30, page: `https://treasury.test/agents/${AGENT}/proposals/${id}` }]);
  assert.deepEqual(event.notified, { ok: false, error: "exited with 3: channel down" });
  assert.equal(w.requests.of(ORG, AGENT)[0]!.proposalId, id, "recorded whatever the notifier did");
  w.clock.now += 300_000;
  await w.tick(agent);
  assert.equal(w.notified.length, 1);
});

test("a recovered proposal is notified too: the owner hears of it once its answer arrives", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.create.push(failure("unavailable") as ProposalAnswer);
  await w.tick(agent);
  assert.equal(w.notified.length, 0);
  w.clock.now += 300_000;
  await w.tick(agent);
  assert.equal(w.notified.length, 1);
});

/** A sleep that waits until the test lets it go, or until the signal ends it, as a stopped server's would. */
function sleeps() {
  const waiting: { ms: number; release: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const entry = { ms, release: resolve };
    waiting.push(entry);
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { sleep, waiting, settle };
}

test("the runner ticks each agent on its own interval and logs each tick's event", async () => {
  const { sleep, waiting, settle } = sleeps();
  const ticked: string[] = [];
  const watch = { tick: async (agent: WatchedAgent) => { ticked.push(agent.agent); return { organization: agent.organization, agent: agent.agent, skipped: "x" }; } };
  const logged: unknown[] = [];
  const stop = new AbortController();
  const done = runWatch({ watch, agents: [WATCHED, { ...WATCHED, agent: "savings", intervalS: 600 }], log: event => logged.push(event), sleep, signal: stop.signal });
  await settle();
  assert.deepEqual(ticked, ["portfolio", "savings"]);
  assert.deepEqual(waiting.map(entry => entry.ms), [300_000, 600_000]);
  waiting[0]!.release();
  await settle();
  assert.deepEqual(ticked, ["portfolio", "savings", "portfolio"]);
  assert.equal(logged.length, 3);
  stop.abort();
  await done;
});

test("on shutdown no tick starts, and a tick in flight finishes and is logged before the runner ends", async () => {
  const { sleep, settle } = sleeps();
  let finish!: () => void;
  const started: string[] = [];
  const watch = { tick: (agent: WatchedAgent) => { started.push(agent.agent); return new Promise<WatchEvent>(resolve => { finish = () => resolve({ organization: ORG, agent: agent.agent, proposed: "p" }); }); } };
  const logged: unknown[] = [];
  const stop = new AbortController();
  let ended = false;
  const done = runWatch({ watch, agents: [WATCHED], log: event => logged.push(event), sleep, signal: stop.signal }).then(() => { ended = true; });
  await settle();
  stop.abort();
  await settle();
  assert.equal(ended, false, "waits for the tick in flight");
  finish();
  await done;
  assert.deepEqual(logged, [{ organization: ORG, agent: AGENT, proposed: "p" }]);
  assert.deepEqual(started, ["portfolio"], "no tick after the stop");
});

test("a tick that throws is logged, without its stack, and the agent goes on at its next interval", async () => {
  const { sleep, waiting, settle } = sleeps();
  let calls = 0;
  const watch = { tick: async (agent: WatchedAgent) => { if (++calls === 1) throw new Error("EACCES: requests.json"); return { organization: agent.organization, agent: agent.agent, skipped: "x" }; } };
  const logged: unknown[] = [];
  const stop = new AbortController();
  const done = runWatch({ watch, agents: [WATCHED], log: event => logged.push(event), sleep, signal: stop.signal });
  await settle();
  assert.deepEqual(logged, [{ organization: ORG, agent: AGENT, failed: "tick", error: "EACCES: requests.json" }]);
  waiting[0]!.release();
  await settle();
  assert.equal(calls, 2);
  stop.abort();
  await done;
});

// --- notices beyond a new proposal (#131) ---

const MIN = 60_000;
/** The agent with a notifier, and the kinds it was sent, in order. */
const kinds = (w: Awaited<ReturnType<typeof world>>) => w.notified.map(payload => (payload as { kind: string }).kind);
/** Sets the proposal `watch` made to a state, with its creation fixed to the test clock so its life is known. */
const set = (w: Awaited<ReturnType<typeof world>>, change: Partial<ProposalView>) => w.stored.forEach(view => Object.assign(view, { createdAt: new Date(T0).toISOString() }, change));

test("holding: each reason is sent once when the hold starts, and not on the next tick", async () => {
  const cases: [string, (w: Awaited<ReturnType<typeof world>>) => void][] = [
    ["unresolved-operations", w => { w.answers.unresolved = { ok: true, value: [{ id: "op" }] } as never; }],
    ["autopilot-on", w => { w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never; }],
    ["policy-not-in-force", w => { w.answers.overview = { ok: true, value: overview(80, { notInForce: "expired" } as never) }; }],
    ["consent-ended", w => { w.answers.overview = failure("forbidden") as never; w.answers.consents = [consent({ revoked: true } as never)]; }],
  ];
  for (const [reason, hold] of cases) {
    const w = await world();
    const agent = { ...WATCHED, notify: w.notify };
    hold(w);
    const event = await w.tick(agent);
    assert.equal(w.notified.length, 1, reason);
    const { detail, ...rest } = w.notified[0] as { detail: string };
    assert.deepEqual(rest, { kind: "holding", organization: ORG, agent: AGENT, reason, page: `https://treasury.test/agents/${AGENT}` }, reason);
    assert.ok(typeof detail === "string" && detail.length > 20, "and says what the reason means");
    assert.deepEqual(event.notices, [{ kind: "holding", ok: true }], "and the tick's log line says it was sent");
    w.clock.now += 5 * MIN;
    await w.tick(agent);
    assert.equal(w.notified.length, 1, `${reason}: not again on the next tick`);
  }
});

test("resumed: when the hold ends, once; a changed reason is a new holding, not a resumed", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  await w.tick(agent);
  w.clock.now += 5 * MIN;
  w.answers.unresolved = { ok: true, value: [{ id: "op" }] } as never;
  await w.tick(agent);
  assert.deepEqual(w.notified.map(p => (p as { reason?: string }).reason), ["autopilot-on", "unresolved-operations"], "still held, for another reason");
  w.clock.now += 5 * MIN;
  w.answers.unresolved = { ok: true, value: [] };
  w.answers.autopilot = { ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["holding", "holding", "resumed", "proposed"], "the hold ends and, drift being past the threshold, it proposes in the same tick");
  assert.deepEqual(w.notified.filter(p => (p as { kind: string }).kind === "resumed"), [{ kind: "resumed", organization: ORG, agent: AGENT, page: `https://treasury.test/agents/${AGENT}` }]);
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.equal(kinds(w).filter(kind => kind === "resumed").length, 1, "once");
});

test("a hold that ends when the owner connects again sends resumed, then the proposal", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.overview = failure("forbidden") as never;
  w.answers.consents = [consent({ revoked: true } as never)];
  await w.tick(agent);
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["holding"], "still waiting: nothing more to say");
  w.answers.consents = [consent()];
  w.answers.overview = { ok: true, value: overview(80) };
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["holding", "resumed", "proposed"]);
});

test("a failed read neither starts nor ends a hold: it says nothing about why the agent is held", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  await w.tick(agent);
  w.answers.overview = failure("unavailable") as never;
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["holding"], "a failed read says nothing about the hold");
});

test("expiring: once, when a proposal of its own has under an hour left, or under 10% of its life if that is shorter", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  await w.tick(agent); // proposed, open 24 hours
  set(w, {});
  w.clock.now = T0 + 23 * 60 * MIN; // exactly an hour left
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed"], "an hour left is not under an hour");
  w.clock.now = T0 + 23 * 60 * MIN + 1;
  await w.tick(agent);
  assert.deepEqual(w.calls, ["proposals/get"], "read from the proposal the tick already reads: no extra platform call");
  const expiring = w.notified[1] as { kind: string; proposalId: string; expiresAt: string; page: string; organization: string; agent: string };
  assert.deepEqual(expiring, { kind: "expiring", organization: ORG, agent: AGENT, proposalId: [...w.stored.values()][0]!.id, expiresAt: "2026-11-06T12:00:00.000Z",
    page: `https://treasury.test/agents/${AGENT}/proposals/${[...w.stored.values()][0]!.id}` });
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "expiring"], "not again");

  // A one-hour proposal: 10% of its life is 6 minutes, shorter than an hour.
  const short = await world();
  const brief = { ...WATCHED, notify: short.notify, proposalHours: 1 };
  await short.tick(brief);
  set(short, {});
  short.clock.now = T0 + 53 * MIN; // 7 minutes left
  await short.tick(brief);
  assert.deepEqual(kinds(short), ["proposed"], "7 minutes is over 10% of an hour");
  short.clock.now = T0 + 55 * MIN; // 5 minutes left
  await short.tick(brief);
  assert.deepEqual(kinds(short), ["proposed", "expiring"]);
});

test("expired: told once, before the request is dropped, and the agent goes on to propose again", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  const first = await w.tick(agent);
  set(w, { state: "expired" });
  w.clock.now = T0 + 25 * 60 * MIN;
  const next = await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "expired", "proposed"]);
  const expired = w.notified[1] as { proposalId: string; expiresAt: string };
  assert.equal(expired.proposalId, first.proposed);
  assert.deepEqual(w.requests.of(ORG, AGENT).map(record => record.proposalId), [next.proposed], "and the request was dropped");
  assert.deepEqual(w.calls, ["proposals/get", "overview", "unresolved", "autopilot/get", "proposals/create"], "no read beyond the tick's own");
});

test("approved_not_executed: once, after an hour approved and not executed; not while it is executing", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  await w.tick(agent);
  set(w, { state: "approved", approvedAt: new Date(T0).toISOString() });
  w.clock.now = T0 + 59 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed"], "not yet an hour");
  w.clock.now = T0 + 60 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"], "an hour counts");
  w.clock.now = T0 + 90 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"], "not again");
  const other = await world();
  const watching = { ...WATCHED, notify: other.notify };
  await other.tick(watching);
  set(other, { state: "executing", approvedAt: new Date(T0).toISOString() });
  other.clock.now = T0 + 120 * MIN;
  await other.tick(watching);
  assert.deepEqual(kinds(other), ["proposed"], "an execution under way is not a stall");
});

test("a restart sends nothing already sent: holds and each proposal notice are recorded first", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  await w.tick(agent);
  assert.equal(w.holds.get(ORG, AGENT), "autopilot-on");
  await w.restart();
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["holding"], "the hold isn't announced again");

  const p = await world();
  const proposing = { ...WATCHED, notify: p.notify };
  await p.tick(proposing);
  set(p, {});
  p.clock.now = T0 + 23 * 60 * MIN + MIN;
  await p.tick(proposing);
  assert.deepEqual(p.requests.of(ORG, AGENT)[0]!.notified, ["expiring"], "recorded on the request");
  await p.restart();
  p.clock.now += 5 * MIN;
  await p.tick(proposing);
  assert.deepEqual(kinds(p), ["proposed", "expiring"]);
  // and the end of the hold after a restart is still told once
  w.answers.autopilot = { ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w).slice(0, 2), ["holding", "resumed"]);
  assert.equal(w.holds.get(ORG, AGENT), null);
});

test("a notice is recorded before it is sent: a failed notifier is reported, not retried", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  w.notifyAnswers.push({ ok: false, error: "exited with 3: channel down" });
  const event = await w.tick(agent);
  assert.deepEqual(event.notices, [{ kind: "holding", ok: false, error: "exited with 3: channel down" }]);
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.equal(w.notified.length, 1, "not retried");
});

test("an agent with no notifier sends and records nothing, and its hold is still logged", async () => {
  const w = await world();
  w.answers.autopilot = { ok: true, value: { on: true, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  assert.deepEqual(await w.tick(), { organization: ORG, agent: AGENT, held: "autopilot" });
  assert.equal(w.holds.get(ORG, AGENT), null, "no hold recorded");
  w.answers.autopilot = { ok: true, value: { on: false, everyMin: 60, maxUsd: 0, lastRun: null, nextRun: null } } as never;
  w.clock.now += 5 * MIN;
  await w.tick();
  set(w, { state: "expired" });
  w.clock.now += 25 * 60 * MIN;
  await w.tick();
  assert.deepEqual(w.notified, []);
  assert.deepEqual(w.requests.of(ORG, AGENT).flatMap(record => record.notified), []);
});

test("a proposal's notice is for watch's own proposals only: one it never made is not reported", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.stored.set("someone-else", proposal({ id: "e".repeat(32), requestId: "someone-else", state: "expired", expiresAt: new Date(T0 - 1000).toISOString() }));
  await w.tick(agent);
  assert.ok(!kinds(w).includes("expired"));
});

test("expired is sent for a proposal nobody answered and for one approved and never executed, carrying approvedAt (null when unanswered)", async () => {
  const unanswered = await world();
  const agent = { ...WATCHED, notify: unanswered.notify };
  const first = await unanswered.tick(agent);
  set(unanswered, { state: "expired" });
  unanswered.clock.now = T0 + 25 * 60 * MIN;
  await unanswered.tick(agent);
  const gone = unanswered.notified.find(p => (p as { kind: string }).kind === "expired");
  assert.deepEqual(gone, { kind: "expired", organization: ORG, agent: AGENT, proposalId: first.proposed, expiresAt: "2026-11-06T12:00:00.000Z", approvedAt: null,
    page: `https://treasury.test/agents/${AGENT}/proposals/${first.proposed}` });

  // The platform reads an approved, unexecuted proposal as `expired` once its expiry passes, `approvedAt` still set.
  const approved = await world();
  const watching = { ...WATCHED, notify: approved.notify };
  await approved.tick(watching);
  const approvedAt = new Date(T0 + 2 * 60 * MIN).toISOString();
  set(approved, { state: "expired", approvedAt });
  approved.clock.now = T0 + 25 * 60 * MIN;
  await approved.tick(watching);
  const lapsed = approved.notified.find(p => (p as { kind: string }).kind === "expired") as { approvedAt: string };
  assert.equal(lapsed.approvedAt, approvedAt, "told as expired, with when it was approved");
});

test("an approved proposal is reported at the hour, and again as expired when it lapses: each once", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  await w.tick(agent);
  const approvedAt = new Date(T0).toISOString();
  set(w, { state: "approved", approvedAt });
  w.clock.now = T0 + 90 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"]);
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"], "once");
  set(w, { state: "expired", approvedAt });
  w.clock.now = T0 + 25 * 60 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w).filter(kind => kind !== "proposed"), ["approved_not_executed", "expired"]);
});

test("expiring is for a proposal still awaiting the owner; an approved one is reported when it enters the window, if that is before the hour", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  await w.tick(agent);
  // Approved 30 minutes before it expires: under the window, long before an hour of waiting.
  const approvedAt = new Date(T0 + 23.5 * 60 * MIN).toISOString();
  set(w, { state: "approved", approvedAt });
  w.clock.now = T0 + 23.5 * 60 * MIN + 1;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"], "no `expiring` for an approved proposal");
  w.clock.now += 5 * MIN;
  await w.tick(agent);
  assert.deepEqual(kinds(w), ["proposed", "approved_not_executed"], "once");
  // Both the hour and the window: one report, not two.
  const both = await world();
  const watching = { ...WATCHED, notify: both.notify, proposalHours: 1 };
  await both.tick(watching);
  set(both, { state: "approved", approvedAt: new Date(T0 - 2 * 60 * MIN).toISOString() });
  both.clock.now = T0 + 55 * MIN;
  await both.tick(watching);
  assert.deepEqual(kinds(both), ["proposed", "approved_not_executed"]);
  // Still awaiting the owner: `expiring`, as before.
  const open = await world();
  const waiting = { ...WATCHED, notify: open.notify };
  await open.tick(waiting);
  set(open, {});
  open.clock.now = T0 + 23 * 60 * MIN + MIN;
  await open.tick(waiting);
  assert.deepEqual(kinds(open), ["proposed", "expiring"]);
});

test("the expiring window is at least one interval, so a tick always lands in it", async () => {
  // A 1-hour proposal's window is 6 minutes (10% of its life): a 10-minute interval widens it to 10.
  const slow = await world();
  const wide = { ...WATCHED, notify: slow.notify, proposalHours: 1, intervalS: 600 };
  await slow.tick(wide);
  set(slow, {});
  slow.clock.now = T0 + 51 * MIN; // 9 minutes left
  await slow.tick(wide);
  assert.deepEqual(kinds(slow), ["proposed", "expiring"], "inside the 10-minute window");
  const fast = await world();
  const narrow = { ...WATCHED, notify: fast.notify, proposalHours: 1, intervalS: 300 };
  await fast.tick(narrow);
  set(fast, {});
  fast.clock.now = T0 + 51 * MIN;
  await fast.tick(narrow);
  assert.deepEqual(kinds(fast), ["proposed"], "outside the 6-minute window of a 5-minute interval");
});

test("a proposal that is neither open nor expired raises nothing, whatever its dates", async () => {
  for (const state of ["executed", "rejected", "withdrawn", "invalidated", "stopped"] as const) {
    const w = await world();
    const agent = { ...WATCHED, notify: w.notify };
    await w.tick(agent);
    set(w, { state, approvedAt: new Date(T0).toISOString() });
    w.clock.now = T0 + 23 * 60 * MIN + 5 * MIN;
    await w.tick(agent);
    assert.ok(!kinds(w).some(kind => kind === "expiring" || kind === "expired" || kind === "approved_not_executed"), state);
  }
});

test("overlapping ticks create only one proposal and release the guard afterwards", async () => {
  const w = await world();
  const results = await Promise.all([w.tick(), w.tick()]);
  assert.equal(results.filter(result => result.skipped === "tick in progress").length, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(w.requests.of(ORG, AGENT).length, 1);
  assert.equal((await w.tick()).skipped, "live proposal");
});

// Simulate the server losing its local acknowledgement after the platform accepted a request.
test("crash test: accepted proposal survives a lost local acknowledgement and restart", async () => {
  const w = await world();
  await w.tick();
  const accepted = w.requests.of(ORG, AGENT)[0]!;
  const original = w.requests.input(accepted);
  await w.requests.drop(accepted);
  await w.requests.add(ORG, AGENT, JSON.parse(accepted.body), accepted.requestId);
  await w.restart();
  await w.tick();
  assert.deepEqual(w.sent, [original, original]);
  assert.equal(w.stored.size, 1);
  assert.equal(w.requests.of(ORG, AGENT)[0]!.proposalId, accepted.proposalId);
});

test("crash test: restart during uncertain execution holds without creating another proposal", async () => {
  for (const state of ["executing", "unknown"] as const) {
    const w = await world();
    await w.tick();
    const [key, view] = [...w.stored.entries()][0]!;
    w.stored.set(key, { ...view, state });
    await w.restart();
    const event = await w.tick();
    assert.equal(event.skipped, "live proposal");
    assert.equal(event.state, state);
    assert.equal(w.sent.length, 1);
    assert.equal(w.requests.of(ORG, AGENT).length, 1);
  }
});

test("overlap guard covers asynchronous notification and releases after a thrown notification", async () => {
  const w = await world();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const ticking = w.tick({ ...WATCHED, notify: async () => {
    entered();
    await gate;
    throw new Error("notification lost");
  } });
  const rejected = assert.rejects(ticking, /notification lost/);
  await started;
  assert.equal((await w.tick()).skipped, "tick in progress");
  finish();
  await rejected;
  assert.equal((await w.tick()).skipped, "live proposal");
  assert.equal(w.sent.length, 1);
});
