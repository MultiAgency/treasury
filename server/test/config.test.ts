import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig, Secret } from "../src/config.ts";

const env = {
  TREASURY_PLATFORM_ORIGIN: "https://platform.test/ignored/path",
  TREASURY_DEPLOYMENT: "treasury",
  TREASURY_CREDENTIAL_FILE: "/run/secrets/tap",
  TREASURY_PUBLIC_ORIGIN: "https://treasury.test",
  TREASURY_DATA_DIR: "/var/lib/treasury",
};

test("the configuration is checked at startup, with defaults for lifetimes and limits", () => {
  const { settings, secrets } = loadConfig(env);
  assert.equal(settings.TREASURY_PLATFORM_ORIGIN, "https://platform.test", "an origin, never a path");
  assert.equal(settings.SESSION_IDLE_MS, 30 * 60_000);
  assert.equal(settings.SESSION_MAX_MS, 12 * 60 * 60_000);
  assert.equal(settings.CHALLENGE_TTL_MS, 5 * 60_000);
  assert.equal(settings.CHALLENGES_PER_MINUTE, 10);
  assert.equal(secrets.FASTNEAR_API_KEY, undefined);
});

test("a missing or invalid setting stops startup, naming each one", () => {
  const { TREASURY_DEPLOYMENT: _, ...missing } = env;
  assert.throws(() => loadConfig({ ...missing, TREASURY_PUBLIC_ORIGIN: "not a url" }), (error: Error) =>
    /TREASURY_DEPLOYMENT/.test(error.message) && /TREASURY_PUBLIC_ORIGIN/.test(error.message));
  assert.throws(() => loadConfig({ ...env, SESSION_IDLE_MS: "50000000", SESSION_MAX_MS: "1000" }), /SESSION_IDLE_MS/);
});

test("a secret never prints: not as a string, in JSON or when inspected", () => {
  const { secrets } = loadConfig({ ...env, FASTNEAR_API_KEY: "fn_real_key" });
  assert.ok(secrets.FASTNEAR_API_KEY instanceof Secret);
  assert.equal(secrets.FASTNEAR_API_KEY.reveal(), "fn_real_key");
  for (const printed of [String(secrets.FASTNEAR_API_KEY), JSON.stringify(secrets), inspect(secrets), `${secrets.FASTNEAR_API_KEY}`])
    assert.ok(!printed.includes("fn_real_key"), printed);
});
