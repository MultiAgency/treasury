import { test } from "node:test";
import assert from "node:assert/strict";
import { leadTitle, leadWay, publicIsOther, receiveIsOther } from "../src/funding-view.ts";

test("a linked account leads with money in from it, and a confidential DAO with its confidential balance", () => {
  assert.equal(leadWay({ linked: true, confidential: false, canLink: true }), "account");
  assert.equal(leadWay({ linked: true, confidential: false, canLink: false }), "account", "a DAO can't change its account, but money in is still how it funds");
  assert.equal(leadWay({ linked: true, confidential: true, canLink: false }), "confidential");
});

test("with no account linked, linking leads when the owner may link, else the deposit address", () => {
  assert.equal(leadWay({ linked: false, confidential: false, canLink: true }), "link");
  assert.equal(leadWay({ linked: false, confidential: false, canLink: false }), "receive");
});

test("what is listed under Other ways follows the lead; shielding is never a way in", () => {
  assert.deepEqual((["confidential", "account", "link", "receive"] as const).map(receiveIsOther), [true, true, true, false]);
  assert.deepEqual((["confidential", "account", "link", "receive"] as const).map(publicIsOther), [true, false, false, false]);
});

test("the lead card is titled by its lead, and neutrally until the funding account is read", () => {
  assert.deepEqual((["confidential", "account", "link", "receive"] as const).map(leadTitle), ["Money in", "Money in", "Link a funding account", "Receive funds"]);
  assert.equal(leadTitle(undefined), "Money in", "never Link to an owner whose account isn't read yet");
});
