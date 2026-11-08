import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { OwnerOutput } from "@multiagency/sdk";
import type { AuditEntry } from "../src/audit.ts";
import type { BallastSettings } from "../src/ballast.ts";
import * as contract from "../src/contract.ts";
import { standInDaos, type Policy } from "../src/dao.ts";
import { createStrategyProposals, fileProposalRecords, MAX_REASONS, memoryProposalRecords, proposeMandate } from "../src/strategy-proposals.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";
import { join } from "node:path";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const DIGEST = `sha256:${"a".repeat(64)}`, DAO = "agentic.sputnik-dao.near";
const strategy = { targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, minLegUsd: 2, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 0 } };
const SETTINGS: BallastSettings = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };

const store = () => {
  const audited: AuditEntry[] = [];
  const clock = { now: 1_000 };
  return { audited, clock, proposals: createStrategyProposals(memoryProposalRecords(), { audit: { append: async entry => { audited.push(entry); } }, now: () => clock.now }) };
};

test("a proposal is validated before it's stored: the Strategy page's bounds, the policy's assets, and reasons of 1 to 2,000 characters", async () => {
  const { proposals, audited } = store();
  const cases: [string, unknown, string, "any" | string[]][] = [
    ["targets not adding up", { ...strategy, targetBps: { [USDC]: 6_000, [WNEAR]: 3_000, [ETH]: 0 } }, "why", "any"],
    ["a managed asset left out", { ...strategy, targetBps: { [USDC]: 6_000, [WNEAR]: 4_000 } }, "why", "any"],
    ["a cost over 10%", { ...strategy, maxCostBps: 1_001 }, "why", "any"],
    ["runs more often than every 5 minutes", { ...strategy, autopilot: { everyMin: 4, maxUsd: 0 } }, "why", "any"],
    ["a target outside the policy's assets", strategy, "why", [USDC]],
    ["a cash floor in an asset it doesn't manage", { ...strategy, cashFloor: { usd: 100, assets: ["nep141:usdt.tether-token.near"] } }, "why", "any"],
    ["no reasons", strategy, " ", "any"],
    ["reasons too long", strategy, "x".repeat(MAX_REASONS + 1), "any"],
  ];
  for (const [label, proposed, reasons, policyAssets] of cases) {
    const answer = await proposals.propose({ agent: "portfolio", from: "mandate", strategy: proposed, reasons, against: DIGEST, policyAssets });
    assert.ok(!answer.ok && "problems" in answer && answer.problems.length > 0, label);
  }
  assert.deepEqual([proposals.open("portfolio"), audited], [[], []], "nothing stored or recorded");
  // A zero target outside the policy's assets is no target: ETH at 0 under a policy of USDC and wNEAR.
  const stored = await proposals.propose({ agent: "portfolio", from: "mandate", strategy, reasons: "why", against: DIGEST, policyAssets: [USDC, WNEAR] });
  assert.ok(stored.ok);
  assert.deepEqual(audited.map(entry => [entry.who, entry.action, entry.stage, entry.subject]),
    [["mandate", "strategy-propose", "attempt", stored.id], ["mandate", "strategy-propose", "result", stored.id]]);
});

test("at most one open per agent per source: a source's new proposal supersedes its open one, and another source's stays", async () => {
  const { proposals, clock } = store();
  const propose = (from: "mandate" | `token:${string}`, maxCostBps: number) =>
    proposals.propose({ agent: "portfolio", from, strategy: { ...strategy, maxCostBps }, reasons: "why", against: DIGEST, policyAssets: "any" });
  const first = await propose("mandate", 50);
  clock.now += 1;
  const token = await propose(`token:${"1".repeat(16)}`, 60);
  clock.now += 1;
  const second = await propose("mandate", 70);
  assert.ok(first.ok && token.ok && second.ok);
  assert.deepEqual(proposals.open("portfolio").map(p => p.id), [token.id, second.id]);
  assert.equal(proposals.last("portfolio", "mandate")!.id, second.id);
  assert.deepEqual(proposals.open("other"), []);
});

