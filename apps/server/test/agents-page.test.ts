import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assessRisk, POLICY_CONFIG_DEFAULTS, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS, whatIf, type RiskInput } from "../../../packages/core/src/index.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { createAssistant } from "../src/assistant/assistant.ts";
import { rulesModel, intentOf } from "../src/assistant/rules-model.ts";
import { runTool, toolDefinitions, toolNames, type ToolScope } from "../src/assistant/tools.ts";
import * as contract from "../src/contract.ts";
import { riskHistoryEntryOf, riskRecords, riskWhatIfOf, type StoredRisk } from "../src/risk.ts";
import { ORIGIN, fakePlatform, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

/**
 * The Agents page's server side (#219, #220): what the stabilization agent has been doing, the owner's what-if over its
 * recorded book, and the two agents' tool sets. The stabilization agent is held to forward risk by its tools, not its prompt.
 */
const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const { wNEAR, USDC } = PROPOSAL_ASSETS;
const HOUR = 3_600_000;

/** A calm balanced book at `iso`, as a watch tick records it. */
function storedRisk(seq: number, iso: string, usd = { volatile: 40_000, stable: 60_000 }): StoredRisk {
  const at = Date.parse(iso);
  const history = Array.from({ length: 15 * 24 + 1 }, (_, i) => ({ at: at - (15 * 24 - i) * HOUR, price: 4 }));
  const input: RiskInput = {
    at,
    book: [{ asset: wNEAR, symbol: "wNEAR", class: "volatile", usd: usd.volatile, venue: "NEAR Intents" },
      { asset: USDC, symbol: "USDC", class: "stable", usd: usd.stable, venue: "NEAR Intents" }],
    terms: { monthlySpendUsd: 2_000, operatingCashMonths: 6 },
    history: { [wNEAR]: history },
    thresholds: RISK_PROFILE_DEFAULTS.balanced, projection: PROJECTION_DEFAULTS, scenarios: SCENARIO_DEFAULTS, autopilotOn: false,
    trade: { turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, cashUsd: usd.stable,
      config: { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } },
      bounds: { volatileMinPct: 10, volatileMaxPct: 50 }, baseLevel: 0, lastActionAt: null, cooldownMs: HOUR,
      pricing: { prices: { [wNEAR]: "4", [USDC]: "1" }, decimals: { [wNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 50 } },
  };
  return { seq, at: iso, entry: { kind: "risk", organization: "owner--near", agent: "portfolio", input, assessment: assessRisk(input) } };
}
const OLDER = storedRisk(3, "2026-11-06T10:00:00.000Z"), NEWER = storedRisk(9, "2026-11-06T12:00:00.000Z");

async function start({ records = [NEWER, OLDER], configured = true }: { records?: StoredRisk[]; configured?: boolean } = {}) {
  const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
  const audited: unknown[] = [];
  const assistant = createAssistant({ model: rulesModel(), audit: { append: async entry => { audited.push(entry); } }, questionsPerHour: 1_000, platformReadsPerHour: 1_000 });
  const server = await testServer({
    platform: fake.platform, wallets: [owner, intruder], assistant, auditLog: async () => [],
    latestRisk: async (organization, agent) => records.find(r => r.entry.organization === organization && r.entry.agent === agent) ?? null,
    riskHistory: async (organization, agent, limit) => records.filter(r => r.entry.organization === organization && r.entry.agent === agent).slice(0, limit),
    riskStatus: () => ({ configured, intervalS: configured ? 300 : null }),
  });
  const cookie = await server.signIn(owner), other = await server.signIn(intruder);
  const call = async (method: "GET" | "POST", path: string, body?: unknown, as = cookie) => {
    const response = await fetch(`${server.base}/api/agents/portfolio${path}`, { method, headers: { cookie: as, origin: ORIGIN, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { ok: boolean; value?: any } };
  };
  const ask = async (question: string, persona?: "treasury" | "stabilization") => {
    const answered = await call("POST", "/assistant", { question, ...(persona && { persona }) });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    return contract.assistantAnswer.parse(answered.body.value);
  };
  const written = () => fake.calls.filter(entry => /save|create|approve|execute|prepare|submit|enable|freeze|revoke|disable|stop|run/.test(entry) && !entry.startsWith("identity"));
  return { ...server, fake, cookie, other, call, ask, written, audited };
}

test("the history is the agent's recorded assessments newest first, with whether watch runs it and how often", async t => {
  const w = await start();
  t.after(() => w.server.close());
  const answer = await w.call("GET", "/risk/history");
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const read = contract.riskHistoryRead.parse(answer.body.value);
  assert.deepEqual([read.configured, read.intervalS], [true, 300]);
  assert.deepEqual(read.entries.map(e => [e.seq, e.at]), [[9, NEWER.at], [3, OLDER.at]]);
  assert.deepEqual(read.entries[0], riskHistoryEntryOf(NEWER));
});

test("an agent watch doesn't run the stabilization agent for says so, with no entries: the page doesn't guess", async t => {
  const w = await start({ records: [], configured: false });
  t.after(() => w.server.close());
  assert.deepEqual((await w.call("GET", "/risk/history")).body, { ok: true, value: { configured: false, intervalS: null, entries: [] } });
});

test("the history and the what-if are the owner's: another account is refused, and so is no session", async t => {
  const w = await start();
  t.after(() => w.server.close());
  assert.equal((await w.call("GET", "/risk/history", undefined, w.other)).status, 403);
  assert.equal((await w.call("POST", "/risk/what-if", { volatileDropPct: 50 }, w.other)).status, 403);
  assert.equal((await w.call("GET", "/risk/history", undefined, "")).status, 401);
});

test("a what-if runs the recorded book through the agent's own stress arithmetic, and reads no platform", async t => {
  const w = await start();
  t.after(() => w.server.close());
  w.fake.calls.length = 0;
  const answer = await w.call("POST", "/risk/what-if", { volatileDropPct: 50, spendFactor: 2 });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const read = contract.riskWhatIfRead.parse(answer.body.value);
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.result?.basedOn, { at: NEWER.at, seq: 9 }, "the latest record's book");
  const direct = whatIf(NEWER.entry.input.book, NEWER.entry.input.terms, { volatileDropPct: 50, spendFactor: 2 });
  assert.ok(direct.ok);
  assert.deepEqual(read.result?.after, direct.after);
  assert.deepEqual(read.result?.now, direct.now);
  assert.ok(w.fake.calls.every(entry => entry.startsWith("identity ")), w.fake.calls.join());
});

test("a what-if the core refuses answers its reasons, not a result; no record answers that there is no book", async t => {
  const w = await start();
  t.after(() => w.server.close());
  for (const bad of [{}, { volatileDropPct: 0 }, { volatileDropPct: 150 }, { stablePrice: -1 }, { volatileDropPct: 30, asset: "BTC" }]) {
    const read = contract.riskWhatIfRead.parse((await w.call("POST", "/risk/what-if", bad)).body.value);
    assert.equal(read.result, null, JSON.stringify(bad));
    assert.ok(read.problems.length > 0, JSON.stringify(bad));
  }
  assert.equal((await w.call("POST", "/risk/what-if", { volatileDropPct: 30, surprise: true })).status, 400, "unknown fields are refused");
  const none = await start({ records: [] });
  t.after(() => none.server.close());
  const read = contract.riskWhatIfRead.parse((await none.call("POST", "/risk/what-if", { volatileDropPct: 30 })).body.value);
  assert.equal(read.result, null);
  assert.match(read.problems[0]!, /no risk assessment has been recorded/);
});

test("the log reader finds an agent's newest records across segments, newest first, and stops at the limit", async () => {
  const dir = tempDir("treasury-agents-page-");
  const file = join(dir, "audit.jsonl");
  const line = (r: StoredRisk) => JSON.stringify({ seq: r.seq, at: r.at, entry: r.entry });
  const elsewhere = { ...storedRisk(5, "2026-11-06T11:00:00.000Z"), entry: { ...storedRisk(5, "2026-11-06T11:00:00.000Z").entry, agent: "other" } };
  await writeFile(`${file}.000000000001`, [line(OLDER), "{not json", line(elsewhere)].join("\n") + "\n");
  await writeFile(file, [line(NEWER), JSON.stringify({ seq: 10, at: NEWER.at, entry: { kind: "decision", organization: "owner--near", agent: "portfolio" } })].join("\n") + "\n");
  assert.deepEqual((await riskRecords(file, "owner--near", "portfolio", 10)).map(r => r.seq), [9, 3], "the open segment first, then the closed one, never another agent's");
  assert.deepEqual((await riskRecords(file, "owner--near", "portfolio", 1)).map(r => r.seq), [9]);
  assert.deepEqual(await riskRecords(file, "owner--near", "portfolio", 0), []);
  assert.deepEqual(await riskRecords(join(dir, "missing.jsonl"), "owner--near", "portfolio", 5), []);
});

test("the stabilization agent is offered forward-risk tools only: no strategy, policy or grant draft, and none runs if asked", async () => {
  const names = toolNames("stabilization");
  // A rebalance goes back to the saved targets, which after a fall buys more of the volatile asset: never a de-risk.
  for (const forbidden of ["draft_strategy", "draft_policy_edit", "draft_grant", "draft_rebalance"]) assert.equal(names.has(forbidden), false, forbidden);
  for (const wanted of ["get_risk_report", "get_risk_history", "run_what_if", "draft_autopilot", "draft_freeze", "open_page"]) assert.equal(names.has(wanted), true, wanted);
  assert.deepEqual(toolDefinitions("stabilization").map(d => d.name).sort(), [...names].sort());
  assert.ok(toolDefinitions("treasury").length > toolDefinitions("stabilization").length);
  const scope = { platform: {} as never, organization: "owner--near", agent: "portfolio", signer: "wallet", daoRequests: {} as never, now: () => 0 } as ToolScope;
  assert.deepEqual(await runTool("draft_policy_edit", { owner_approval: true }, scope, "stabilization"), { error: "There is no tool named draft_policy_edit." });
  assert.deepEqual(await runTool("draft_grant", {}, scope, "stabilization"), { error: "There is no tool named draft_grant." });
});

test("asked about the risk, the stabilization agent answers from the latest assessment with sources, and writes nothing", async t => {
  const w = await start();
  t.after(() => w.server.close());
  w.fake.calls.length = 0;
  const answer = await w.ask("Why is the risk level what it is?", "stabilization");
  assert.match(answer.answer, /forward risk level is L0 normal/);
  assert.match(answer.answer, /\[S1\]/);
  assert.deepEqual(answer.sources.map(source => source.read), ["audit/risk", "audit/risk-history"]);
  assert.deepEqual(answer.drafts, []);
  assert.deepEqual(w.written(), []);
});

test("asked what if the volatile asset falls, it runs the arithmetic on the recorded book and says it isn't a forecast", async t => {
  const w = await start();
  t.after(() => w.server.close());
  const answer = await w.ask("What if NEAR falls 50% tomorrow?", "stabilization");
  assert.match(answer.answer, /would be worth \$80,000\.00 instead of \$100,000\.00/);
  assert.match(answer.answer, /not a forecast/);
  assert.deepEqual(answer.sources.map(source => source.read), ["risk/what-if"]);
  assert.deepEqual(w.written(), []);
});

test("the stabilization agent declines what isn't forward risk, and the treasury assistant drafts it", async t => {
  const w = await start();
  t.after(() => w.server.close());
  const declined = await w.ask("Set the daily budget to $200", "stabilization");
  assert.match(declined.answer, /treasury assistant does that/);
  assert.deepEqual(declined.drafts, []);
  const drafted = await w.ask("Set the daily budget to $200");
  assert.equal(drafted.drafts[0]?.kind, "policy");
  assert.deepEqual(w.written(), [], "a draft sends nothing");
});

test("an autopilot control and a page are drafts for the owner: nothing is turned on, run or changed from the assistant", async t => {
  const w = await start();
  t.after(() => w.server.close());
  const pause = await w.ask("Pause autopilot");
  assert.deepEqual(pause.drafts, [{ kind: "autopilot", action: "off", note: pause.drafts[0] && "note" in pause.drafts[0] ? pause.drafts[0].note : "" }]);
  const run = await w.ask("Run autopilot now", "stabilization");
  assert.deepEqual(run.drafts.map(d => d.kind === "autopilot" && d.action), ["run-now"]);
  const page = await w.ask("Take me to the policy page");
  assert.deepEqual(page.drafts.map(d => d.kind === "page" && d.page), ["policy"]);
  assert.deepEqual(w.written(), []);
});

test("an unknown persona is refused before the model, and each question and draft is audited by hashes", async t => {
  const w = await start();
  t.after(() => w.server.close());
  assert.equal((await w.call("POST", "/assistant", { question: "hi", persona: "root" })).status, 400);
  w.audited.length = 0;
  await w.ask("What if NEAR falls 40%?", "stabilization");
  const actions = (w.audited as { action: string; stage?: string }[]).map(entry => entry.action);
  assert.deepEqual(actions, ["assistant-ask", "assistant-tool", "assistant-ask"]);
  assert.ok(!JSON.stringify(w.audited).includes("falls 40%"), "the question's text never reaches the log");
});

test("the rules model reads the owner's words alone: risk, what-if, autopilot and page intents", () => {
  assert.deepEqual(intentOf("What if wNEAR drops 60% in a day"), { kind: "whatif", dropPct: 60 });
  assert.deepEqual(intentOf("pause the autopilot"), { kind: "autopilot", action: "off" });
  assert.deepEqual(intentOf("turn on autopilot"), { kind: "autopilot", action: "on" });
  assert.deepEqual(intentOf("show me the activity page"), { kind: "page", page: "activity" });
  assert.equal(intentOf("What's the stress test say?").kind, "risk");
  assert.equal(riskWhatIfOf(null, { volatileDropPct: 10 }).result, null);
});
