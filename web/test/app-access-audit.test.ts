import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { callsIn, inventory, scopesFor } from "../scripts/app-access-audit.ts";

test("the inventory handles multiline literal calls and deduplicates procedures", () => {
  assert.deepEqual(callsIn(`api.read(\n "overview", undefined);
    api.act("treasury/fund", input);
    api.stream("sweep", undefined, callback);
    api.read("overview", undefined);`), ["overview", "sweep", "treasury/fund"]);
});

test("execution needs both Treasury scopes and deposit needs payout consent", () => {
  assert.deepEqual(scopesFor("executePlan"), ["treasury-execute"]);
  assert.deepEqual(scopesFor("deposit"), ["payout"]);
  assert.deepEqual(scopesFor("setup"), []);
});

test("owner UI migration gaps are explicit; SDK or call-site changes require reviewing this list", () => {
  const calls = inventory(join(import.meta.dirname, "..", "src"));
  assert.ok(calls.has("overview") && calls.has("owner/prepare") && calls.has("sweep"));
  assert.deepEqual([...calls.keys()].filter(path => scopesFor(path).length === 0).sort(), [
    "reconcileBooks", "recover", "setup", "treasury/fund", "treasury/link", "treasury/setConfidential", "treasury/unlink",
  ]);
});