test("kept in a file, a declined proposal outlives a restart, so its strategy isn't proposed again", async () => {
  const file = join(tempDir("strategy-proposals-"), "strategy-proposals.json");
  const audit = { append: async () => {} };
  const first = createStrategyProposals(await fileProposalRecords(file), { audit });
  const stored = await first.propose({ agent: "portfolio", from: "mandate", strategy, reasons: "why", against: DIGEST, policyAssets: "any" });
  assert.ok(stored.ok);
  await first.close("portfolio", stored.id, "declined");
  const restarted = createStrategyProposals(await fileProposalRecords(file), { audit });
  assert.deepEqual([restarted.last("portfolio", "mandate")?.id, restarted.last("portfolio", "mandate")?.closed?.outcome], [stored.id, "declined"]);
});

/** An agent's overview: 100,000 USD in USDC and wNEAR at the saved targets, under a policy of `assets`. */
const overviewOf = (target: Record<string, number>, assets: "any" | string[] = "any", maxCostBps = 50) => ({
  book: [{ asset: USDC, usd: 85_000 }, { asset: WNEAR, usd: 15_000 }], target, rebalance: { minLegUsd: 2, maxCostBps }, policy: { policy: { assets } },
}) as unknown as OwnerOutput<"overview">;
const savedRead = (saved: object, digest = DIGEST) => async () => {
  reads.count++;
  return { ok: true as const, value: { strategy: saved, digest } as unknown as OwnerOutput<"strategy/get"> };
};
const reads = { count: 0 };

