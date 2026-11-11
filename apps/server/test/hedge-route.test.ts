import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { OwnerOutput } from "@multiagency/sdk";
import * as contract from "../src/contract.ts";
import type { AuditEntry } from "../src/audit.ts";
import type { BallastSettings } from "../src/ballast.ts";
import { createIntentsStub, stubTokens } from "../src/intents.ts";
import type { StoredRisk } from "../src/risk.ts";
import { fakePlatform, ORIGIN, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const audited: AuditEntry[] = [];

/** 80,000 USDC and 20,000 wNEAR: a book with no gold, no ETH, and 68,000 above its 12,000 cash floor. */
function bookOverview(): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, price: number, usd: number) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price, priceUpdatedAt: new Date().toISOString(), priceExpiresAt: new Date(Date.now() + 240_000).toISOString(), usd });
  return {
    agentId: "id-portfolio", book: [row(USDC, "USDC", 6, 1, 80_000), row(WNEAR, "wNEAR", 24, 4, 20_000)],
    unmanaged: [], target: {}, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null,
  } as unknown as OwnerOutput<"overview">;
}
const BASE: BallastSettings = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };
const ETH_HEDGE: BallastSettings = { ...BASE, hedge: { sleeves: [{ asset: "ETH", targetPct: 10, maxPct: 20 }] } };
const GOLD_HEDGE: BallastSettings = { ...BASE, hedge: { sleeves: [{ asset: "XAUT", targetPct: 5, maxPct: 10 }], classCapsPct: { rwa: 10 } } };

let server: Server, base: string, cookie: string, intruderCookie: string;
let configured: BallastSettings | undefined = ETH_HEDGE, risk: StoredRisk | null = null, riskUnreadable = false;
const stub = createIntentsStub();
const off = { source: "stub" as const, tokens: async () => ({ ok: false as const, kind: "unavailable" as const, detail: "NEAR Intents couldn't be reached" }), quote: async () => ({ ok: false as const, kind: "unavailable" as const, detail: "x" }) };

before(async () => {
  const started = await testServer({ platform: fake.platform, wallets: [owner, intruder], audited, ballastSettings: () => configured, latestRisk: async () => { if (riskUnreadable) throw new Error("audit segment unreadable"); return risk; }, intents: stub } as never);
  ({ server, base } = started);
  cookie = await started.signIn(owner);
  intruderCookie = await started.signIn(intruder);
  fake.reads.overview = bookOverview() as never;
});
after(() => server.close());

