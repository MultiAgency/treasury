import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { OwnerOutput } from "@multiagency/sdk";
import * as contract from "../src/contract.ts";
import type { BallastSettings } from "../src/ballast.ts";
import { fakePlatform, wallet } from "./fakes.ts";
import { testServer } from "./test-server.ts";

const owner = wallet("owner.near"), intruder = wallet("intruder.near");
const fake = fakePlatform({ portfolio: "owner.near", theirs: "intruder.near" });
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR = "nep141:wrap.near", ETH = "nep141:eth.omft.near";
const now = Date.parse("2026-11-06T12:00:00.000Z");

/** 70,000 USDC, 15,000 wNEAR and 15,000 ETH: the multi-sleeve book the read describes. */
function bookOverview(): OwnerOutput<"overview"> {
  const row = (asset: string, symbol: string, decimals: number, price: number, usd: number) =>
    ({ asset, symbol, decimals, public: 0n, confidential: 0n, price, priceUpdatedAt: new Date(now - 60_000).toISOString(), priceExpiresAt: new Date(now + 240_000).toISOString(), usd });
  return {
    agentId: "id-portfolio", book: [row(USDC, "USDC", 6, 1, 70_000), row(WNEAR, "wNEAR", 24, 4, 15_000), row(ETH, "ETH", 18, 3.12, 15_000)],
    unmanaged: [], target: { [WNEAR]: 0.2, [ETH]: 0.2 }, rebalance: { minLegUsd: 1, maxCostBps: 50 }, policy: { policy: { assets: "any" } }, notInForce: null,
  } as unknown as OwnerOutput<"overview">;
}
const SETTINGS: BallastSettings = {
  profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"],
  diversification: {
    sleeves: [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }],
    venueCapsPct: { "near-intents": 50, "omft-ethereum": 25 },
  },
};

let server: Server, base: string, cookie: string, intruderCookie: string, signIn: Awaited<ReturnType<typeof testServer>>["signIn"], configured: BallastSettings | undefined = SETTINGS;

before(async () => {
  ({ server, base, signIn } = await testServer({ platform: fake.platform, wallets: [owner, intruder], ballastSettings: () => configured }));
  cookie = await signIn(owner);
  intruderCookie = await signIn(intruder);
  fake.reads.overview = bookOverview() as never;
});
after(() => server.close());

const get = async (path: string, as = cookie) => {
  const response = await fetch(`${base}${path}`, { headers: { cookie: as } });
  return { status: response.status, text: await response.clone().text(), body: await response.json() as any };
};
const path = "/api/agents/portfolio/diversification";

test("the route answers the book from its configured mandate terms: holdings, venues, caps, the stable split and the phases", async () => {
  fake.calls.length = 0;
  const { status, body, text } = await get(path);
  assert.equal(status, 200, text);
  const read = contract.diversificationRead.parse(body.value);
  assert.equal(read.source, "mandate");
  assert.equal(read.profile, "balanced");
  assert.deepEqual(read.holdings.map(h => [h.symbol, h.class, h.route, h.proposable]), [
    ["USDC", "stable", "native", true], ["wNEAR", "volatile", "native", true], ["ETH", "volatile", "omft", true],
  ]);
  assert.deepEqual(read.holdings.find(h => h.symbol === "ETH")!.venues, ["near-intents", "omft-ethereum"]);
  const intents = read.venues.find(v => v.id === "near-intents")!, bridge = read.venues.find(v => v.id === "omft-ethereum")!;
  assert.deepEqual([intents.exposureUsd, intents.capPct, intents.capSource], [30_000, 50, "mandate"]);
  assert.deepEqual([bridge.exposureUsd, bridge.capPct, bridge.capSource], [15_000, 25, "mandate"]);
  assert.deepEqual(read.stablecoins, [{ symbol: "USDC", usd: 70_000, price: 1, sharePct: 100, targetPct: 100, peg: 0 }]);
  // Phase 1 needs two cross-chain majors: ETH is one, wNEAR is native, BTC and SOL aren't listed. Phases 2 and 3 need the platform.
  assert.equal(read.phases.length, 3);
  assert.ok(read.phases.every(p => !p.on));
  assert.match(read.phases[0]!.reasons.join(" "), /BTC, SOL aren't among the platform's proposal assets/);
  assert.match(read.phases[1]!.reasons.join(" "), /second stablecoin/);
  assert.match(read.phases[2]!.reasons.join(" "), /no tokenized T-bill/);
  assert.equal(fake.calls.filter(call => call === "reads.overview owner--near portfolio").length, 1, "one overview read at most");
});

test("without a configured block the caps are the profile's defaults, said as such; without a profile there are none", async () => {
  configured = { profile: "balanced", monthlySpendUsd: 2_000, operatingCashMonths: 6, destinations: ["ops.near"], approvers: ["owner.near"] };
  const defaults = contract.diversificationRead.parse((await get(path)).body.value);
  assert.equal(defaults.source, "profile-defaults");
  assert.equal(defaults.venues.find(v => v.id === "near-intents")!.capSource, "profile-default");
  assert.ok(defaults.notes.some(note => /not signed terms/.test(note)));
  configured = undefined;
  const absent = contract.diversificationRead.parse((await get(path)).body.value);
  assert.equal(absent.source, "absent");
  assert.ok(absent.venues.every(v => v.capPct === null && v.capSource === "absent"));
  assert.ok(absent.notes.some(note => /no Ballast settings/.test(note)));
  configured = SETTINGS;
});

test("a book the registry doesn't know, or one without a USD value, makes the venue exposures unknown, never a partial total", async () => {
  const unknown = bookOverview();
  unknown.book.push({ asset: "nep141:doge.near", symbol: "DOGE", decimals: 6, public: 0n, confidential: 0n, price: 1, priceUpdatedAt: new Date(now).toISOString(), priceExpiresAt: null, usd: 5 });
  fake.reads.overview = unknown as never;
  const read = contract.diversificationRead.parse((await get(path)).body.value);
  assert.ok(read.venues.every(v => v.exposureUsd === null));
  assert.equal(read.holdings.find(h => h.symbol === "DOGE")!.class, null);
  assert.ok(read.notes.some(note => /aren't in the asset registry/.test(note)));
  fake.reads.overview = bookOverview() as never;
});

test("someone else's agent is not_owner and the platform's overview isn't read", async () => {
  fake.calls.length = 0;
  assert.deepEqual((await get(path, intruderCookie)).body, { ok: false, kind: "not_owner" });
  assert.ok(fake.calls.every(call => call.startsWith("identity ")), fake.calls.join());
});
