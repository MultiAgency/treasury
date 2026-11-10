import { test } from "node:test";
import assert from "node:assert/strict";
import { bookProblems, SCENARIO_DEFAULTS, scenarioParamsProblems, scenariosFor, stressAll, stressRun, termsProblems, type Book } from "../src/index.ts";
import { book, terms, USDC, WNEAR } from "./risk-fixtures.ts";

const run = (id: string, b: Book = book(), t = terms) => {
  const scenario = scenariosFor(b).find(s => s.id === id);
  assert.ok(scenario, `no scenario ${id}`);
  return stressRun(b, t, scenario);
};

test("the issue's scenarios come from the book: three falls per volatile asset, two prices per stable, two outages per venue, stale sources and spend at 2×", () => {
  assert.deepEqual(scenariosFor(book()).map(s => s.id), [
    `drop:${WNEAR}:30`, `drop:${WNEAR}:50`, `drop:${WNEAR}:80`, `depeg:${USDC}:0.95`, `depeg:${USDC}:0.9`,
    "venue:NEAR Intents:1d", "venue:NEAR Intents:7d", "sources-stale", "spend:2x",
  ]);
  // A second volatile asset at a second venue (#221) adds its own falls and outages, with nothing named in the code.
  const wider: Book = [...book(), { asset: "ETH", class: "volatile", usd: 10_000, venue: "Bridge" }];
  assert.equal(scenariosFor(wider).length, 9 + 3 + 2);
});

test("labels read the holding's symbol when it has one, and its asset when it doesn't", () => {
  const labels = scenariosFor(book()).map(s => s.label);
  assert.ok(labels.includes("wNEAR falls 30% in a day") && labels.includes("USDC trades at $0.95"), labels.join(" | "));
  assert.ok(labels.includes("NEAR Intents unavailable for 24 hours") && labels.includes("NEAR Intents unavailable for 7 days"));
  const bare: Book = [{ asset: "X", class: "volatile", usd: 1, venue: "v" }, { asset: "S", class: "stable", usd: 1, venue: "v" }];
  assert.equal(scenariosFor(bare)[0]!.label, "X falls 30% in a day");
});

test("a fall of 30, 50 and 80% loses that share of the volatile holding and leaves the stables, and the floor, as they were", () => {
  for (const [pct, loss] of [[30, 12_000], [50, 20_000], [80, 32_000]] as const) {
    const r = run(`drop:${WNEAR}:${pct}`);
    assert.deepEqual([r.lossUsd, r.drawdownPct, r.stableUsd, r.floorBreached, r.tradable], [loss, loss / 1_000, 60_000, false, true]);
    assert.equal(r.runwayMonths, 30);
  }
});

test("a stable at $0.95 or $0.90 loses 5 or 10% of the stables; the floor breaches only once they're under it, not at it", () => {
  assert.equal(run(`depeg:${USDC}:0.95`).stableUsd, 57_000);
  assert.equal(run(`depeg:${USDC}:0.9`).stableUsd, 54_000);
  // 13,334 × 0.90 = 12,000.6: just over the 12,000 floor. 13,333 × 0.90 = 11,999.7: under it.
  assert.equal(run(`depeg:${USDC}:0.9`, book(40_000, 13_334)).floorBreached, false);
  assert.equal(run(`depeg:${USDC}:0.9`, book(40_000, 13_333)).floorBreached, true);
  // Exactly at the floor holds: 20,000 × 0.90 = 18,000 against 3,000 a month for 6 months.
  assert.equal(run(`depeg:${USDC}:0.9`, book(40_000, 20_000), { monthlySpendUsd: 3_000, operatingCashMonths: 6 }).floorBreached, false);
});

test("a venue down for 24 hours or 7 days can't trade, and the spend due meanwhile goes unfunded when every stable is held there", () => {
  const day = run("venue:NEAR Intents:1d", book(), { monthlySpendUsd: 3_000, operatingCashMonths: 6 });
  assert.deepEqual([day.tradable, day.unfundedUsd, day.stableUsd, day.lossUsd], [false, 100, 59_900, 0]);
  const week = run("venue:NEAR Intents:7d", book(), { monthlySpendUsd: 3_000, operatingCashMonths: 6 });
  assert.deepEqual([week.tradable, week.unfundedUsd, week.stableUsd], [false, 700, 59_300]);
  // Stables at another venue pay what falls due while the first is down.
  const split: Book = [...book(40_000, 30_000), { asset: "USDT", class: "stable", usd: 30_000, venue: "Elsewhere" }];
  assert.equal(stressRun(split, terms, scenariosFor(split).find(s => s.id === "venue:NEAR Intents:7d")!).unfundedUsd, 0);
});

