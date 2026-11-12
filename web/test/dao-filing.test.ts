import { test } from "node:test";
import assert from "node:assert/strict";
import { filedText, fileLabel, filesAndVotes, filingHeld, signerProblem } from "../src/dao-filing.ts";

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

const call = (methodName: string) => ({ params: { methodName } });

test("a filing votes when the platform added the member's approval (`act_proposal`), and the page words it so", () => {
  const filing = { actions: [call("add_proposal")] }, voting = { actions: [call("add_proposal"), call("act_proposal")] };
  assert.deepEqual([filesAndVotes(filing), filesAndVotes(voting)], [false, true]);
  assert.deepEqual([fileLabel(filing), fileLabel(voting)], ["File the DAO proposal", "File and vote"]);
  assert.equal(filedText(filing, "5:00 PM", "or the grant expires unsigned"), "Filed. The DAO's vote must pass by 5:00 PM, or the grant expires unsigned.");
  assert.equal(filedText(voting, "5:00 PM", "or the grant expires unsigned"),
    "Filed with your approval. If the DAO needs more votes, they must come by 5:00 PM, or the grant expires unsigned. Its status below says when it passes.");
});
