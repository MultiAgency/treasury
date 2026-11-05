import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig, Secret } from "../src/config.ts";

const env = {
  TREASURY_PLATFORM_ORIGIN: "https://platform.test/ignored/path",
  TREASURY_DEPLOYMENT: "treasury",
  TREASURY_CREDENTIAL_FILE: "/run/secrets/tap",
  TREASURY_PUBLIC_ORIGIN: "https://treasury.test",
  TREASURY_AUDIT_FILE: "/var/lib/treasury/audit.jsonl",
  TREASURY_DAO_REQUESTS_FILE: "/var/lib/treasury/dao-requests.json",
};

test("the configuration is checked at startup, with defaults for lifetimes and limits", () => {
  const { settings, secrets } = loadConfig(env);
  assert.equal(settings.TREASURY_PLATFORM_ORIGIN, "https://platform.test", "an origin, never a path");
  assert.equal(settings.SESSION_IDLE_MS, 30 * 60_000);
  assert.equal(settings.SESSION_MAX_MS, 12 * 60 * 60_000);
  assert.equal(settings.CHALLENGE_TTL_MS, 5 * 60_000);
  assert.equal(settings.CHALLENGES_PER_MINUTE, 10);
  assert.equal(settings.TREASURY_TRUSTED_PROXY_HOPS, 0, "no proxy is trusted unless configured");
  assert.equal(settings.OWNER_REQUESTS_PER_MINUTE, 60);
  assert.equal(settings.CONSENTS_PER_DAY, 5);
  assert.equal(settings.DAO_FILINGS_PER_DAY, 20);
  assert.equal(settings.DAO_READ_INTERVAL_MS, 60_000);
  assert.equal(settings.DAO_READS_PER_PASS, 5);
  assert.equal(secrets.FASTNEAR_API_KEY, undefined);
});

test("a variable set to nothing counts as unset, so its default applies rather than 0", () => {
  const { settings, secrets } = loadConfig({ ...env, PORT: "", TREASURY_TRUSTED_PROXY_HOPS: "", FASTNEAR_API_KEY: "" });
  assert.equal(settings.PORT, 8787);
  assert.equal(settings.TREASURY_TRUSTED_PROXY_HOPS, 0);
  assert.equal(loadConfig({ ...env, TREASURY_TRUSTED_PROXY_HOPS: "2" }).settings.TREASURY_TRUSTED_PROXY_HOPS, 2);
  assert.equal(secrets.FASTNEAR_API_KEY, undefined);
  assert.throws(() => loadConfig({ ...env, TREASURY_DEPLOYMENT: "" }), /TREASURY_DEPLOYMENT/, "a required one is still missing");
});

test("this server's origin must be https, except on localhost: the session cookie is Secure", () => {
  assert.throws(() => loadConfig({ ...env, TREASURY_PUBLIC_ORIGIN: "http://treasury.test" }), /TREASURY_PUBLIC_ORIGIN/);
  for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])
    assert.equal(loadConfig({ ...env, TREASURY_PUBLIC_ORIGIN: local }).settings.TREASURY_PUBLIC_ORIGIN, local);
  assert.equal(loadConfig({ ...env, TREASURY_PLATFORM_ORIGIN: "http://127.0.0.1:3000" }).settings.TREASURY_PLATFORM_ORIGIN, "http://127.0.0.1:3000", "the platform's may be http, as the stack is");
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

test("watch runs only when its agents' file is named, and then needs a file for its stored requests", () => {
  const { settings } = loadConfig(env);
  assert.equal(settings.TREASURY_WATCH_FILE, undefined, "off unless configured");
  assert.throws(() => loadConfig({ ...env, TREASURY_WATCH_FILE: "/etc/treasury/watch.json" }), /TREASURY_REQUESTS_FILE: required with TREASURY_WATCH_FILE/);
  const on = loadConfig({ ...env, TREASURY_WATCH_FILE: "/etc/treasury/watch.json", TREASURY_REQUESTS_FILE: "/var/lib/treasury/requests.json" }).settings;
  assert.equal(on.TREASURY_REQUESTS_FILE, "/var/lib/treasury/requests.json");
});

test("the audit anchor needs its account and its key file together, anchors hourly on mainnet by default, and its account must be on its network (#55)", () => {
  assert.equal(loadConfig(env).settings.TREASURY_ANCHOR_INTERVAL_S, 3600);
  assert.equal(loadConfig(env).settings.TREASURY_ANCHOR_NETWORK, "mainnet");
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "contextual.near" }), /set both or neither/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_KEY_FILE: "/k" }), /set both or neither/);
  const both = loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "contextual.near", TREASURY_ANCHOR_KEY_FILE: "/k" }).settings;
  assert.equal(both.TREASURY_ANCHOR_ACCOUNT, "contextual.near");
  const testnet = loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "contextual.testnet", TREASURY_ANCHOR_KEY_FILE: "/k", TREASURY_ANCHOR_NETWORK: "testnet" }).settings;
  assert.equal(testnet.TREASURY_ANCHOR_NETWORK, "testnet");
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "contextual.testnet", TREASURY_ANCHOR_KEY_FILE: "/k" }), /not an account on TREASURY_ANCHOR_NETWORK/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "contextual.near", TREASURY_ANCHOR_KEY_FILE: "/k", TREASURY_ANCHOR_NETWORK: "testnet" }), /not an account on TREASURY_ANCHOR_NETWORK/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_NETWORK: "betanet" }), /TREASURY_ANCHOR_NETWORK/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_ACCOUNT: "Not An Account", TREASURY_ANCHOR_KEY_FILE: "/k" }), /TREASURY_ANCHOR_ACCOUNT/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_INTERVAL_S: "5" }), /TREASURY_ANCHOR_INTERVAL_S/);
  assert.throws(() => loadConfig({ ...env, TREASURY_ANCHOR_INTERVAL_S: "86401" }), /TREASURY_ANCHOR_INTERVAL_S/, "at most the heartbeat's day, and well inside a timer's range");
});
