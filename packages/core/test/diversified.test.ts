import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_REGISTRY, VENUE_IDS, type AssetEntry } from "../src/assets.ts";
import { compileMandate, mandateProblems, type Answers, type Mandate } from "../src/mandate.ts";
import { BRIDGE_CAP_PCT, diversificationPhases, rwaOn, stableSplitOn } from "../src/diversified.ts";

const answers: Answers = {
  monthlySpendUsd: 2_000, operatingCashMonths: 6, treasuryValueUsd: 100_000,
  volatileAssets: ["wNEAR", "ETH"], stablecoins: ["USDC"], destinations: ["ops.near"], approvers: ["alice.near"],
};
const compiled = (a: unknown, profile = "balanced"): Mandate => {
  const r = compileMandate(a, profile);
  return r.ok ? r.mandate : assert.fail(r.problems.join("; "));
};
const problems = (a: unknown, profile = "balanced") => {
  const r = compileMandate(a, profile);
  return r.ok ? assert.fail("expected a refusal") : r.problems.join(" | ");
};

test("one volatile asset and no terms: the two-asset mandate, with no diversification field at all", () => {
  const m = compiled({ ...answers, volatileAssets: ["wNEAR"] });
  assert.equal("diversification" in m, false);
});

test("two volatile assets get the profile's terms: even sleeves, the account at the ceiling, the bridge at half of it", () => {
  const d = compiled(answers).diversification ?? assert.fail("no terms");
  assert.deepEqual(d.classes, ["volatile", "stable"]);
  assert.deepEqual(d.sleeves, [{ asset: "wNEAR", targetPct: 20, minPct: 5, maxPct: 25 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }]);
  assert.deepEqual(d.venueCapsPct, { [VENUE_IDS.intents]: 50, [VENUE_IDS.omftEthereum]: BRIDGE_CAP_PCT.balanced });
  assert.deepEqual(d.classCapsPct, { volatile: 50, stable: 100 });
  assert.deepEqual(d.stableSplit, { USDC: 100 });
  assert.equal(stableSplitOn(d), false);
  assert.equal(rwaOn(d), false);
});

test("each profile caps the bridge at half its volatile ceiling", () => {
  assert.equal(compiled({ ...answers, operatingCashMonths: 9, approvers: ["a.near", "b.near"] }, "conservative").diversification?.venueCapsPct[VENUE_IDS.omftEthereum], 15);
  assert.equal(compiled(answers, "growth").diversification?.venueCapsPct[VENUE_IDS.omftEthereum], 35);
});

test("the owner's own caps replace the profile's, part by part", () => {
  const d = compiled({ ...answers, diversification: { venueCapsPct: { [VENUE_IDS.intents]: 40, [VENUE_IDS.omftEthereum]: 10 } } }).diversification;
  assert.deepEqual(d?.venueCapsPct, { [VENUE_IDS.intents]: 40, [VENUE_IDS.omftEthereum]: 10 });
  assert.equal(d?.sleeves.length, 2);
});

test("a compiled diversified mandate reads back clean", () => {
  assert.deepEqual(mandateProblems(compiled(answers)), []);
});

test("BTC can't be a sleeve: the platform doesn't list it", () => {
  assert.match(problems({ ...answers, volatileAssets: ["wNEAR", "BTC"] }), /sleeve BTC isn't among the platform's proposal assets/);
});

test("the reserve can't be split into a stablecoin the platform doesn't list", () => {
  assert.match(problems({ ...answers, stablecoins: ["USDC", "USDT"], diversification: { stableSplit: { USDC: 50, USDT: 50 } } }),
    /USDT isn't among the platform's proposal assets/);
});

