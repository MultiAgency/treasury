import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreasuryRegistry } from "../src/gateway/treasury-registration.js";

test("interrupted registration before registry commit preserves child settings and owner records", () => {
  const root = mkdtempSync(join(tmpdir(), "treasury-interrupted-registration-"));
  try {
    const registry = new TreasuryRegistry(root, []);
    const first = registry.register("alice.near", "wallet");
    const settings = registry.entry(first).envFile!;
    writeFileSync(settings, "AUTOPILOT=off\nAGENT_ID=retained-offline-agent\n");
    const evidence = join(registry.directory(first), "retained-owner-record.json");
    writeFileSync(evidence, '{"stage":"submitted"}\n');
    // Model a crash with the initialized directory present but no registry commit.
    rmSync(join(root, "registry.json"));
    const restarted = new TreasuryRegistry(root, []);
    assert.deepEqual(restarted.register("alice.near", "wallet"), first);
    assert.equal(readFileSync(settings, "utf8"), "AUTOPILOT=off\nAGENT_ID=retained-offline-agent\n");
    assert.equal(readFileSync(evidence, "utf8"), '{"stage":"submitted"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
