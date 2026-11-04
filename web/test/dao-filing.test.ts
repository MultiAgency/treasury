import { test } from "node:test";
import assert from "node:assert/strict";
import { filingHeld, signerProblem } from "../src/proposals/dao-filing.ts";

test("after a member files, the transaction isn't offered again until the offer changes, unless the wallet says it failed", () => {
  assert.equal(filingHeld(undefined), false, "nothing filed from this page yet");
  assert.equal(filingHeld("succeeded"), true, "filed: its proposal may not be readable yet, and a second filing is a second proposal");
  assert.equal(filingHeld("unknown"), true, "it may have gone out: the member checks the DAO's proposals first");
  assert.equal(filingHeld("failed"), false, "reverted whole: nothing was filed, so it may be filed again");
});

test("a member files only from the account they signed in as: another account in the wallet files nothing", () => {
  assert.equal(signerProblem("alice.near", "alice.near"), null);
  assert.equal(signerProblem("bob.near", "alice.near"), "Your wallet is connected as bob.near, but you signed in as alice.near. Nothing was filed. Switch the wallet to alice.near.");
  assert.equal(signerProblem(undefined, "alice.near"), "No wallet account is connected. Nothing was filed. Connect alice.near.");
});
