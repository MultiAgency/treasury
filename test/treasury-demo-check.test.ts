import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Treasury preflight discovers a registered agent without reading payout records or requiring a schedule", () => {
  const directory = mkdtempSync(join(tmpdir(), "treasury-preflight-"));
  try {
    const cookie = join(directory, "cookie"), preload = join(directory, "offline.mjs"), calls = join(directory, "calls.json");
    writeFileSync(cookie, "offline-fixture");
    writeFileSync(preload, `
      import { writeFileSync } from 'node:fs';
      const calls = [];
      globalThis.fetch = async (url) => {
        const path = new URL(url).pathname;
        calls.push(path); writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
        if (path === '/gw/me') return Response.json({agents:[{name:'t-fixture',area:'treasury'}],viewer:{account:'owner.near'}});
        if (!path.startsWith('/a/t-fixture/rpc/')) throw Error('Unexpected non-treasury request: ' + path);
        const values = {
          overview: {book:[{symbol:'USDC',asset:'usdc',decimals:6,confidential:'10000000',usd:10}],target:{usdc:1},rebalance:{minLegUsd:1},
            policy:{usage:{budget:{daily:{limit_usd:null,remaining_usd:null,spent_usd:'0',resets_at:null},weekly:{limit_usd:null,remaining_usd:null,spent_usd:'0',resets_at:null},monthly:{limit_usd:'100',remaining_usd:'90',spent_usd:'10',resets_at:null}}}}},
          'autopilot/get':{on:false,nextRun:null},
          unresolved:[],
        };
        const method = path.split('/rpc/')[1];
        if (!(method in values)) throw Error('Unexpected RPC: ' + method);
        return Response.json({json:values[method]});
      };
    `);
    const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
      ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/demo-check.ts", import.meta.url))],
      { encoding: "utf8", env: { ...process.env, DASHBOARD_URL: "https://offline.invalid", REPORT_COOKIE_FILE: cookie, ...extra }, timeout: 10_000 });
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Schedule off/);
    assert.match(result.stdout, /monthly budget left: \$90\.00/);
    assert.doesNotMatch(result.stdout, /Payout|invoice/);
    assert.deepEqual(new Set(JSON.parse(readFileSync(calls, "utf8"))), new Set([
      "/gw/me", "/a/t-fixture/rpc/overview", "/a/t-fixture/rpc/autopilot/get", "/a/t-fixture/rpc/unresolved",
    ]));
    const scheduled = run({ REPORT_REQUIRE_SCHEDULE: "true" });
    assert.equal(scheduled.status, 1, scheduled.stdout + scheduled.stderr);
    assert.match(scheduled.stdout, /FIX .*Schedule off/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
