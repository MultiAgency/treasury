import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { childEnv, loadConfig } from "../src/gateway/config.js";

test("distinct agent names cannot share a loopback port", () => {
  const file = join(mkdtempSync(join(tmpdir(), "port-config-")), "dashboard.json");
  for (const managed of [false, true]) {
    const agents = ["one", "two"].map(name => ({ name, owner: "owner.near", port: 8789,
      ...(managed && { envFile: `.env.${name}` }) }));
    writeFileSync(file, JSON.stringify({ host: "fixture.test", agents }));
    assert.throws(() => loadConfig(file), /ports must be unique/i);
    agents[1]!.port = 8790;
    writeFileSync(file, JSON.stringify({ host: "fixture.test", agents }));
    assert.equal(loadConfig(file).agents.length, 2);
  }
});

test("configured area survives parsing and is isolated from another agent's environment", () => {
  const file = join(mkdtempSync(join(tmpdir(), "area-config-")), "dashboard.json");
  writeFileSync(file, JSON.stringify({ host: "fixture.test", agents: [
    { name: "custom", area: "treasury", owner: "owner.near", envFile: ".env.custom", port: 8789 },
  ] }));
  const entry = loadConfig(file).agents[0]!;
  assert.equal((entry as { area?: string }).area, "treasury");
  assert.equal(childEnv({ ...entry, envFile: ".env.custom" }, { DASHBOARD_AREA: "payables" }).DASHBOARD_AREA, "treasury");
  assert.equal(childEnv({ name: "legacy", owner: "owner.near", executor: true, port: 8790, envFile: ".env.legacy" },
    { DASHBOARD_AREA: "payables" }).DASHBOARD_AREA, undefined);
  writeFileSync(file, JSON.stringify({ host: "fixture.test", agents: [
    { name: "custom", area: "typo", owner: "owner.near", port: 8789 },
  ] }));
  assert.throws(() => loadConfig(file), /area/);
});