test("the mandate proposer proposes what the profile compiles to, with the other fields as saved, cash floor included", async () => {
  const { proposals } = store();
  reads.count = 0;
  const saved = { targetBps: { [USDC]: 8_500, [WNEAR]: 1_500, [ETH]: 0 }, minLegUsd: 7, maxCostBps: 120, autopilot: { everyMin: 30, maxUsd: 500 }, cashFloor: { usd: 12_000, assets: [USDC] } };
  const note = await proposeMandate({ agent: "portfolio", settings: SETTINGS, overview: overviewOf({ [USDC]: 0.85, [WNEAR]: 0.15, [ETH]: 0 }, [USDC, WNEAR], 120), strategy: savedRead(saved), proposals });
  assert.ok("proposed" in note, JSON.stringify(note));
  const [open] = proposals.open("portfolio");
  // Balanced: 40% volatile in wNEAR, 35% reserve and 25% cash in USDC; ETH 0; the cost limit its 0.5% slippage limit.
  assert.deepEqual(open!.strategy, { targetBps: { [USDC]: 6_000, [WNEAR]: 4_000, [ETH]: 0 }, maxCostBps: 50, minLegUsd: 7, autopilot: { everyMin: 30, maxUsd: 500 }, cashFloor: { usd: 12_000, assets: [USDC] } });
  assert.equal(open!.against, DIGEST, "compared against the saved strategy's digest");
  assert.match(open!.reasons, /^Ballast's balanced profile: 40% volatile in wNEAR/);
  assert.match(open!.reasons, /monthly spend 2000 USD, 6 months of operating cash, approvers owner\.near, destinations ops\.near/);
  assert.equal(reads.count, 1);
});

test("the mandate proposer proposes nothing, and reads no strategy, when the saved one matches, its own is open, or the owner declined that strategy", async () => {
  const { proposals } = store();
  reads.count = 0;
  const differing = overviewOf({ [USDC]: 0.85, [WNEAR]: 0.15, [ETH]: 0 });
  const saved = { ...strategy, targetBps: { [USDC]: 8_500, [WNEAR]: 1_500, [ETH]: 0 } };
  const run = (overview = differing, settings = SETTINGS) => proposeMandate({ agent: "portfolio", settings, overview, strategy: savedRead(saved), proposals });

  assert.deepEqual(await run(overviewOf({ [USDC]: 0.6, [WNEAR]: 0.4, [ETH]: 0 })), { skipped: "matches the saved strategy" });
  const proposed = await run();
  assert.ok("proposed" in proposed, JSON.stringify(proposed));
  const id = proposed.proposed as string;
  reads.count = 0;
  assert.deepEqual(await run(), { skipped: "open", id });
  await proposals.close("portfolio", id, "declined");
  assert.deepEqual(await run(), { skipped: "declined", id });
  assert.equal(reads.count, 0);

  // What the profile compiles to changes (growth: 60% wNEAR, a 0.5% limit): proposed again.
  const growth = await run(differing, { ...SETTINGS, profile: "growth" });
  assert.ok("proposed" in growth, JSON.stringify(growth));
  assert.deepEqual(proposals.open("portfolio").map(p => p.strategy.targetBps[WNEAR]), [6_000]);
});

test("the mandate proposer proposes nothing for a treasury worth nothing, or one its profile can't hold the cash floor of", async () => {
  const { proposals } = store();
  const empty = { ...overviewOf({ [USDC]: 1 }), book: [{ asset: USDC, usd: 0 }] } as unknown as OwnerOutput<"overview">;
  assert.deepEqual(await proposeMandate({ agent: "portfolio", settings: SETTINGS, overview: empty, strategy: savedRead(strategy), proposals }), { skipped: "unpriced" });
  const floor = await proposeMandate({ agent: "portfolio", settings: { ...SETTINGS, monthlySpendUsd: 10_000 }, overview: overviewOf({ [USDC]: 1 }), strategy: savedRead(strategy), proposals });
  assert.equal((floor as { skipped: string }).skipped, "mandate refused");
  assert.deepEqual(proposals.open("portfolio"), []);
});

// The routes: the owner lists, adopts and declines.
const owner = wallet("owner.near"), council = wallet("council.near");
const fake = fakePlatform({ portfolio: "owner.near", daoagent: DAO }, { daos: ["daoagent"] });
/** A council with the DAO's policy-change rights, which saving needs (`canManage`), and the right to file and vote. */
const policy: Policy = {
  proposal_bond: "0", proposal_period: String(7 * 86_400 * 1e9), default_vote_policy: { threshold: [1, 2] },
  roles: [{ name: "all", kind: "Everyone", permissions: [], vote_policy: {} },
    { name: "council", kind: { Group: ["council.near"] }, permissions: ["*:*"], vote_policy: {} }],
};
const routes = store();
const audit: AuditEntry[] = [];
const cookies: Record<string, string> = {};
let server: Server, base: string;

before(async () => {
  const started = await testServer({ platform: fake.platform, wallets: [owner, council], audited: audit, strategyProposals: routes.proposals,
    daos: standInDaos({ [DAO]: policy }, { [DAO]: [] }) });
  ({ server, base } = started);
  for (const who of [owner, council]) cookies[who.accountId] = await started.signIn(who);
});
after(() => server.close());

const call = async (method: "GET" | "POST", path: string, body: unknown = {}, as = owner, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/${path}`, { method, headers: { cookie: cookies[as.accountId]!, ...(method === "POST" && { origin: ORIGIN, "content-type": "application/json" }) },
    ...(method === "POST" && { body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const consent = { id: "c".padEnd(64, "0"), deployment: "treasury", host: "platform.test", organization: "owner--near", owner: "owner.near", agent: "portfolio",
  agentId: "id-portfolio", scopes: ["owner", "read", "treasury"] as ("owner" | "read" | "treasury")[], expiresAt: Date.now() + 86_400_000, createdAt: 0, publicKey: "k", revoked: false, revokedAt: null };
const reset = () => {
  fake.calls.length = 0; audit.length = 0; fake.grants.length = 0;
  fake.schedules.portfolio = { on: false, unbound: false };
  fake.schedules.daoagent = { on: false, unbound: false };
  fake.consents.length = 0; fake.consents.push(consent);
};
const proposeFor = async (agent: string, against = DIGEST) => {
  const answer = await routes.proposals.propose({ agent, from: "mandate", strategy, reasons: "Ballast's balanced profile", against, policyAssets: "any" });
  assert.ok(answer.ok);
  return answer.id;
};
const actions = () => audit.map(entry => [entry.action, entry.stage, entry.subject]);

test("the owner lists the open proposals with their source and reasons, and adopts one: saved by the digest it was compared against, then the grant that binds it", async () => {
  reset();
  const id = await proposeFor("portfolio");
  const listed = await call("GET", "strategy-proposals");
  assert.deepEqual(listed.body.value.map((p: { id: string; source: string; reasons: string; against: string }) => [p.id, p.source, p.reasons, p.against]),
    [[id, "mandate", "Ballast's balanced profile", DIGEST]]);

  const adopted = await call("POST", `strategy-proposals/${id}/adopt`);
  assert.equal(adopted.status, 200, adopted.text);
  const { digest } = contract.strategySaved.parse(adopted.body.value);
  assert.deepEqual(fake.calls.filter(made => made.startsWith("autopilot.save")), [`autopilot.save owner--near portfolio ${DIGEST}`]);
  assert.deepEqual(contract.strategyRead.parse((await call("GET", "strategy")).body.value).strategy.targetBps, strategy.targetBps);
  assert.deepEqual(actions(), [["strategy-adopt", "attempt", id], ["strategy-adopt", "result", id]]);
  assert.deepEqual(routes.proposals.open("portfolio"), [], "closed once adopted");
  assert.equal(routes.proposals.last("portfolio", "mandate")!.closed!.outcome, "adopted");

  const granted = await call("POST", "grant", { expectedDigest: digest });
  assert.equal(granted.status, 200, granted.text);
  assert.ok(contract.grantPrepared.parse(granted.body.value).intent, "the wallet signs the grant binding the adopted strategy");
  assert.deepEqual(fake.calls.filter(made => made.startsWith("grant.prepare")), [`grant.prepare owner--near portfolio wallet ${digest}`]);
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/adopt`)).body, { ok: false, kind: "refused", code: "no_proposal" }, "adopted once");
});

