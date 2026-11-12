import { test } from "node:test";
import assert from "node:assert/strict";
import { votesText } from "../src/dao-votes-view.ts";

test("nothing is said until the DAO's proposal is filed", () => {
  assert.equal(votesText(undefined, [{ role: "council", threshold: "2" }]), null);
});

test("the approvals are listed beside the platform's threshold, quoted as given", () => {
  assert.equal(votesText(["alice.near", "bob.near"], [{ role: "council", threshold: "2" }]), "2 approved: alice.near, bob.near. Needed: 2 (council)");
  assert.equal(votesText([], [{ role: "council", threshold: "1/2" }, { role: "admins", threshold: "3" }]), "No member has approved yet. Needed: 1/2 (council); 3 (admins)");
});

test("without a threshold read, only the approvals are shown", () => {
  assert.equal(votesText(["alice.near"], undefined), "1 approved: alice.near");
  assert.equal(votesText(["alice.near"], []), "1 approved: alice.near");
});
