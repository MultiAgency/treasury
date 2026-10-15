import assert from "node:assert/strict";
import { test } from "node:test";
import { intentsAccount, validIntentsAccount } from "../src/intents-account.js";

test("near.com input becomes a bare account; ordinary accounts keep their case for validation", () => {
  for (const [input, expected] of [
    [" nearcom:Payee.near ", "payee.near"],
    ["NEARCOM:0x" + "AB".repeat(20), "0x" + "ab".repeat(20)],
    ["nearcom:" + "A".repeat(64), "a".repeat(64)],
    [" payee.near ", "payee.near"],
  ]) {
    assert.equal(intentsAccount(input!), expected);
    assert.ok(validIntentsAccount(intentsAccount(input!)));
  }
  for (const input of ["nearcom:", "nearcom:nearcom:payee.near", "nearcom:alice..near", "nearcom: alice.near", "nearcom:" + "a".repeat(65), "Alice.near", "https://near.com/payee"])
    assert.equal(validIntentsAccount(intentsAccount(input)), false, input);
});