test("terms that leave the profile are refused: sleeves off the weight, a cap over the ceiling, a bridge with no cap", () => {
  assert.match(problems({ ...answers, diversification: { sleeves: [{ asset: "wNEAR", targetPct: 30, minPct: 5, maxPct: 35 }, { asset: "ETH", targetPct: 20, minPct: 5, maxPct: 25 }] } }),
    /add to the profile's volatile weight, 40%/);
  assert.match(problems({ ...answers, diversification: { venueCapsPct: { [VENUE_IDS.intents]: 60, [VENUE_IDS.omftEthereum]: 25 } } }), /can't be over the mandate's venue limit of 50%/);
  assert.match(problems({ ...answers, diversification: { venueCapsPct: { [VENUE_IDS.intents]: 50 } } }), /Ethereum bridge \(omft\) is on a held asset's path and needs a cap/);
  assert.match(problems({ ...answers, diversification: { classCapsPct: { volatile: 70, stable: 100 } } }), /over the profile's ceiling of 50%/);
});

test("a volatile asset with no sleeve, or a sleeve for an asset the mandate doesn't name, is refused", () => {
  assert.match(problems({ ...answers, diversification: { sleeves: [{ asset: "wNEAR", targetPct: 40, minPct: 10, maxPct: 50 }] } }), /ETH is a volatile asset of the mandate with no sleeve/);
});

test("real-world assets need the owner's eligibility and the issuer's KYC before the class may be allowed", () => {
  const rwa = { classes: ["volatile", "stable", "rwa"], classCapsPct: { volatile: 50, stable: 100, rwa: 10 }, rwa: { eligible: false, kycVerified: false, maxPct: 10, cashHorizonDays: 30 } };
  const p = problems({ ...answers, diversification: rwa });
  assert.match(p, /eligible to hold them/);
  assert.match(p, /passed the issuer's KYC/);
  const d = compiled({ ...answers, diversification: { ...rwa, rwa: { eligible: true, kycVerified: true, maxPct: 10, cashHorizonDays: 30 } } }).diversification!;
  assert.equal(rwaOn(d), true);
});

test("stable must always be allowed: the cash floor is held in stablecoins", () => {
  assert.match(problems({ ...answers, diversification: { classes: ["volatile"], classCapsPct: { volatile: 50 } } }), /stable must be allowed/);
});

test("the read-back check catches terms changed after compiling", () => {
  const m = compiled(answers);
  const tampered = { ...m, diversification: { ...m.diversification!, venueCapsPct: { [VENUE_IDS.intents]: 50 } } };
  assert.match(mandateProblems(tampered).join(" "), /diversification: .*needs a cap/);
  assert.match(mandateProblems({ ...m, diversification: "all of it" }).join(" "), /diversification must be an object/);
  const bitcoin = { ...m, assets: { ...m.assets, volatile: ["wNEAR", "BTC"] }, diversification: { ...m.diversification!, sleeves: [m.diversification!.sleeves[0]!, { asset: "BTC", targetPct: 20, minPct: 5, maxPct: 25 }] } };
  assert.match(mandateProblems(bitcoin).join(" "), /BTC isn't among the platform's proposal assets/);
});

test("answers that aren't an object for the terms are refused, never defaulted", () => {
  assert.match(problems({ ...answers, diversification: "yes" }), /diversification must be an object/);
  assert.match(problems({ ...answers, diversification: { sleeves: null } }), /missing a field/);
});

test("the phase status says exactly what the platform blocks: two cross-chain majors, a second stablecoin, a listed T-bill", () => {
  const d = compiled(answers).diversification!;
  const status = diversificationPhases(d);
  // ETH is a cross-chain major; wNEAR is native, and BTC isn't a proposal asset, so phase 1 isn't met.
  assert.equal(status.phases[0].on, false);
  assert.match(status.phases[0].reasons.join(" | "), /phase 1 needs two cross-chain majors, and the mandate has 1/);
  assert.match(status.phases[0].reasons.join(" | "), /BTC isn't among the platform's proposal assets/);
  assert.equal(status.phases[1].on, false);
  assert.match(status.phases[1].reasons.join(" | "), /a second stablecoin needs the platform to list one \(USDT, USDC\.e/);
  assert.equal(status.phases[2].on, false);
  assert.match(status.phases[2].reasons.join(" | "), /doesn't allow real-world assets/);
  assert.match(status.phases[2].reasons.join(" | "), /no tokenized T-bill is among the platform's proposal assets/);
  // With no terms, every phase is off for the same reason: nothing is assumed from the profile.
  const none = diversificationPhases(null);
  assert.ok(none.phases.every(p => !p.on && p.reasons.some(r => /no diversification terms/.test(r))));
});

test("a read-back mandate with more than one volatile asset and no terms is refused: the compiler always writes them", () => {
  const m = compiled(answers);
  const { diversification: _d, ...twoAssetShape } = m;
  assert.match(mandateProblems(twoAssetShape).join(" "), /needs its diversification terms/);
});

test("allowing real-world assets needs a cap for every venue their registry paths cross", () => {
  const p = problems({ ...answers, volatileAssets: ["wNEAR"], diversification: {
    classes: ["volatile", "stable", "rwa"], classCapsPct: { volatile: 50, stable: 100, rwa: 10 },
    rwa: { eligible: true, kycVerified: true, maxPct: 10, cashHorizonDays: 30 },
  } });
  assert.match(p, /Ethereum bridge \(omft\) is on a held asset's path and needs a cap/);
});

test("once the platform lists a second stablecoin and a T-bill, phases 2 and 3 report on, and phase 1 still waits for BTC", () => {
  const base = compiled(answers).diversification!;
  // The day the platform lists them, stood in for by giving each the id of a proposal asset: only proposability changes.
  const { ETH: _eth, ...rest } = ASSET_REGISTRY;
  const listed: Record<string, AssetEntry> = {
    ...rest,
    USDT: { ...ASSET_REGISTRY.USDT!, id: ASSET_REGISTRY.ETH!.id },
    TBILL: { ...ASSET_REGISTRY.TBILL!, id: ASSET_REGISTRY.ETH!.id },
  };
  const terms = {
    ...base, stableSplit: { USDC: 50, USDT: 50 }, classes: ["volatile", "stable", "rwa"] as const,
    classCapsPct: { volatile: 50, stable: 100, rwa: 10 }, rwa: { eligible: true, kycVerified: true, maxPct: 10, cashHorizonDays: 30 },
    venueCapsPct: { ...base.venueCapsPct, [VENUE_IDS.omftEthereum]: 25 },
  };
  const status = diversificationPhases({ ...terms, classes: [...terms.classes] }, listed);
  assert.equal(status.phases[1].on, true);
  assert.equal(status.phases[2].on, true);
  assert.equal(status.phases[0].on, false, "BTC still isn't listed, so there is still one cross-chain major");
  assert.match(status.phases[0].reasons.join(" "), /BTC isn't among the platform's proposal assets/);
});
