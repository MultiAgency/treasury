import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiversificationRead } from "../src/server-api.ts";
import { holdingViews, phaseViews, sourceText, stableViews, venueViews } from "../src/diversification-view.ts";

const read: DiversificationRead = {
  source: "mandate", profile: "balanced",
  holdings: [
    { asset: "nep141:wrap.near", symbol: "wNEAR", class: "volatile", chain: "near", route: "native", venues: ["near-intents"], usd: 20_000, proposable: true },
    { asset: "nep141:btc.omft.near", symbol: "BTC", class: "volatile", chain: "btc", route: "omft", venues: ["near-intents", "omft-bitcoin"], usd: null, proposable: false },
    { asset: "nep141:unknown.near", symbol: "DOGE", class: null, chain: null, route: null, venues: [], usd: 10, proposable: false },
  ],
  venues: [
    { id: "near-intents", label: "NEAR Intents", kind: "account", exposureUsd: 20_000, capPct: 50, capSource: "mandate" },
    { id: "omft-bitcoin", label: "Bitcoin bridge (omft)", kind: "bridge", exposureUsd: null, capPct: null, capSource: "absent" },
  ],
  stablecoins: [{ symbol: "USDC", usd: 80_000, price: 0.97, sharePct: 100, targetPct: 100, peg: 3 }],
  phases: [
    { phase: 1, title: "Cross-chain majors through NEAR Intents", on: false, reasons: ["BTC isn't among the platform's proposal assets"] },
    { phase: 2, title: "Reserve split across stablecoins", on: false, reasons: ["a second stablecoin needs the platform to list one"] },
    { phase: 3, title: "Tokenized treasuries as a reserve sleeve", on: false, reasons: ["no tokenized T-bill is among the platform's proposal assets"] },
  ],
  notes: ["some holdings have no USD value"],
};

test("holdings say their class, platform status and venues, and an unknown one is never guessed", () => {
  const rows = holdingViews(read);
  assert.deepEqual(rows.map(r => [r.symbol, r.classText, r.platformText]), [
    ["wNEAR", "Volatile", "Tradable"], ["BTC", "Volatile", "Not listed"], ["DOGE", "Not in the registry", "Not listed"],
  ]);
  assert.equal(rows[1]!.venuesText, "near-intents, omft-bitcoin");
  assert.equal(rows[2]!.venuesText, "—");
});

test("venues show an unknown exposure as a dash, and where each cap came from", () => {
  const rows = venueViews(read);
  assert.deepEqual(rows.map(v => [v.id, v.exposureText, v.capText, v.capNote]), [
    ["near-intents", "$20,000", "50.0%", "from the configured terms"],
    ["omft-bitcoin", "—", "No cap", "no cap configured"],
  ]);
});

test("a stablecoin's peg level is words, not colour: on peg, L2 or L3", () => {
  assert.deepEqual(stableViews(read).map(s => [s.symbol, s.shareText, s.targetText, s.pegText, s.pegTone]), [["USDC", "100.0%", "100.0%", "L3 depeg", "destructive"]]);
  assert.equal(stableViews({ ...read, stablecoins: [{ ...read.stablecoins[0]!, price: 1, peg: 0 }] })[0]!.pegText, "On peg");
});

test("each phase carries a word and every reason, and the cap source is said in words", () => {
  assert.deepEqual(phaseViews(read).map(p => [p.phase, p.badge, p.reasons.length]), [[1, "Off", 1], [2, "Off", 1], [3, "Off", 1]]);
  assert.match(phaseViews(read)[0]!.reasonsText, /BTC isn't among/);
  assert.match(sourceText("mandate"), /configured mandate terms/);
  assert.match(sourceText("profile-defaults"), /profile's defaults/);
  assert.match(sourceText("absent"), /no caps are shown/);
});
