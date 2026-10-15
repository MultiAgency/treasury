import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agreements, offerTerms } from "../src/agreements.js";
import { agentId } from "../src/env.js";
import { post, readInbox } from "../src/inbox.js";
import { freshDirectory } from "./fixtures/harness.js";

freshDirectory("record-corruption");

for (const directory of [".inbox", ".agreements"]) {
  for (const damaged of ['{broken}\n', 'null\n', '{}\n', '{"id":"torn']) {
    test(`${directory} reports damaged records instead of empty history: ${damaged.trim()}`, () => {
      mkdirSync(directory);
      writeFileSync(join(directory, `${agentId()}.jsonl`), damaged);
      assert.throws(() => directory === ".inbox" ? readInbox() : agreements(new Set()), /record.*line 1.*unavailable/i);
    });
  }
}

test("valid legacy inbox entries and agreement terms still round-trip", () => {
  const entry = post("warn", "Check this run");
  assert.deepEqual(readInbox(), [entry]);
  offerTerms({ payee: "example.near", amount: "1000000", note: "fixture", until: new Date("2099-01-01") });
  assert.equal(agreements(new Set())[0]?.terms?.maxAmount, "1000000");
});

test("invalid entry timestamps and numeric terms make history unavailable", () => {
  mkdirSync(".inbox");
  writeFileSync(join(".inbox", `${agentId()}.jsonl`), JSON.stringify({ id: "legacy", at: "bad date", level: "run", text: "run" }));
  assert.throws(readInbox, /record.*unavailable/i);
  mkdirSync(".agreements");
  writeFileSync(join(".agreements", `${agentId()}.jsonl`), JSON.stringify({ for: "legacy", terms: { maxAmount: "NaN", until: "2099-01-01T00:00:00Z" } }));
  assert.throws(() => agreements(new Set()), /record.*unavailable/i);
});
