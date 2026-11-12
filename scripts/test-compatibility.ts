import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPlatform, PLATFORM_COMMIT, SDK_SHA256 } from "./sdk-pin.ts";

if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Compatibility evidence requires Node 24");
const platform = process.env.TREASURY_PLATFORM;
if (!platform) throw new Error("Set TREASURY_PLATFORM to an isolated copy of the frozen platform source");
verifyPlatform(platform);
// Run the platform owner's existing offline gates against its isolated exact source. No platform implementation
// or journal reader is copied into Treasury; every state directory is synthetic and owned by that test run.
const tests = ["app-client-route.test.ts", "app-dao.test.ts", "market-binding-journal.test.ts",
  "market-binding-rollback.test.ts", "market-rollback.test.ts", "market-funding-proof.test.ts",
  "market-hire.test.ts", "market-deadline.test.ts", "market-signing-race.test.ts", "journal-history.test.ts"];
console.log(JSON.stringify({ offlineConsumerValidationOnly: true, releaseHold: true, platform: PLATFORM_COMMIT, sdkSha256: SDK_SHA256,
  testSources: Object.fromEntries(tests.map(file => [file,
    createHash("sha256").update(readFileSync(join(platform, "test", file))).digest("hex")])) }));
const result = spawnSync(process.execPath, ["scripts/test.mjs", "offline", ...tests], {
  cwd: platform, stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
