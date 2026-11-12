import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk, POLICY_CONFIG_DEFAULTS, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS, type RiskInput } from "../../../packages/core/src/index.ts";
import { createAssistant } from "../src/assistant/assistant.ts";
import type { AssistantModel } from "../src/assistant/model.ts";
import { rulesModel } from "../src/assistant/rules-model.ts";
import { sha256, type AuditEntry } from "../src/audit.ts";
import * as contract from "../src/contract.ts";
import { riskWhatIfOf, type LatestRisk, type StoredRisk } from "../src/risk.ts";
import { ORIGIN, fakePlatform, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const { wNEAR, USDC } = PROPOSAL_ASSETS;
const at = Date.parse("2026-11-06T12:00:00.000Z");
const input: RiskInput = {
  at, book: [{ asset: wNEAR, symbol: "wNEAR", class: "volatile", usd: 40_000, venue: "NEAR Intents" },
    { asset: USDC, symbol: "USDC", class: "stable", usd: 60_000, venue: "NEAR Intents" }],
  terms: { monthlySpendUsd: 2_000, operatingCashMonths: 6 },
  history: { [wNEAR]: Array.from({ length: 361 }, (_, i) => ({ at: at - (360 - i) * 3_600_000, price: 4 })) },
  thresholds: RISK_PROFILE_DEFAULTS.balanced, projection: PROJECTION_DEFAULTS, scenarios: SCENARIO_DEFAULTS, autopilotOn: false,
  trade: { turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, cashUsd: 60_000,
    config: { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } },
    bounds: { volatileMinPct: 10, volatileMaxPct: 50 }, baseLevel: 0, lastActionAt: null, cooldownMs: 3_600_000,
    pricing: { prices: { [wNEAR]: "4", [USDC]: "1" }, decimals: { [wNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 50 } },
};
const record: StoredRisk = { seq: 9, at: new Date(at).toISOString(), entry: { kind: "risk", organization: "owner--near", agent: "portfolio", input, assessment: assessRisk(input) } };

async function start(model: AssistantModel = rulesModel(), latestRisk: LatestRisk = async () => record, questionsPerHour = 1_000, beforeAudit?: (entry: AuditEntry) => void | Promise<void>) {
  const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
  const audited: Parameters<Parameters<typeof createAssistant>[0]["audit"]["append"]>[0][] = [];
  const assistant = createAssistant({ model, audit: { append: async entry => { await beforeAudit?.(entry); audited.push(entry); } }, questionsPerHour, platformReadsPerHour: 1_000 });
  const server = await testServer({ platform: fake.platform, wallets: [owner, intruder], assistant, latestRisk });
  const cookie = await server.signIn(owner);
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${server.base}/api/agents/portfolio/assistant`, {
    method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", accept: "text/event-stream", ...headers }, body: JSON.stringify(body),
  });
  return { ...server, fake, audited, post };
}

async function* events(response: Response) {
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) yield contract.assistantStreamEvent.parse(JSON.parse(frame.slice(6)));
      }
      if (chunk.done) break;
    }
  } finally { reader.releaseLock(); }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("the live run arrives before the model finishes, and the scenario arrives before its explanation", { timeout: 10_000 }, async t => {
  const first = gate(), calculated = gate(), last = gate();
  let calls = 0;
  const model: AssistantModel = { name: "gated", async respond() {
    if (++calls === 1) {
      await first.promise;
      return { model: "gated", stop_reason: "tool_use", content: [{ type: "tool_use", id: "scenario-1", name: "run_what_if", input: { volatileDropPct: 50 } }] };
    }
    await last.promise;
    return { model: "gated", stop_reason: "end_turn", content: [{ type: "text", text: "The scenario is arithmetic on the recorded book [S1]." }] };
  } };
  const scopes: string[] = [];
  const w = await start(model, async (organization, agent) => { scopes.push(`${organization}/${agent}`); await calculated.promise; return record; });
  t.after(() => { first.resolve(); calculated.resolve(); last.resolve(); w.server.closeAllConnections(); w.server.close(); });
  const response = await w.post({ question: "What if NEAR falls 50%?", persona: "stabilization" });
  const stream = events(response);
  assert.equal((await stream.next()).value?.type, "RUN_STARTED", "the model is still blocked");
  first.resolve();
  assert.equal((await stream.next()).value?.type, "TOOL_CALL_START");
  assert.equal((await stream.next()).value?.type, "TOOL_CALL_ARGS");
  assert.equal((await stream.next()).value?.type, "TOOL_CALL_END", "arguments are complete; calculation is still blocked");
  calculated.resolve();
  const snapshot = (await stream.next()).value!;
  assert.equal(snapshot.type, "STATE_SNAPSHOT");
  if (snapshot.type !== "STATE_SNAPSHOT") return;
  assert.deepEqual(snapshot.snapshot.whatIf, { event: { volatileDropPct: 50 }, answer: riskWhatIfOf(record, { volatileDropPct: 50 }) });
  const completed = (await stream.next()).value!;
  assert.equal(completed.type, "TOOL_CALL_RESULT");
  if (completed.type === "TOOL_CALL_RESULT") assert.equal(completed.content, '{"ok":true}', "general tool results are never streamed raw");
  last.resolve();
  const finished = (await stream.next()).value!;
  assert.equal(finished.type, "RUN_FINISHED");
  if (finished.type === "RUN_FINISHED") assert.deepEqual(finished.result.whatIf, snapshot.snapshot.whatIf);
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(scopes, ["owner--near/portfolio"]);
  assert.ok(w.fake.calls.every(call => call.startsWith("identity ")), "the assistant sends no platform writes");
});

test("selected scenario inputs trigger a fresh deterministic read in both JSON and streamed answers", async t => {
  let reads = 0;
  const w = await start(rulesModel(), async () => { reads++; return record; });
  t.after(() => w.server.close());
  for (const accept of ["application/json", "text/event-stream"]) {
    const context = { whatIf: { spendFactor: 2 } };
    const response = await w.post({ question: "Explain this scenario", context, persona: "stabilization" }, { accept });
    let answer: contract.AssistantWhatIf | undefined;
    if (accept === "application/json") answer = contract.assistantAnswer.parse((await response.json() as any).value).whatIf;
    else for await (const event of events(response)) if (event.type === "RUN_FINISHED") answer = event.result.whatIf;
    assert.deepEqual(answer, { event: context.whatIf, answer: riskWhatIfOf(record, context.whatIf) });
  }
  assert.equal(reads, 2);
  assert.ok(w.audited.some(entry => entry.inputSha256 === sha256(JSON.stringify({ question: "Explain this scenario", context: { whatIf: { spendFactor: 2 } } }))));
  const legacy = await w.post({ question: "What is the book worth?" }, { accept: "application/json" });
  const body = contract.assistantAnswer.parse((await legacy.json() as any).value);
  assert.equal(body.whatIf, undefined, "legacy JSON callers need no new fields");
});

test("explicit scenario changes take precedence over the UI selection, and invalid scenarios have no result", async t => {
  const w = await start(); t.after(() => w.server.close());
  const explicit = await w.post({ question: "What if NEAR falls 25%?", context: { whatIf: { volatileDropPct: 50 } } }, { accept: "application/json" });
  assert.deepEqual(contract.assistantAnswer.parse((await explicit.json() as any).value).whatIf?.event, { volatileDropPct: 25 });
  const invalid = await w.post({ question: "Explain this scenario", context: { whatIf: { volatileDropPct: -5 } } });
  let result: contract.AssistantWhatIf | undefined;
  for await (const event of events(invalid)) if (event.type === "RUN_FINISHED") result = event.result.whatIf;
  assert.equal(result?.answer.result, null);
  assert.ok(result!.answer.problems.length > 0);
});

test("authentication, origin and forged context fail as JSON before a stream opens", async t => {
  let modelCalls = 0;
  const w = await start({ name: "unused", async respond() { modelCalls++; throw new Error("must not run"); } });
  t.after(() => w.server.close());
  const other = await w.signIn(intruder);
  for (const [headers, body, status] of [
    [{ cookie: "" }, { question: "hi" }, 401],
    [{ cookie: other }, { question: "hi" }, 403],
    [{ origin: "https://elsewhere.invalid" }, { question: "hi" }, 403],
    [{}, { question: "hi", context: { whatIf: { volatileDropPct: 50 }, result: { valueUsd: 1_000_000 } } }, 400],
    [{}, { question: "hi", context: { whatIf: { volatileDropPct: 50, agent: "theirs" } } }, 400],
  ] as const) {
    const response = await w.post(body, headers);
    assert.equal(response.status, status);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal((await response.json() as any).ok, false);
  }
  assert.equal(modelCalls, 0);
});

test("a provider failure terminates the stream with RUN_ERROR, and question limits are preserved", async t => {
  const w = await start({ name: "failed", async respond() { throw new Error("private provider error"); } }, undefined, 1);
  t.after(() => w.server.close());
  for (const code of ["unavailable", "rate_limited"]) {
    const seen = [];
    for await (const event of events(await w.post({ question: "Explain this scenario" }))) seen.push(event);
    assert.deepEqual(seen.map(event => event.type), ["RUN_STARTED", "RUN_ERROR"]);
    assert.equal(seen.at(-1)?.code, code);
    assert.ok(!JSON.stringify(seen).includes("private provider error"));
  }
});

test("a scenario whose audit write fails never reaches the browser as a result", async t => {
  const w = await start(rulesModel(), async () => record, 1_000, entry => {
    if (entry.action === "assistant-tool" && entry.stage === "result") throw new Error("audit unavailable");
  });
  t.after(() => w.server.close());
  const seen: contract.AssistantStreamEvent[] = [];
  for await (const event of events(await w.post({ question: "What if NEAR falls 50%?" }))) seen.push(event);
  assert.equal(seen.at(-1)?.type, "RUN_ERROR");
  assert.equal(seen.some(event => event.type === "STATE_SNAPSHOT" || event.type === "RUN_FINISHED"), false);
});
