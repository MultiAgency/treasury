import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifier, NOTIFY_TIMEOUT_MS } from "../src/notify.ts";

/** A notifier that records its stdin, arguments (after the record's path) and environment, as JSON in that path. */
const RECORD = `const chunks = []; process.stdin.on("data", c => chunks.push(c)).on("end", () => require("node:fs").writeFileSync(process.argv[1],
  JSON.stringify({ stdin: Buffer.concat(chunks).toString(), args: process.argv.slice(2), env: process.env })));`;
const node = (code: string, ...args: string[]): [string, ...string[]] => [process.execPath, "-e", code, ...args];
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "treasury-notify-")); dirs.push(dir); return dir; };

test("the proposal on stdin; no secret and no TREASURY_ setting in the notifier's environment", async () => {
  const secret = "fastnear_never_handed_on", saved = { key: process.env.FASTNEAR_API_KEY, file: process.env.TREASURY_CREDENTIAL_FILE };
  process.env.FASTNEAR_API_KEY = secret;
  process.env.TREASURY_CREDENTIAL_FILE = "/run/treasury/app-credential";
  try {
    const out = join(scratch(), "record.json"), proposal = { proposalId: "a".repeat(32), page: "https://treasury.test/agents/portfolio/proposals/x" };
    assert.deepEqual(await notifier(node(RECORD, out))(proposal), { ok: true });
    const record = readFileSync(out, "utf8"), { stdin, env } = JSON.parse(record) as { stdin: string; env: Record<string, string> };
    assert.deepEqual(JSON.parse(stdin), proposal);
    assert.ok(!record.includes(secret) && !record.includes("app-credential"), "no secret or credential path anywhere the notifier sees");
    assert.deepEqual(Object.keys(env).filter(name => name.startsWith("TREASURY_") || name.startsWith("FASTNEAR_")), []);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [name, value] of [["FASTNEAR_API_KEY", saved.key], ["TREASURY_CREDENTIAL_FILE", saved.file]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("run without a shell: arguments with shell syntax arrive literally, and nothing is interpreted", async () => {
  const dir = scratch(), out = join(dir, "record.json"), planted = join(dir, "planted");
  const literal = [`$(touch ${planted})`, `; touch ${planted}`, `\`touch ${planted}\``, "*", "a b", "$HOME", "'\""];
  assert.deepEqual(await notifier(node(RECORD, out, ...literal))({ proposalId: `$(touch ${planted})` }), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).args, literal);
  assert.ok(!existsSync(planted), "no shell ran");
});

test("a failing notifier is reported, not thrown: a non-zero exit with its stderr, or a command that can't start", async () => {
  assert.deepEqual(await notifier(node(`process.stderr.write("channel down"); process.exit(3)`))({}), { ok: false, error: "exited with 3: channel down" });
  const missing = await notifier(["treasury-notifier-that-does-not-exist"])({});
  assert.ok(!missing.ok && /ENOENT/.test(missing.error), JSON.stringify(missing));
  assert.deepEqual(await notifier(node(`process.exit(0)`))({ proposalId: "p" }), { ok: true }, "a notifier that ignores stdin still succeeds");
});

test("a hung notifier is killed at its timeout, 10s by default", { timeout: 5_000 }, async () => {
  assert.equal(NOTIFY_TIMEOUT_MS, 10_000);
  const hung = await notifier(node(`setInterval(() => {}, 1000)`), { timeoutMs: 300 })({});
  assert.deepEqual(hung, { ok: false, error: "timed out after 0.3s" });
});
