import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startAutopilot } from "../src/autopilot.js";
import { agentId } from "../src/env.js";
import { freshDirectory, offline } from "./fixtures/harness.js";

freshDirectory("scheduler-corruption");
test("damaged schedule history defers ticks without crashing or calling the provider", t => {
  const network = offline();
  t.after(() => network.mock.restore());
  const errors = t.mock.method(console, "error", () => {});
  mkdirSync(".inbox");
  writeFileSync(join(".inbox", `${agentId()}.jsonl`), "{broken}\n");
  t.mock.timers.enable({ apis: ["setInterval"] });
  startAutopilot();
  assert.doesNotThrow(() => t.mock.timers.tick(120_000));
  assert.equal(network.mock.callCount(), 0);
  assert.equal(errors.mock.callCount(), 2);
  assert.match(String(errors.mock.calls[0]?.arguments), /Scheduled tick deferred:.*history unavailable/);
});
