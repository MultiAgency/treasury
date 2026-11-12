import { test } from "node:test";
import assert from "node:assert/strict";
import { votesText } from "../src/dao-votes-view.ts";

test("nothing is said until the DAO's proposal is filed", () => {
  assert.equal(votesText(undefined, [{ role: "council", threshold: "1/2 of the role" }]), null);
});

test("who approved is listed beside each role's threshold, quoted as the platform gives it", () => {
  assert.equal(votesText(["a.near", "b.near"], [{ role: "council", threshold: "1/2 of the role" }]), "Approved by a.near, b.near · council: 1/2 of the role");
  assert.equal(votesText([], [{ role: "council", threshold: "1/2 of the role" }, { role: "admins", threshold: "3" }]), "No approvals yet · council: 1/2 of the role · admins: 3");
});

test("without a threshold read, only who approved is shown", () => {
  assert.equal(votesText(["a.near"], undefined), "Approved by a.near");
  assert.equal(votesText(["a.near"], []), "Approved by a.near");
});
