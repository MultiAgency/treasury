import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { callsIn, daoCovers, inventory, scopesFor } from "../scripts/app-access-audit.ts";

test("the inventory handles multiline literal calls and deduplicates procedures", () => {
  assert.deepEqual(callsIn(`api.read(\n "overview", undefined);
    api.act("treasury/fund", input);
    api.stream("sweep", undefined, callback);
    api.read("overview", undefined);`), ["overview", "sweep", "treasury/fund"]);
});

test("execution needs both Treasury scopes, and deposit is under payout or treasury", () => {
  assert.deepEqual(scopesFor("executePlan"), ["treasury-execute"]);
  assert.deepEqual(scopesFor("deposit"), ["payout", "treasury"]);
  assert.deepEqual(scopesFor("setup"), []);
});

test("a DAO's consent reaches deposit and reconcileBooks, but not the treasury account's link or confidentiality", () => {
  assert.ok(daoCovers("deposit") && daoCovers("reconcileBooks") && daoCovers("autopilot/stop"));
  for (const procedure of ["treasury/link", "treasury/unlink", "treasury/setConfidential", "owner/prepare"])
    assert.ok(!daoCovers(procedure), procedure);
});

test("owner UI migration gaps are explicit; SDK or call-site changes require reviewing this list", () => {
  const calls = inventory(join(import.meta.dirname, "..", "src"));
  assert.ok(calls.has("overview") && calls.has("owner/prepare") && calls.has("sweep"));
  assert.deepEqual([...calls.keys()].filter(path => scopesFor(path).length === 0).sort(), [
    "recover", "setup", "treasury/fund",
  ]);
});
