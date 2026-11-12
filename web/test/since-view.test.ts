import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_MS, lastVisit, rememberVisit, sinceFrom, sinceLines, summarize, visitKey } from "../src/since-view.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const memory = () => { const map = new Map<string, string>(); return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }; };
const name = (level: number) => `L${level}`;

test("the last visit is per account and agent, and a bad value is no visit", () => {
  const keep = memory();
  const key = visitKey("alice.near", "ballast");
  assert.notEqual(key, visitKey("bob.near", "ballast"));
  assert.equal(lastVisit(keep, key, NOW), null);
  rememberVisit(keep, key, NOW - HOUR);
  assert.equal(lastVisit(keep, key, NOW), NOW - HOUR);
  keep.map.set(key, "soon");
  assert.equal(lastVisit(keep, key, NOW), null, "not a time");
  keep.map.set(key, String(NOW + HOUR));
  assert.equal(lastVisit(keep, key, NOW), null, "a visit in the future is a wrong clock, not a visit");
});

test("storage that throws, or is missing, never breaks the page", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
  assert.equal(lastVisit(broken, "k", NOW), null);
  assert.doesNotThrow(() => rememberVisit(broken, "k", NOW));
  assert.equal(lastVisit(undefined, "k", NOW), null);
  assert.doesNotThrow(() => rememberVisit(undefined, "k", NOW));
});

test("without a visit the last seven days are summarized, and that is said", () => {
  assert.deepEqual(sinceFrom(null, NOW), { since: NOW - FALLBACK_MS, fallback: true });
  assert.deepEqual(sinceFrom(NOW - HOUR, NOW), { since: NOW - HOUR, fallback: false });
});

test("only what is after the last visit counts, and a time that can't be read is left out", () => {
  const summary = summarize({
    since: NOW - 5 * HOUR,
    runs: [{ at: ago(HOUR) }, { at: ago(4 * HOUR) }, { at: ago(6 * HOUR) }, { at: "not a time" }],
    proposals: [{ createdAt: ago(2 * HOUR) }, { createdAt: ago(9 * HOUR) }],
    assessments: [{ at: ago(3 * HOUR), level: 1 }, { at: ago(HOUR), level: 2 }, { at: ago(2 * HOUR), level: 3 }, { at: ago(10 * HOUR), level: 4 }],
  });
  assert.deepEqual(summary, { runs: 2, proposals: 1, assessments: 3, latestLevel: 2, highestLevel: 3 });
});

test("the lines say what happened in words, and nothing when nothing did", () => {
  assert.deepEqual(sinceLines({ runs: 0, proposals: 0, assessments: 0, latestLevel: null, highestLevel: null }, name), []);
  assert.deepEqual(sinceLines({ runs: 1, proposals: 1, assessments: 1, latestLevel: 0, highestLevel: 0 }, name),
    ["Autopilot ran 1 time.", "1 proposal was made.", "The risk was assessed 1 time; the latest is L0."]);
  assert.deepEqual(sinceLines({ runs: 4, proposals: 2, assessments: 3, latestLevel: 1, highestLevel: 3 }, name),
    ["Autopilot ran 4 times.", "2 proposals were made.", "The risk was assessed 3 times; the latest is L1, and it reached L3."]);
});
