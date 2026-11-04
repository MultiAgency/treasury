import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { OwnerFailure, OwnerOutput, ProposalView } from "@multiagency/sdk";
import type { ConsentRecord, ProposalAnswer, WatchPlatform } from "../src/platform.ts";
import { createRequests } from "../src/requests.ts";
import { createWatch, drift, runWatch, WATCH, type WatchedAgent, type WatchEvent } from "../src/watch.ts";
import { proposal } from "./fakes.ts";

const dirs: string[] = [];
after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

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
  const dir = await mkdtemp(join(tmpdir(), "treasury-watch-")); dirs.push(dir);
  const requests = await createRequests(join(dir, "requests.json"), max === undefined ? {} : { max });
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
  const watch = createWatch({ platform, requests, publicOrigin: "https://treasury.test", now: () => clock.now });
  const tick = (agent: WatchedAgent = WATCHED) => { calls.length = 0; return watch.tick(agent); };
  const notify = async (payload: unknown) => { notified.push(payload); return notifyAnswers.shift() ?? { ok: true as const }; };
  return { requests, clock, calls, answers, stored, sent, heldAtCreate, tick, notify, notified, notifyAnswers };
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
  for (const answer of [failure("unknown", { httpStatus: 429 }), failure("provider")]) {
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
  const w = await world();
  w.answers.overview = failure("unavailable", { httpStatus: 429 }) as never;
  assert.equal((await w.tick()).backoffTicks, WATCH.backoffTicks);
  w.answers.overview = { ok: true, value: overview(80) };
  w.clock.now += 300_000;
  assert.equal((await w.tick()).skipped, "backoff");
  assert.deepEqual(w.calls, [], "nothing read during the backoff");
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
  assert.deepEqual(event, { organization: ORG, agent: AGENT, stopped: "not connected", note: "the owner's consent for this app has ended: they connect again on the proposals page" });
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
  // "Access ended before forwarding" (`app-routes.ts:182-186`) comes while the platform stops, the consent still live.
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
  // The platform answers withdrawn only through a live consent (`app-routes.ts:141-143`): the owner connected again
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

test("each proposal is notified once, with a link to it on the proposals page; a failed notifier is reported, not retried", async () => {
  const w = await world();
  const agent = { ...WATCHED, notify: w.notify };
  w.notifyAnswers.push({ ok: false, error: "exited with 3: channel down" });
  const event = await w.tick(agent);
  const id = event.proposed as string;
  assert.deepEqual(w.notified, [{ organization: ORG, agent: AGENT, proposalId: id, expiresAt: "2026-11-06T12:00:00.000Z", secondsLeft: 86_400,
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
