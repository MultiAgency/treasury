import { test } from "node:test";
import assert from "node:assert/strict";
import { creationReviews } from "../src/creation-reviews.ts";

test("unsigned creation snapshots are immutable, principal-bound, bounded, and pruned once expired by the next keep", () => {
  let now = Date.now();
  const store = creationReviews({ limit: 1, now: () => now });
  const value = { correlationId: "a", expiresAt: new Date(now + 60_000).toISOString(),
    intent: { standard: "nep413" as const, payload: { message: "original", recipient: "provider", nonce: "n" } },
    review: { agent: "portfolio", owner: "owner.near", host: "platform.test", publicKey: "key" } };
  store.keep("owner.near", "portfolio", value);
  value.intent.payload.message = "changed input";
  const first = store.get("owner.near", "portfolio", "a")!;
  assert.equal(first.intent!.payload.message, "original");
  first.intent!.payload.message = "changed output";
  store.keep("owner.near", "portfolio", value);
  assert.equal(store.get("owner.near", "portfolio", "a")!.intent!.payload.message, "original");
  assert.equal(store.get("other.near", "portfolio", "a"), undefined);
  assert.equal(store.get("owner.near", "other", "a"), undefined);
  store.keep("owner.near", "portfolio", { ...value, correlationId: "b" });
  assert.equal(store.get("owner.near", "portfolio", "a"), undefined, "old unsigned bytes are evicted at the bound");
  now += 60_001;
  assert.equal(store.get("owner.near", "portfolio", "b")?.correlationId, "b", "an expired one is still answered, so it reads expired, not lost");
  store.keep("owner.near", "portfolio", { ...value, correlationId: "c", expiresAt: new Date(now + 60_000).toISOString() });
  assert.equal(store.get("owner.near", "portfolio", "b"), undefined);
});
