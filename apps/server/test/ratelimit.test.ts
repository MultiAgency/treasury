import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimit } from "../src/ratelimit.ts";

test("a limit counts requests per key over its window, a minute by default", () => {
  const clock = { now: 0 };
  const perMinute = createRateLimit({ limit: 2, now: () => clock.now });
  assert.deepEqual([perMinute("a"), perMinute("a"), perMinute("a"), perMinute("b")], [true, true, false, true]);
  clock.now += 60_001;
  assert.equal(perMinute("a"), true);
});

test("a window can be a day, for rare actions such as a new consent", () => {
  const clock = { now: 0 };
  const perDay = createRateLimit({ limit: 1, windowMs: 86_400_000, now: () => clock.now });
  assert.equal(perDay("owner.near"), true);
  clock.now += 23 * 3_600_000;
  assert.equal(perDay("owner.near"), false, "still within the day");
  clock.now += 3_600_001;
  assert.equal(perDay("owner.near"), true);
});

test("a limit says how long until a key's next request would be let through", () => {
  const clock = { now: 0 };
  const perMinute = createRateLimit({ limit: 2, now: () => clock.now });
  assert.equal(perMinute.waitMs("a"), 0, "nothing counted yet");
  perMinute("a");
  clock.now += 10_000;
  perMinute("a");
  assert.equal(perMinute.waitMs("a"), 50_000, "until the oldest counted request leaves the window");
  assert.equal(perMinute.waitMs("b"), 0, "per key");
  clock.now += 50_000;
  assert.equal(perMinute.waitMs("a"), 0);
});
