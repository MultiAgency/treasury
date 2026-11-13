import { feedsFromBook } from "./fakes.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { OwnerOutput } from "@multiagency/sdk";
import { PROPOSAL_ASSETS, replayAuditLog } from "../../../packages/core/src/index.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { readFile } from "node:fs/promises";
import { createAssessment } from "../src/assessment.ts";
import { createEngineState, createPriceHistory, type BallastSettings } from "../src/ballast.ts";
import { chainedFileAudit } from "../src/chain.ts";
import { latestRiskRecord, type RiskEntry } from "../src/risk.ts";
import type { WatchPlatform } from "../src/platform.ts";

const at = Date.parse("2026-11-12T12:00:00Z"), HOUR = 3600000;
const terms: BallastSettings = { profile: "balanced", monthlySpendUsd: 2000, operatingCashMonths: 6,
  destinations: ["ops.near"], approvers: ["owner.near"] };
async function world({ fail = false, seeded = true } = {}) {
  const dir = tempDir("treasury-assessment-");
  const history = await createPriceHistory(join(dir, "history"));
  const states = await createEngineState(join(dir, "states"));
  if (seeded) await history.seed(PROPOSAL_ASSETS.wNEAR, Array.from({ length: 24 * 36 }, (_, i) => ({ at: at - (24 * 36 - i) * HOUR, price: 4 })), at);
  const audit = chainedFileAudit<RiskEntry>(join(dir, "audit"), () => at, fail ? async () => { throw new Error("disk full"); } : undefined);
  await audit.check();
  const book = [{ asset: PROPOSAL_ASSETS.wNEAR, symbol: "wNEAR", usd: 40000, price: 4 },
    { asset: PROPOSAL_ASSETS.USDC, symbol: "USDC", usd: 60000, price: 1 }].map(row => ({ ...row,
      priceUpdatedAt: new Date(at - 60000).toISOString(), priceExpiresAt: new Date(at + 60000).toISOString() }));
  const calls: string[] = [];
  const platform: Pick<WatchPlatform, "overview" | "autopilot"> = {
    overview: async (organization, agent) => { calls.push(`overview ${organization}/${agent}`); return { ok: true, value: { book } as unknown as OwnerOutput<"overview"> }; },
    autopilot: async () => { calls.push("autopilot"); return { ok: true, value: { on: false } } as Awaited<ReturnType<WatchPlatform["autopilot"]>>; },
  };
  const assess = createAssessment({ platform, history, states, audit, prices: feedsFromBook(() => ({ book })), now: () => at });
  return { assess, audit, book, calls, history, states, platform, prices: feedsFromBook(() => ({ book })) };
}

test("production assessment service records the real book, replays, and has only read capabilities", async () => {
  const w = await world();
  assert.equal(await latestRiskRecord(w.audit.file, "owner", "agent"), null);
  const result = await w.assess("owner", "agent", terms);
  assert.ok(result);
  assert.equal(result.entry.input.autopilotOn, false);
  assert.equal(result.entry.assessment.projection.usable, true);
  assert.equal(result.entry.requestId, undefined);
  assert.deepEqual(result, await latestRiskRecord(w.audit.file, "owner", "agent"));
  assert.equal(await latestRiskRecord(w.audit.file, "other", "agent"), null);
  assert.equal(replayAuditLog(await readFile(w.audit.file, "utf8")).ok, true);
  assert.deepEqual(w.calls, ["overview owner/agent", "autopilot"]);
  assert.deepEqual(w.states.find("owner", "agent").proposed, []);
});

test("stale, missing or future prices refuse without writing a risk record", async () => {
  const w = await world();
  for (const expires of ["", new Date(at).toISOString()]) {
    w.book[0]!.priceExpiresAt = expires;
    assert.equal(await w.assess("owner", "agent", terms), null);
  }
  w.book[0]!.priceExpiresAt = new Date(at + HOUR).toISOString();
  w.book[0]!.priceUpdatedAt = new Date(at + 1).toISOString();
  assert.equal(await w.assess("owner", "agent", terms), null);
  assert.equal(w.audit.head().seq, 0);
});

test("missing history stays explicit; audit failure cannot report success", async () => {
  const w = await world({ seeded: false });
  const result = await w.assess("owner", "agent", terms);
  assert.ok(result);
  assert.equal(result.entry.assessment.projection.usable, false);
  assert.ok(result.entry.assessment.projection.reasons.length);
  const broken = await world({ fail: true });
  await assert.rejects(broken.assess("owner", "agent", terms), /disk full/);
  await assert.rejects(broken.assess("owner", "agent", terms), /disk full/);
  assert.equal(broken.audit.head().seq, 0);
});