const get = async (as = cookie, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/hedge`, { headers: { cookie: as } });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const propose = async (body: unknown, as = cookie, agent = "portfolio") => {
  const response = await fetch(`${base}/api/agents/${agent}/hedge/propose`, { method: "POST", headers: { cookie: as, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const read = async () => { const r = await get(); assert.equal(r.status, 200, r.text); return contract.hedgeRead.parse(r.body.value); };
const creates = () => fake.calls.filter(made => made.startsWith("proposals.create"));
const reset = () => { fake.calls.length = 0; audited.length = 0; };

test("the read answers NEAR Intents' list against the registry and a plan whose move into a listed asset is executable, with its quote", async () => {
  reset();
  const hedge = await read();
  assert.deepEqual([hedge.intents.source, hedge.intents.status, hedge.configured, hedge.level], ["stub", "ok", true, null]);
  const xaut = hedge.registry.find(r => r.symbol === "XAUT")!;
  assert.deepEqual([xaut.listed, xaut.priceUsd, xaut.proposable, xaut.drift], [true, 4018.56, false, []]);
  assert.equal(hedge.registry.find(r => r.symbol === "TBILL")!.listed, false, "a slot with no id is on no list");
  assert.equal(hedge.registry.find(r => r.symbol === "USDC")!.heldUsd, 80_000);
  const move = hedge.plan!.moves.find(m => m.to === "ETH")!;
  assert.deepEqual([move.kind, move.shape, move.from, move.sizeUsd, move.status, move.canPropose, move.blocked], ["rebalance", "stable-to-risk", "USDC", 10_000, "executable", true, []]);
  assert.equal(move.quote!.costBps, 30);
  assert.ok(hedge.plan!.notes.some(n => /no stabilization assessment/.test(n)));
  assert.ok(hedge.plan!.notes.some(n => /omft-ethereum: no cap is set/.test(n)), "a bridge with no cap says the profile's default applies");
  assert.equal(fake.calls.filter(call => call === "reads.overview owner--near portfolio").length, 1, "one overview read");
  assert.ok(creates().length === 0, "reading proposes nothing");
});

test("gold is planned and blocked by the platform's list alone, with its quote and cap shown; without the owner's rwa cap it is blocked by the class too", async () => {
  configured = GOLD_HEDGE;
  const gold = (await read()).plan!.moves.find(m => m.to === "XAUT")!;
  assert.deepEqual([gold.kind, gold.shape, gold.sizeUsd, gold.status, gold.canPropose, gold.blocked.map(b => b.code)], ["rebalance", "stable-to-risk", 5_000, "blocked", false, ["not_listed"]]);
  assert.ok(gold.quote && gold.quote.costBps === 30);
  configured = { ...GOLD_HEDGE, hedge: { ...GOLD_HEDGE.hedge!, classCapsPct: {} } };
  const uncapped = (await read()).plan!.moves.find(m => m.to === "XAUT")!;
  assert.deepEqual(uncapped.blocked.map(b => b.code), ["not_listed", "class_cap", "no_quote"], "a move the book refuses is not quoted: no call is spent on it");
  configured = ETH_HEDGE;
});

test("raised forward risk moves a volatile asset into the hedge sleeve instead of buying with the reserve", async () => {
  risk = { seq: 7, at: new Date().toISOString(), entry: { assessment: { level: 2 } } } as unknown as StoredRisk;
  const hedge = await read();
  assert.equal(hedge.level, 2);
  const move = hedge.plan!.moves.find(m => m.to === "ETH")!;
  assert.deepEqual([move.kind, move.shape, move.from, move.sizeUsd, move.status], ["hedge", "risk-to-risk", "wNEAR", 10_000, "executable"]);
  risk = null;
});

test("with no hedge block there is no plan, only the registry; with NEAR Intents off or unreadable every move is blocked for want of a quote", async () => {
  configured = BASE;
  const none = await read();
  assert.deepEqual([none.configured, none.plan, none.problems.length], [false, null, 1]);
  assert.ok(none.registry.length > 5);
  configured = ETH_HEDGE;
  const disconnected = await createServerWith(undefined);
  assert.deepEqual([disconnected.intents.source, disconnected.intents.status], ["off", "off"]);
  assert.deepEqual(disconnected.plan!.moves.map(m => [m.status, m.blocked.map(b => b.code)]), [["blocked", ["no_quote"]]]);
  assert.ok(disconnected.registry.every(r => r.listed === null && r.priceUsd === null));
  const down = await createServerWith(off);
  assert.deepEqual([down.intents.status, down.intents.detail], ["unavailable", "NEAR Intents couldn't be reached"]);
  assert.deepEqual(down.plan!.moves.map(m => m.blocked.map(b => b.code)), [["no_quote"]]);
});

test("a move whose swap can't be built isn't executable: a mandate that doesn't compile against the book blocks it, said in the plan's notes", async () => {
  configured = { ...ETH_HEDGE, operatingCashMonths: 1 };
  const hedge = await read();
  const move = hedge.plan!.moves.find(m => m.to === "ETH")!;
  assert.deepEqual([move.status, move.canPropose, move.blocked.map(b => b.code)], ["blocked", false, ["invalid"]]);
  assert.ok(hedge.plan!.notes.some(n => /mandate doesn't compile.*at least 6 months of operating cash/.test(n)), hedge.plan!.notes.join(" | "));
  reset();
  assert.deepEqual((await propose({ requestId: "hedge-7", move: move.id })).body, { ok: false, kind: "refused", code: "move_not_available" });
  assert.deepEqual(creates(), []);
  configured = ETH_HEDGE;
});

/** The read with another provider, on a server of its own. */
test("a stabilization record that can't be read holds buys of new risk, as a raised level would: never planned as calm", async () => {
  reset();
  riskUnreadable = true;
  try {
    const hedge = await read();
    const move = hedge.plan!.moves.find(m => m.to === "ETH")!;
    assert.deepEqual([move.status, move.canPropose], ["blocked", false]);
    assert.ok(move.blocked.some(b => b.code === "risk_level"), JSON.stringify(move.blocked));
    assert.ok(hedge.plan!.notes.some(n => /couldn't be read/.test(n)), JSON.stringify(hedge.plan!.notes));
    assert.equal((await propose({ move: move.id, requestId: "r".repeat(32) })).body.code, "move_not_available");
    assert.equal(creates().length, 0);
  } finally { riskUnreadable = false; }
});

test("the hedge block's caps only tighten the mandate's: a looser one is ignored, so a mandate's 15% bridge cap still binds", async () => {
  reset();
  const before = configured;
  configured = { ...BASE, diversification: { sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
      venueCapsPct: { "near-intents": 50, "omft-ethereum": 15 } },
    hedge: { sleeves: [{ asset: "ETH", targetPct: 20, maxPct: 25 }], venueCapsPct: { "omft-ethereum": 100 } } };
  try {
    const hedge = await read();
    const move = hedge.plan!.moves.find(m => m.to === "ETH")!;
    assert.ok(move.blocked.some(b => b.code === "venue_cap"), JSON.stringify({ move, notes: hedge.plan!.notes }));
    assert.equal(move.canPropose, false);
  } finally { configured = before; }
});

async function createServerWith(intents: unknown) {
  const other = await testServer({ platform: fake.platform, wallets: [owner], ballastSettings: () => ETH_HEDGE, intents } as never);
  try {
    const response = await fetch(`${other.base}/api/agents/portfolio/hedge`, { headers: { cookie: await other.signIn(owner) } });
    return contract.hedgeRead.parse((await response.json() as any).value);
  } finally { other.server.close(); }
}

test("one executable move is proposed as an explicit swap, planned again on the server: recorded before and after, open for a day, nothing sent but the move's id", async () => {
  reset();
  const before = Date.now();
  const { status, body, text } = await propose({ requestId: "hedge-1", move: "rebalance:USDC>ETH" });
  assert.equal(status, 200, text);
  const { proposal } = contract.rebalanceMade.parse(body.value);
  assert.equal(proposal.requestId, "hedge-1");
  assert.ok(Date.parse(proposal.expiresAt) - before >= 24 * 3_600_000 - 1_000);
  const [made] = creates();
  const legs = JSON.parse(made!.slice(made!.indexOf("[")));
  assert.equal(legs.length, 1);
  assert.deepEqual([legs[0].from, legs[0].to, legs[0].amount], [USDC, ETH, "10000000000"], "10,000 USD of USDC at the platform's price of 1");
  assert.match(legs[0].minAmountOut, /^[1-9][0-9]+$/);
  assert.deepEqual(audited.map(e => [e.action, e.stage, e.subject]), [["propose", "attempt", "rebalance:USDC>ETH"], ["propose", "result", proposal.id]]);
});

test("a move that isn't executable now isn't proposed: not listed, unknown, or planned away; and a malformed request is refused unasked", async () => {
  reset();
  configured = GOLD_HEDGE;
  assert.deepEqual((await propose({ requestId: "hedge-2", move: "rebalance:USDC>XAUT" })).body, { ok: false, kind: "refused", code: "move_not_available" }, "XAUT isn't a platform asset");
  configured = ETH_HEDGE;
  assert.deepEqual((await propose({ requestId: "hedge-3", move: "rebalance:USDC>BTC" })).body, { ok: false, kind: "refused", code: "move_not_available" });
  assert.deepEqual((await propose({ requestId: "hedge-4", move: "hedge:wNEAR>ETH" })).body, { ok: false, kind: "refused", code: "move_not_available" }, "calm risk plans no hedge, so it can't be asked for");
  for (const body of [{}, { requestId: "ok" }, { move: "x" }, { requestId: "has space", move: "x" }, { requestId: "ok", move: "x", legs: [] }])
    assert.deepEqual((await propose(body)).body, { ok: false, kind: "refused", code: "bad_request" }, JSON.stringify(body));
  assert.deepEqual([creates(), audited], [[], []], "nothing reached the platform or the log");
});

test("a stale quote or a rate-limited NEAR Intents blocks the proposal even when the page showed it executable", async () => {
  reset();
  const staleStub = { ...stub, quote: async (who: string, r: any, t: any) => { const q = await stub.quote(who, r, t); return q.ok ? { ...q, value: { ...q.value, at: Date.now() - 10 * 60_000 } } : q; } };
  const other = await testServer({ platform: fake.platform, wallets: [owner], ballastSettings: () => ETH_HEDGE, intents: staleStub } as never);
  try {
    const cookieOther = await other.signIn(owner);
    const response = await fetch(`${other.base}/api/agents/portfolio/hedge/propose`, { method: "POST", headers: { cookie: cookieOther, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ requestId: "hedge-5", move: "rebalance:USDC>ETH" }) });
    assert.deepEqual(await response.json(), { ok: false, kind: "refused", code: "move_not_available" });
  } finally { other.server.close(); }
  assert.deepEqual(creates(), []);
});

test("someone else's agent is not_owner and nothing of NEAR Intents or the platform's overview is read", async () => {
  reset();
  assert.deepEqual((await get(intruderCookie)).body, { ok: false, kind: "not_owner" });
  assert.deepEqual((await propose({ requestId: "hedge-6", move: "rebalance:USDC>ETH" }, intruderCookie)).body, { ok: false, kind: "not_owner" });
  assert.ok(fake.calls.every(call => call.startsWith("identity ")), fake.calls.join());
  assert.equal(stubTokens(Date.now()).length > 0, true);
});

test("the assistant's hedge tool answers what the page shows, trimmed, and is a read: no proposal, no platform write", async () => {
  const { hedgeTool, HEDGE_TOOL } = await import("../src/hedge-tool.ts");
  reset();
  const out = await hedgeTool({ platform: fake.platform as never, organization: "owner--near", agent: "portfolio", who: "owner.near", settings: ETH_HEDGE, intents: stub, now: Date.now });
  assert.ok(!("error" in out));
  const content = (out as { content: { moves: { id: string; status: string }[]; registry: { symbol: string; platformCanTrade: boolean }[]; intents: { source: string } } }).content;
  assert.deepEqual(content.moves.map(m => [m.id, m.status]), [["rebalance:USDC>ETH", "executable"]]);
  assert.equal(content.registry.find(r => r.symbol === "XAUT")!.platformCanTrade, false);
  assert.equal(content.intents.source, "stub");
  assert.equal(HEDGE_TOOL.name, "get_hedge_plan");
  assert.deepEqual(HEDGE_TOOL.input_schema.properties, {});
  assert.deepEqual(creates(), []);
  const failed = await hedgeTool({ platform: { reads: { overview: async () => ({ ok: false, kind: "unavailable" }) } } as never, organization: "o", agent: "a", who: "x", settings: ETH_HEDGE, now: Date.now });
  assert.deepEqual(failed, { error: "the agent's overview couldn't be read, so the hedge can't be planned" });
});
