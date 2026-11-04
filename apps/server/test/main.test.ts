// The entry point as it runs: configuration into dependencies, and the server listening. Each case starts
// `node src/main.ts` as its own process, as `pnpm start` does.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const tap = `tap_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;

function environment(credentialMode = 0o600, audit?: string) {
  const dir = tempDir("treasury-main-"), credential = join(dir, "app-credential");
  writeFileSync(credential, tap, { mode: 0o600 });
  chmodSync(credential, credentialMode);
  return {
    PATH: process.env.PATH, PORT: "0",
    TREASURY_PLATFORM_ORIGIN: "https://platform.test", TREASURY_DEPLOYMENT: "treasury", TREASURY_CREDENTIAL_FILE: credential,
    TREASURY_PUBLIC_ORIGIN: "https://treasury.test", TREASURY_AUDIT_FILE: audit ?? join(dir, "audit.jsonl"),
    TREASURY_DAO_REQUESTS_FILE: join(dir, "dao-requests.json"),
  };
}

/**
 * Starts the entry point; answers its exit, and its first line of output once it's listening. The process is killed
 * when the test ends, whatever happens, so a failing assertion can't leave the test waiting on it.
 */
function start(t: TestContext, env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  // Its own deadline: a process that never exits would otherwise leave the test waiting forever, cancelled, not failed.
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("still running after 10 s")); }, 10_000);
    child.once("exit", code => { clearTimeout(deadline); resolve({ code, stderr }); });
  });
  const listening = Promise.race([
    new Promise<{ listening: number }>(resolve => child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.includes("\n")) resolve(JSON.parse(stdout.split("\n")[0]!));
    })),
    exited.then(({ code, stderr }) => { throw new Error(`exited ${code} before listening: ${stderr}`); }),
  ]);
  listening.catch(() => {}); // A test that only waits for the exit never reads this; the one that does still sees it fail.
  return { child, exited, listening };
}

test("a missing setting stops startup, naming it", async t => {
  const { TREASURY_DEPLOYMENT: _, ...env } = environment();
  const { code, stderr } = await start(t, env).exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /TREASURY_DEPLOYMENT/);
});

test("an audit trail it can't append to stops startup", async t => {
  const blocked = join(tempDir("treasury-audit-"), "file");
  writeFileSync(blocked, "");
  const { code } = await start(t, environment(0o600, join(blocked, "audit.jsonl"))).exited;
  assert.notEqual(code, 0, "its directory is a file");
});

test("a credential file others can read stops startup", async t => {
  const { code, stderr } = await start(t, environment(0o644)).exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /0600/);
});

test("with valid settings it listens, issues challenges for its own host, refuses other origins, and stops cleanly", async t => {
  const env = environment();
  const { child, exited, listening } = start(t, env);
  const base = `http://127.0.0.1:${(await listening).listening}`;
  const challenge = await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: "https://treasury.test", "content-type": "application/json" } });
  assert.equal(((await challenge.json()) as { value: { recipient: string } }).value.recipient, "treasury.test");
  const elsewhere = await fetch(`${base}/api/session/challenge`, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" } });
  assert.equal(elsewhere.status, 403);
  assert.equal(statSync(env.TREASURY_AUDIT_FILE).mode & 0o777, 0o600, "the audit trail it records to is ready, owner-only");
  child.kill("SIGTERM");
  assert.equal((await exited).code, 0, "a shutdown signal ends it cleanly");
});

/** An agents file for `watch` and a place for its stored requests, beside the rest of `env`. */
function withWatch(env: ReturnType<typeof environment>, agents: unknown[]) {
  const dir = tempDir("treasury-main-watch-"), file = join(dir, "watch.json");
  writeFileSync(file, JSON.stringify({ agents }), { mode: 0o600 });
  return { ...env, TREASURY_WATCH_FILE: file, TREASURY_REQUESTS_FILE: join(dir, "requests.json"), PLATFORM_TIMEOUT_MS: "500" };
}

test("watch agents past the read budget stop startup, naming the budget", async t => {
  const agents = Array.from({ length: 4 }, (_, i) => ({ organization: "owner--near", agent: `a${i}`, intervalS: 60 }));
  const { code, stderr } = await start(t, withWatch(environment(), agents)).exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /720 calls an hour/);
});

test("with watch configured it ticks each agent, logs each event as a line, and still stops cleanly", async t => {
  const env = withWatch(environment(), [{ organization: "owner--near", agent: "portfolio" }]);
  const { child, exited, listening } = start(t, env);
  let stdout = "";
  // Read from the start, so an event in the listening line's chunk isn't missed; with its own deadline.
  const event = new Promise<Record<string, unknown>>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no watch event after 8 s: ${stdout}`)), 8_000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const line = stdout.split("\n").find(text => text.includes("\"agent\":\"portfolio\""));
      if (line) { clearTimeout(deadline); resolve(JSON.parse(line)); }
    });
  });
  await listening;
  // The platform's host doesn't answer here: the tick's reads fail, and nothing is proposed.
  const logged = await event;
  assert.equal(logged.event, "watch");
  assert.equal(logged.organization, "owner--near");
  assert.ok(logged.failed, JSON.stringify(logged));
  child.kill("SIGTERM");
  assert.equal((await exited).code, 0);
});
