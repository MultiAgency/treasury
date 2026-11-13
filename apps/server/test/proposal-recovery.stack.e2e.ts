import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { verifyPlatform, PLATFORM_COMMIT } from "../../../scripts/sdk-pin.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";
import { testChild } from "./test-process.ts";

const platform = resolve(process.env.TREASURY_PLATFORM ?? join(import.meta.dirname, "../../../../platform"));
const app = resolve(process.env.TREASURY_RECOVERY_APP ?? join(import.meta.dirname, ".."));

for (const boundary of ["before-id", "after-id"] as const) {
  test(`full servers: SIGKILL ${boundary}, then recover twice while frozen without another swap`, { timeout: 150_000 }, async t => {
    verifyPlatform(platform);
    const directory = tempDir(`treasury-proposal-${boundary}-`);
    const worker = testChild(t, ["--import", join(platform, "node_modules/tsx/dist/loader.mjs"),
      join(import.meta.dirname, "fixtures/proposal-recovery-worker.mjs"), boundary, platform, directory, app], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }, { messageMs: 135_000 });
    const evidence = await worker.next<{ boundary: string; sends: number; restarts: number; providerAlive: boolean }>();
    assert.equal((await worker.exit())[0], 0);
    assert.equal(evidence.boundary, boundary);
    assert.equal(evidence.sends, 1);
    assert.equal(evidence.restarts, 2);
    assert.equal(evidence.providerAlive, true);
    const output = resolve(import.meta.dirname, "../../../.test-artifacts/proposal-recovery");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, `${boundary}.json`), JSON.stringify({ platformCommit: PLATFORM_COMMIT,
      recordedAt: new Date().toISOString(), scope: "Real Treasury and platform server processes; synthetic provider held alive across SIGKILL; no mainnet settlement claim", ...evidence }, null, 2));
  });
}
