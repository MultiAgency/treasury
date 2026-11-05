import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingsOf, recentActivity, recentRuns } from "../src/proposals/portfolio-view.ts";

const book = [
  { asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, public: "1", confidential: "123456789012345678901234567", price: 2.5, priceUpdatedAt: null, priceExpiresAt: null, usd: 308.64 },
  { asset: "nep141:usdc", symbol: "USDC", decimals: 6, public: "0", confidential: "0", price: 1, priceUpdatedAt: null, priceExpiresAt: null, usd: 0 },
];
const unmanaged = [{ asset: "nep141:usdt", symbol: "USDT", decimals: null, amount: "5000000", price: null, priceUpdatedAt: null, priceExpiresAt: null, usd: null }];

test("holdings add public and confidential exactly, past 2^53, and show an asset without decimals in raw units", () => {
  assert.deepEqual(holdingsOf({ book, unmanaged } as never), [
    { asset: "nep141:wrap.near", symbol: "wNEAR", amount: "123.456789012345678901234568", usd: 308.64, managed: true },
    { asset: "nep141:usdc", symbol: "USDC", amount: "0", usd: 0, managed: true },
    { asset: "nep141:usdt", symbol: "USDT", amount: "5000000 raw units", usd: null, managed: false },
  ]);
});

test("activity newest first, at most the limit; runs newest first, a run without an end reads as running", () => {
  const rows = ["2026-11-05T00:00:00Z", "2026-11-05T00:02:00Z", "2026-11-05T00:01:00Z"].map(at => ({ at, kind: "swap", request: {} }));
  assert.deepEqual(recentActivity(rows, 2).map(row => row.at), ["2026-11-05T00:02:00Z", "2026-11-05T00:01:00Z"]);
  const tick = (id: string, at: string, end: unknown) => ({ id, at, trigger: "schedule", end }) as never;
  const runs = recentRuns({ ticks: [tick("a", "2026-11-05T00:00:00Z", { outcome: "noop", plan: null }), tick("b", "2026-11-05T00:05:00Z", null),
    tick("c", "2026-11-05T00:03:00Z", { outcome: "executed", plan: { usd: 42.5 } })], corrupt: [] } as never, 10);
  assert.deepEqual(runs, [
    { id: "b", at: "2026-11-05T00:05:00Z", trigger: "schedule", outcome: "running", planUsd: null },
    { id: "c", at: "2026-11-05T00:03:00Z", trigger: "schedule", outcome: "executed", planUsd: 42.5 },
    { id: "a", at: "2026-11-05T00:00:00Z", trigger: "schedule", outcome: "noop", planUsd: null },
  ]);
});
