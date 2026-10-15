import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("demo preflight fails explicitly when a hosted valuation is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "demo-preflight-"));
  const cookie = join(directory, "cookie");
  const preload = join(directory, "offline.mjs");
  writeFileSync(cookie, "offline-fixture");
  writeFileSync(preload, `
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const overview = { book: [{ symbol: "USDC", asset: "usdc", decimals: 6, confidential: "10000000", usd: null }],
        target: { usdc: 1 }, rebalance: { minLegUsd: 1 }, policy: { usage: { budget: Object.fromEntries(["daily", "weekly", "monthly"].map(period => [period,
          { limit_usd: null, remaining_usd: null, spent_usd: "0", resets_at: null }])) } } };
      const value = path.endsWith("/overview") ? overview : path.endsWith("/held") ? [] :
        path.endsWith("/autopilot/get") ? { on: true, nextRun: "2030-01-01T00:00:00Z" } : undefined;
      if (value === undefined) throw new Error("Unexpected offline request");
      return Response.json({ json: value });
    };
  `);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/demo-check.ts", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, DASHBOARD_URL: "https://offline.invalid", REPORT_COOKIE_FILE: cookie }, timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Treasury valuation unavailable/);
  assert.doesNotMatch(result.stdout, /Treasury book \$0\.00|furthest from target/);
});