test("an interleaved append cannot replace the assessment returned to its caller", async () => {
  const w = await world();
  const assess = createAssessment({ ...w, now: () => at, audit: { appendRecord: async entry => {
    const record = await w.audit.appendRecord(entry);
    await w.audit.append({ ...entry, agent: "concurrent" });
    return record;
  } } });
  const result = await assess("owner", "agent", terms);
  assert.equal(result?.seq, 1);
  assert.equal(w.audit.head().seq, 2);
  assert.equal(result?.entry.agent, "agent");
});

test("DAO assessment requires a current authorized member and records the DAO scope", async t => {
  const { fakePlatform, wallet, ORIGIN } = await import("./fakes.ts");
  const { testServer } = await import("./test-server.ts");
  const { standInDaos } = await import("../src/dao.ts");
  const member = wallet("member.near"), outsider = wallet("outsider.near");
  const dao = "treasury.sputnik-dao.near";
  const fake = fakePlatform({ portfolio: dao }, { daos: ["portfolio"] });
  const w = await world();
  const policy = { proposal_bond: "1", proposal_period: "604800000000000", default_vote_policy: { threshold: [1, 2] },
    roles: [{ name: "council", kind: { Group: [member.accountId] }, permissions: ["call:AddProposal", "call:VoteApprove"], vote_policy: {} }] };
  const server = await testServer({ platform: fake.platform, wallets: [member, outsider],
    daos: standInDaos({ [dao]: policy }), recordRisk: w.assess });
  t.after(() => server.server.close());
  const cookie = await server.signIn(member), other = await server.signIn(outsider);
  const post = (as: string) => fetch(`${server.base}/api/agents/portfolio/risk/assess`, { method: "POST",
    headers: { cookie: as, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(terms) });
  assert.equal((await post(other)).status, 403);
  assert.deepEqual(w.calls, []);
  const answer = await post(cookie);
  assert.equal(answer.status, 200, await answer.clone().text());
  const body = await answer.json() as { value: { proposed: boolean; risk: { seq: number } } };
  assert.equal(body.value.proposed, false);
  assert.equal(body.value.risk.seq, 1);
  assert.equal((await latestRiskRecord(w.audit.file, "treasury--sputnik-dao--near", "portfolio"))?.seq, 1);
  policy.roles[0]!.kind.Group = [];
  assert.equal((await post(cookie)).status, 403);
  assert.equal(w.audit.head().seq, 1);
});

test("a slow owner does not prevent another owner's platform reads from starting", async () => {
  const w = await world();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const assess = createAssessment({ ...w, now: () => at, platform: { ...w.platform,
    overview: async (organization, agent) => {
      started.push(organization);
      if (organization === "slow") await gate;
      return w.platform.overview(organization, agent);
    },
  } });
  const slow = assess("slow", "agent", terms);
  const fast = assess("fast", "agent", terms);
  await new Promise<void>(resolve => setImmediate(resolve));
  const fastStarted = started.includes("fast");
  release();
  await Promise.all([slow, fast]);
  assert.equal(fastStarted, true, "another owner's read must start before the slow owner completes");
});

test("busy admission is bounded per owner and globally, with no queued reads", async () => {
  const { AssessmentBusy, MAX_ACTIVE_ASSESSMENTS } = await import("../src/assessment.ts");
  const w = await world();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const assess = createAssessment({ ...w, now: () => at, platform: { ...w.platform,
    overview: async (organization, agent) => { reads++; await gate; return w.platform.overview(organization, agent); },
  } });
  const running = Array.from({ length: MAX_ACTIVE_ASSESSMENTS }, (_, i) => assess(`owner-${i}`, "agent", terms));
  try {
    await assert.rejects(assess("owner-0", "another-agent", terms), AssessmentBusy);
    await assert.rejects(assess("overflow", "agent", terms), AssessmentBusy);
    assert.equal(reads, MAX_ACTIVE_ASSESSMENTS);
  } finally { release(); await Promise.all(running); }
  assert.ok(await assess("overflow", "agent", terms), "capacity is released after success");
});

test("capacity is released after refusal and failure, and waits for both reads to settle", async () => {
  const { AssessmentBusy } = await import("../src/assessment.ts");
  const w = await world();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const assess = createAssessment({ ...w, now: () => at, platform: { ...w.platform,
    overview: async () => { throw new Error("network"); },
    autopilot: async (...args) => { await gate; return w.platform.autopilot(...args); },
  } });
  const failed = assess("owner", "agent", terms);
  const rejected = assert.rejects(failed, /prerequisites/);
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(assess("owner", "another", terms), AssessmentBusy);
  release();
  await rejected;
  await assert.rejects(assess("owner", "agent", terms), /prerequisites/);
  w.book[0]!.priceExpiresAt = "";
  assert.equal(await w.assess("owner", "agent", terms), null);
  assert.equal(await w.assess("owner", "agent", terms), null);
});