test("every price source stale moves no value, but nothing can trade", () => {
  const r = run("sources-stale");
  assert.deepEqual([r.lossUsd, r.drawdownPct, r.tradable, r.floorBreached], [0, 0, false, false]);
});

test("spend at 2× doubles the floor and halves the runway", () => {
  const r = run("spend:2x");
  assert.deepEqual([r.floorUsd, r.runwayMonths, r.floorBreached], [24_000, 15, false]);
  assert.equal(run("spend:2x", book(40_000, 23_999)).floorBreached, true);
});

test("the scenarios come most severe first: a breached floor, then the largest fall", () => {
  const order = stressAll(book(40_000, 12_500), terms).map(s => s.id);
  assert.deepEqual(order.slice(0, 3), [`depeg:${USDC}:0.9`, `depeg:${USDC}:0.95`, "spend:2x"], "the floor breaches under each of these");
  assert.equal(order[3], `drop:${WNEAR}:80`);
  assert.deepEqual(stressAll(book(), terms), stressAll(book(), terms), "the same book, the same run");
});

test("a book, spend terms or parameters that can't be read give one conservative result naming why, never an exception", () => {
  const bad: [unknown, string][] = [
    [[], "at least one holding"], [null, "at least one holding"],
    [[{ asset: WNEAR, class: "volatile", usd: Number.NaN, venue: "v" }, { asset: USDC, class: "stable", usd: 1, venue: "v" }], "holding 0"],
    [[{ asset: WNEAR, class: "volatile", usd: 1, venue: "v" }], "no stable asset"],
    [[...book(), book()[0]], "listed twice"],
    [[{ asset: WNEAR, class: "volatile", usd: 0, venue: "v" }, { asset: USDC, class: "stable", usd: 0, venue: "v" }], "worth nothing"],
    [[{ asset: WNEAR, class: "risky", usd: 1, venue: "v" }, { asset: USDC, class: "stable", usd: 1, venue: "v" }], "holding 0"],
  ];
  for (const [b, why] of bad) {
    const [only, ...rest] = stressAll(b as Book, terms);
    assert.equal(rest.length, 0);
    assert.deepEqual([only!.id, only!.floorBreached, only!.drawdownPct, only!.tradable], ["unreadable", true, 100, false]);
    assert.match(only!.reasons.join("; "), new RegExp(why), JSON.stringify(b));
    assert.ok(bookProblems(b).length > 0);
  }
  for (const t of [{ monthlySpendUsd: 0, operatingCashMonths: 6 }, { monthlySpendUsd: 2_000, operatingCashMonths: Number.NaN }, null]) {
    assert.equal(stressAll(book(), t as typeof terms)[0]!.id, "unreadable");
    assert.ok(termsProblems(t).length > 0);
  }
  for (const change of [{ volatileDropsPct: [100] }, { stablePrices: [1] }, { venueOutageDays: [0] }, { staleDays: -1 }, { spendFactor: 1 }]) {
    const params = { ...SCENARIO_DEFAULTS, ...change };
    assert.equal(scenarioParamsProblems(params).length, 1, JSON.stringify(change));
    assert.equal(stressAll(book(), terms, params)[0]!.id, "unreadable");
    assert.deepEqual(scenariosFor(book(), params), []);
  }
  const broken = stressRun(book(), terms, { id: "x", label: "x", shocks: [{ kind: "price", asset: WNEAR, factor: 0 }] });
  assert.deepEqual([broken.floorBreached, broken.reasons], [true, ["a price shock needs an asset and a factor above zero"]]);
  assert.equal(stressRun(book(), terms, { id: "y", label: "y", shocks: [{ kind: "meteor" } as never] }).reasons[0], "unknown shock");
});