test("a DAO's member adopts a proposal; the grant that binds it is prepared for the DAO's vote", async () => {
  reset();
  const id = await proposeFor("daoagent");
  const adopted = await call("POST", `strategy-proposals/${id}/adopt`, {}, council, "daoagent");
  assert.equal(adopted.status, 200, adopted.text);
  const { digest } = contract.strategySaved.parse(adopted.body.value);
  const granted = await call("POST", "grant", { expectedDigest: digest }, council, "daoagent");
  assert.equal(granted.status, 200, granted.text);
  assert.ok(contract.grantPrepared.parse(granted.body.value).dao, "a transaction to file for the DAO's vote");
  assert.deepEqual(fake.calls.filter(made => made.startsWith("grant.prepare")), [`grant.prepare ${DAO.replaceAll(".", "--")} daoagent dao ${digest}`]);
  assert.deepEqual(audit.map(entry => entry.who).slice(0, 2), ["council.near", "council.near"]);
});

test("a proposal compared against a strategy since saved over is refused, strategy_changed, and closed: nothing is overwritten", async () => {
  reset();
  fake.schedules.portfolio = { on: false, digest: `sha256:${"c".repeat(64)}` };
  fake.autopilotAnswers.save = [{ ok: false, kind: "refused", status: 409, error: "digest mismatch" }];
  const id = await proposeFor("portfolio");
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/adopt`)).body, { ok: false, kind: "refused", code: "strategy_changed" });
  assert.equal(routes.proposals.last("portfolio", "mandate")!.closed!.outcome, "superseded");
  assert.deepEqual(routes.proposals.open("portfolio"), []);
});

test("declining closes a proposal and is recorded; the platform is never asked", async () => {
  reset();
  const id = await proposeFor("portfolio");
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/decline`)).body, { ok: true, value: {} });
  assert.equal(routes.proposals.last("portfolio", "mandate")!.closed!.outcome, "declined");
  assert.deepEqual(actions(), [["strategy-decline", "attempt", id], ["strategy-decline", "result", id]]);
  assert.deepEqual(fake.calls.filter(made => !made.startsWith("identity")), []);
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/decline`)).body, { ok: false, kind: "refused", code: "no_proposal" });
});

test("another owner's agent's proposal is no proposal here", async () => {
  reset();
  const id = await proposeFor("daoagent");
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/adopt`)).body, { ok: false, kind: "refused", code: "no_proposal" });
  assert.deepEqual((await call("POST", `strategy-proposals/${id}/decline`)).body, { ok: false, kind: "refused", code: "no_proposal" });
  assert.equal(routes.proposals.open("daoagent").length, 1);
});
