import { test } from "node:test";
import assert from "node:assert/strict";
import { readReceipt } from "../src/funding-receipt.ts";

test("an uncertain funding receipt survives reload without being promoted to success", () => {
  const receipt = { account: "owner.near", amount: "12", symbol: "USDC", address: "deposit", dao: false, at: "2026-11-12T12:00:00Z", state: "unknown" };
  const storage = { getItem: (key: string) => key === "agent-a" ? JSON.stringify(receipt) : null };
  assert.deepEqual(readReceipt("agent-a", storage), receipt);
  assert.equal(readReceipt("agent-b", storage), undefined);
});

test("unavailable, corrupt and invalid receipt storage does not break funding", () => {
  assert.equal(readReceipt("agent", undefined), undefined);
  assert.equal(readReceipt("agent", { getItem() { throw new Error("blocked"); } }), undefined);
  for (const value of ["{", "null", '{"state":"executed"}', '{"state":"unknown","dao":false}']) {
    assert.equal(readReceipt("agent", { getItem: () => value }), undefined);
  }
});
