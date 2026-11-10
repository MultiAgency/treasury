import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { assessRisk, POLICY_CONFIG_DEFAULTS, PROPOSAL_ASSETS, PROJECTION_DEFAULTS, RISK_PROFILE_DEFAULTS, SCENARIO_DEFAULTS,
  type RiskInput } from "../../../packages/core/src/index.ts";
import * as contract from "../src/contract.ts";
import { riskReportOf, type StoredRisk } from "../src/risk.ts";
import { fakePlatform, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const AT = "2026-11-06T12:00:00.000Z";
const { wNEAR, USDC } = PROPOSAL_ASSETS;
const HOUR = 3_600_000;

/** A calm balanced book, as a watch tick records it; the report is built the same way the route builds it. */
function storedRisk(seq = 7): StoredRisk {
  const at = Date.parse(AT);
  const history = Array.from({ length: 15 * 24 + 1 }, (_, i) => ({ at: at - (15 * 24 - i) * HOUR, price: 4 }));
  const input: RiskInput = {
    at,
    book: [{ asset: wNEAR, symbol: "wNEAR", class: "volatile", usd: 40_000, venue: "NEAR Intents" },
      { asset: USDC, symbol: "USDC", class: "stable", usd: 60_000, venue: "NEAR Intents" }],
    terms: { monthlySpendUsd: 2_000, operatingCashMonths: 6 },
    history: { [wNEAR]: history },
    thresholds: RISK_PROFILE_DEFAULTS.balanced, projection: PROJECTION_DEFAULTS, scenarios: SCENARIO_DEFAULTS, autopilotOn: false,
    trade: { turnoverTodayUsd: 0, ordersLastHour: 0, quotedSlippageBps: 0, cashUsd: 60_000,
      config: { ...POLICY_CONFIG_DEFAULTS, exposure: { ...POLICY_CONFIG_DEFAULTS.exposure, monthlySpendUsd: 2_000 } },
      bounds: { volatileMinPct: 10, volatileMaxPct: 50 }, baseLevel: 0, lastActionAt: null, cooldownMs: HOUR,
      pricing: { prices: { [wNEAR]: "4", [USDC]: "1" }, decimals: { [wNEAR]: 24, [USDC]: 6 }, maxSlippageBps: 50 } },
  };
  return { seq, at: AT, entry: { kind: "risk", organization: "owner--near", agent: "portfolio", input, assessment: assessRisk(input) } };
}

async function start({ latest }: { latest?: (organization: string, agent: string) => Promise<StoredRisk | null> }) {
  const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
  const calls: string[] = [];
  const server = await testServer({
    platform: fake.platform, wallets: [owner, intruder],
    ...(latest && { latestRisk: async (organization, agent) => { calls.push(`${organization}/${agent}`); return latest(organization, agent); } }),
  });
  const cookie = await server.signIn(owner), other = await server.signIn(intruder);
  const get = async (as = cookie) => {
    const response = await fetch(`${server.base}/api/agents/portfolio/risk`, { headers: { cookie: as } });
    return { status: response.status, body: await response.json() as { ok: boolean; value?: unknown } };
  };
  return { ...server, fake, calls, cookie, other, get };
}

test("the risk route answers the latest recorded assessment with its time and sequence number, and computes nothing", async (t) => {
  const w = await start({ latest: async (organization, agent) => organization === "owner--near" && agent === "portfolio" ? storedRisk() : null });
  t.after(() => w.server.close());
  w.fake.calls.length = 0;
  const answer = await w.get();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const read = contract.riskRead.parse(answer.body.value);
  assert.deepEqual(read.risk && [read.risk.seq, read.risk.at, read.risk.level], [7, AT, 0]);
  assert.deepEqual(w.calls, ["owner--near/portfolio"], "read from the server's own record once");
  assert.ok(w.fake.calls.every(call => call.startsWith("identity ")), w.fake.calls.join());
});

test("no assessment yet is null, honestly, and a server without the reader is null too", async (t) => {
  const none = await start({ latest: async () => null });
  t.after(() => none.server.close());
  assert.deepEqual((await none.get()).body, { ok: true, value: { risk: null } });
  const bare = await start({});
  t.after(() => bare.server.close());
  assert.deepEqual((await bare.get()).body, { ok: true, value: { risk: null } });
});

test("someone else's agent is not_owner and the record isn't read; the report is built from the stored record, never asked for", async (t) => {
  const w = await start({ latest: async () => storedRisk(9) });
  t.after(() => w.server.close());
  w.calls.length = 0;
  const answer = await w.get(w.other);
  assert.deepEqual([answer.status, answer.body], [403, { ok: false, kind: "not_owner" }]);
  assert.deepEqual(w.calls, []);
  // The view is the record's: the same figures `riskReportOf` makes, not a second assessment.
  const report = riskReportOf(storedRisk(9));
  const read = contract.riskRead.parse((await w.get()).body.value);
  assert.deepEqual(read.risk, report);
});
