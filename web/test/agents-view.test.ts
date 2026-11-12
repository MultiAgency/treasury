import { test } from "node:test";
import assert from "node:assert/strict";
import { whatIfProblems } from "../../packages/core/src/whatif.ts";
import { actionWords, statusLine, WHAT_IF_EVENTS, whatIfRequest, whatIfRows } from "../src/agents-view.ts";
import type { RiskHistory, RiskWhatIf } from "../src/proposals-api.ts";

const stress = (over: Partial<NonNullable<RiskWhatIf["result"]>["after"]> = {}) => ({ id: "x", label: "x", valueUsd: 100_000, lossUsd: 0, drawdownPct: 0, stableUsd: 60_000, runwayMonths: 30, floorUsd: 12_000, floorBreached: false, unfundedUsd: 0, tradable: true, reasons: [], ...over });

test("a what-if is asked only for a number in the range the core accepts, never for blank or out-of-range text", () => {
  assert.deepEqual(whatIfRequest("drop", "50"), { ok: true, request: { volatileDropPct: 50 } });
  assert.deepEqual(whatIfRequest("depeg", " 0.9 "), { ok: true, request: { stablePrice: 0.9 } });
  assert.deepEqual(whatIfRequest("outage", "7"), { ok: true, request: { venueOutageDays: 7 } });
  assert.deepEqual(whatIfRequest("spend", "2"), { ok: true, request: { spendFactor: 2 } });
  assert.deepEqual(whatIfRequest("stale", "1"), { ok: true, request: { staleDays: 1 } });
  for (const bad of ["", "  ", "abc", "NaN", "Infinity", "0", "101", "-5", "1e999"]) assert.equal(whatIfRequest("drop", bad).ok, false, JSON.stringify(bad));
  const refused = whatIfRequest("depeg", "2");
  assert.ok(!refused.ok && /1\.5/.test(refused.why));
});

test("every event the page offers names a field the server's request takes", () => {
  assert.deepEqual(WHAT_IF_EVENTS.map(event => event.field), ["volatileDropPct", "stablePrice", "venueOutageDays", "spendFactor", "staleDays"]);
  for (const event of WHAT_IF_EVENTS) assert.equal(whatIfRequest(event.id, event.start).ok, true, `${event.id}'s starting value is valid`);
});

test("fractional scenarios and boundaries accepted by the core remain valid in the form", () => {
  for (const event of WHAT_IF_EVENTS) {
    for (const value of [0.001, 0.5, event.max, 0, -0.5, event.max + 0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const request = { [event.field]: value };
      assert.equal(whatIfRequest(event.id, String(value)).ok, whatIfProblems(request).length === 0, `${event.id}: ${value}`);
    }
    for (const text of ["", "  ", "not a number"]) assert.equal(whatIfRequest(event.id, text).ok, false, `${event.id}: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(whatIfRequest("drop", "0"), { ok: false, why: "Enter a number above 0 and at most 100 (% in a day)." });
});

test("the result is today beside after, with the floor and trading said plainly and a loss shown", () => {
  const rows = whatIfRows({ basedOn: { at: "2026-11-06T12:00:00.000Z", seq: 9 }, label: "wNEAR falls 50%", now: stress(),
    after: stress({ valueUsd: 80_000, lossUsd: 20_000, drawdownPct: 20, runwayMonths: 15, floorBreached: true, tradable: false, unfundedUsd: 500 }) });
  const by = Object.fromEntries(rows.map(row => [row.term, row]));
  assert.deepEqual([by["Book value"]!.now, by["Book value"]!.after], ["$100,000.00", "$80,000.00"]);
  assert.match(by["Book value"]!.detail, /\$20,000\.00 lost, 20\.0%/);
  assert.deepEqual([by["Cash floor"]!.now, by["Cash floor"]!.after], ["Holds", "Breached"]);
  assert.deepEqual([by["Agent can trade"]!.now, by["Agent can trade"]!.after], ["Yes", "No"]);
  assert.match(by["Stablecoins left"]!.detail, /\$500\.00 of spend can't be paid/);
  assert.deepEqual([by.Runway!.now, by.Runway!.after], ["30.0 months", "15.0 months"]);
});

test("the status line says whether this server runs the agent and how often, and never claims it runs when it doesn't", () => {
  const history = (configured: boolean, intervalS: number | null): RiskHistory => ({ configured, intervalS, entries: [] });
  assert.deepEqual(statusLine(history(true, 300)), { running: true, text: "Assessing the book every 5 minutes, beside Ballast, within your signed limits." });
  assert.match(statusLine(history(true, 90)).text, /every 90 seconds/);
  assert.match(statusLine(history(true, null)).text, /on each watch tick/);
  const off = statusLine(history(false, null));
  assert.equal(off.running, false);
  assert.match(off.text, /isn't running the stabilization agent/);
});

test("recommendations read as words", () => {
  assert.deepEqual(actionWords(["hold-buys", "de-risk", "pause-autopilot", "recommend-freeze"]), ["Hold buys", "De-risk", "Pause autopilot", "Consider a freeze"]);
});
