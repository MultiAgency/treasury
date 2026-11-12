// An opt-in live-model check over synthetic records only. It starts no app server and reads no hosted treasury.
// Run `pnpm smoke:assistant` with NEARAI_API_KEY in the environment or an untracked .env file.
// Use `pnpm smoke:assistant --rules` explicitly to check the same assertions without a provider.
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAssistant } from "../apps/server/src/assistant/assistant.ts";
import { nearAiModel, type AssistantModel } from "../apps/server/src/assistant/model.ts";
import { rulesModel } from "../apps/server/src/assistant/rules-model.ts";
import { Secret } from "../apps/server/src/config.ts";
import type { AssistantContext, AssistantStreamEvent, AssistantWhatIf } from "../apps/server/src/contract.ts";
import { createDaoRequests } from "../apps/server/src/dao-requests.ts";
import { riskWhatIfOf, type StoredRisk } from "../apps/server/src/risk.ts";
import { fakePlatform } from "../apps/server/test/fakes.ts";
import { assessRisk, POLICY_CONFIG_DEFAULTS, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS, type RiskInput } from "../packages/core/src/index.ts";
import { tempDir } from "./temp-dirs.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--rules")) {
  console.error("Usage: pnpm smoke:assistant [--rules]");
  process.exit(2);
}
const useRules = args[0] === "--rules";
const key = process.env.NEARAI_API_KEY?.trim();
if (!useRules && !key) {
  console.error("Live assistant smoke not run: NEARAI_API_KEY is unset. Configure it locally and rerun; never paste it into chat or logs.");
  process.exit(2);
}

class SmokeCheckFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeCheckFailure(message);
}

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
const record: StoredRisk = { seq: 9, at: new Date(at).toISOString(), entry: {
  kind: "risk", organization: "owner--near", agent: "portfolio", input, assessment: assessRisk(input),
} };
type Scenario = { name: string; question: string; context: AssistantContext; event: AssistantWhatIf["event"]; invalid?: boolean };
const scenarios: Scenario[] = [
  { name: "explicit 50% overrides selected 25%", question: "What if all volatile holdings fall 50% in a day? Use only that shock, with no asset filter.",
    context: { whatIf: { volatileDropPct: 25 } }, event: { volatileDropPct: 50 } },
  { name: "selected fractional drop", question: "Explain this selected scenario and whether the cash floor holds. Preserve its exact inputs.",
    context: { whatIf: { volatileDropPct: 0.5 } }, event: { volatileDropPct: 0.5 } },
  { name: "selected compound scenario", question: "Explain this selected scenario and whether the cash floor holds. Preserve both selected shocks.",
    context: { whatIf: { volatileDropPct: 25, spendFactor: 2 } }, event: { volatileDropPct: 25, spendFactor: 2 } },
  { name: "invalid drop stays invalid", question: "Explain this selected scenario exactly as selected. Do not silently correct or replace an invalid input.",
    context: { whatIf: { volatileDropPct: -5 } }, event: { volatileDropPct: -5 }, invalid: true },
];

// Four scenarios, at most four model turns each, the app's request timeout and a five-minute overall deadline.
// The provider adapter retains its existing bounded retry behavior; this runner never retries a question.
const deadline = AbortSignal.timeout(300_000);
const provider = useRules ? rulesModel() : nearAiModel({ apiKey: new Secret(key!), ...(process.env.TREASURY_ASSISTANT_MODEL && { model: process.env.TREASURY_ASSISTANT_MODEL }),
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([deadline, init?.signal ?? deadline]) }) });
const daoRequests = await createDaoRequests(join(tempDir("treasury-assistant-smoke-"), "dao.json"));
let failures = 0, passed = 0;
console.log(`${useRules ? "Rules" : "Live"} assistant smoke: four scenarios using synthetic treasury records only.`);
for (const scenario of scenarios) {
  if (deadline.aborted) { console.error("FAIL remaining scenarios: overall time budget reached."); failures++; break; }
  const fake = fakePlatform({ portfolio: "owner.near" });
  const events: AssistantStreamEvent[] = [];
  let turns = 0;
  const model: AssistantModel = { name: provider.name, respond: request => {
    check(++turns <= 4 && !deadline.aborted, "model turn or time budget reached");
    return provider.respond(request);
  } };
  const assistant = createAssistant({ model, audit: { append: async () => {} }, questionsPerHour: 4, platformReadsPerHour: 24, toolCallsPerQuestion: 4 });
  try {
    const result = await assistant.ask({ who: "owner.near", question: scenario.question, context: scenario.context, history: [], persona: "stabilization",
      scope: { platform: fake.platform, organization: "owner--near", agent: "portfolio", signer: "wallet", daoRequests,
        latestRisk: async (organization, agent) => {
          check(organization === "owner--near" && agent === "portfolio", "risk read escaped its synthetic scope");
          return record;
        }, riskHistory: async () => [record], auditLog: async () => [] }, onEvent: event => { events.push(event); } });
    check(result.ok, "model did not finish an answer");
    check(result.value.drafts.length === 0, "a scenario question produced a draft");
    check(fake.calls.every(call => /^(?:reads\.|proposals\.(?:get|list) |autopilot\.(?:get|runs) )/.test(call)), "a scenario question called a platform mutation");
    const snapshots = events.filter(event => event.type === "STATE_SNAPSHOT").flatMap(event => event.snapshot.whatIf ? [event.snapshot.whatIf] : []);
    const artifact = result.value.whatIf;
    if (scenario.invalid) {
      check(!artifact?.answer.result && snapshots.every(snapshot => !snapshot.answer.result), "an invalid input produced numerical results");
      if (artifact) check(isDeepStrictEqual(artifact.event, scenario.event) && artifact.answer.problems.length > 0, "invalid inputs were changed or lacked an explanation");
    } else {
      const expected = { event: scenario.event, answer: riskWhatIfOf(record, scenario.event) };
      check(!result.value.stopped, "model stopped before completing the scenario");
      check(isDeepStrictEqual(artifact, expected), "structured result differs from the requested deterministic scenario");
      check(snapshots.length > 0 && snapshots.every(snapshot => isDeepStrictEqual(snapshot, expected)), "live snapshots differ from the requested scenario");
      check(result.value.sources.some(source => source.read === "risk/what-if" && result.value.answer.includes(`[${source.id}]`)), "scenario explanation lacks a source citation");
    }
    console.log(`PASS ${scenario.name}`);
    passed++;
  } catch (error) {
    // Neither provider error bodies nor model output are copied into terminal or CI logs.
    console.error(`FAIL ${scenario.name}: ${error instanceof SmokeCheckFailure ? error.message : "model request failed"}.`);
    failures++;
  }
}
console.log(`${passed}/${scenarios.length} scenario checks passed${deadline.aborted ? " before the time limit" : ""}.`);
process.exitCode = failures ? 1 : 0;
