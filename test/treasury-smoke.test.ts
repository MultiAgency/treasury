import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Treasury smoke works without an invoice host and preserves registered-agent snapshot identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "treasury-smoke-"));
  try {
    const cookie = join(directory, "cookie"), preload = join(directory, "offline.mjs"), snapshot = join(directory, "snapshot.json");
    writeFileSync(cookie, "offline-fixture");
    writeFileSync(preload, `
      globalThis.fetch = async (url, options = {}) => {
        const {host,pathname:path} = new URL(url);
        if (host !== 'offline.invalid') throw Error('Unexpected invoice/network host');
        if (path === '/health') return Response.json({ok:true});
        if (path === '/') return new Response('Treasury', {headers:Object.fromEntries(['strict-transport-security','x-frame-options','x-content-type-options','content-security-policy'].map(name=>[name,'fixture']))});
        if (path === '/gw/challenge') return Response.json({recipient:host});
        if (path === '/gw/me') return Response.json(options.headers?.cookie ? {agents:[{name:process.env.SMOKE_TEST_AGENT ?? 't-fixture',owner:'owner.near',dao:false}],viewer:{account:'owner.near',access:{}}} : {agents:[],viewer:null});
        if (path === '/gw/proposals') return new Response('',{status:401});
        if (path === '/gw/logout') return new Response('',{status:403});
        if (!path.startsWith('/a/t-fixture/rpc/')) throw Error('Unexpected agent: '+path);
        const method=path.split('/rpc/')[1];
        const values={overview:{digest:'fixture',grants:[]},'autopilot/get':{on:false,everyMin:60,maxUsd:1,lastRun:null},ledger:[]};
        if (!(method in values)) throw Error('Unexpected write/status request: '+method);
        return Response.json({json:values[method]});
      };
    `);
    const result = spawnSync(process.execPath,
      ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/smoke.ts", import.meta.url))],
      { encoding: "utf8", env: { ...process.env, DASHBOARD_URL: "https://offline.invalid", INVOICES_URL: "", SMOKE_COOKIE_FILE: cookie, SMOKE_SNAPSHOT: snapshot }, timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const recorded = JSON.parse(readFileSync(snapshot, "utf8"));
    assert.deepEqual(Object.keys(recorded), ["t-fixture"]);
    assert.equal(recorded['t-fixture'].digest, 'fixture');
    const second = spawnSync(process.execPath,
      ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/smoke.ts", import.meta.url))],
      { encoding: "utf8", env: { ...process.env, DASHBOARD_URL: "https://offline.invalid", INVOICES_URL: "", SMOKE_COOKIE_FILE: cookie, SMOKE_SNAPSHOT: snapshot }, timeout: 10_000 });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /snapshot agent identities kept/);
    assert.match(second.stdout, /t-fixture ledger kept/);
    const prior = JSON.stringify({ treasury: recorded['t-fixture'] });
    writeFileSync(snapshot, prior);
    const mismatch = spawnSync(process.execPath,
      ["--import", "tsx", "--import", preload, fileURLToPath(new URL("../src/smoke.ts", import.meta.url))],
      { encoding: "utf8", env: { ...process.env, DASHBOARD_URL: "https://offline.invalid", INVOICES_URL: "", SMOKE_COOKIE_FILE: cookie, SMOKE_SNAPSHOT: snapshot }, timeout: 10_000 });
    assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
    assert.match(mismatch.stdout, /FAIL snapshot agent identities kept/);
    assert.equal(readFileSync(snapshot, "utf8"), prior, 'agent identity mismatch must not rewrite retained evidence');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
