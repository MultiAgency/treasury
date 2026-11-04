import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_KINDS, canonicalJson, chainedFileAudit, GENESIS, recordHash, verifyChain } from "../src/chain.ts";
import { fileAudit, type Audit } from "../src/audit.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const open = (file: string, now?: () => number) => chainedFileAudit<Record<string, unknown>>(file, now);
const fresh = () => join(tempDir("chain-"), "nested", "audit.jsonl");
const T0 = Date.parse("2026-11-03T12:00:00Z");
const entry = (n: number) => ({ who: "owner.near", action: "consent" as const, agent: "portfolio", subject: `c${n}`, stage: "attempt" as const });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

test("canonical JSON is the same whatever the key order, and has no whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "é" } }), '{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', "undefined properties are left out, as in JSON");
  assert.equal(canonicalJson(-0), "0");
});

test("canonical JSON refuses what isn't plain data, so a hash never depends on how a value stringifies", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 10n, () => 1, Symbol("x"), new Date(0), new Map(), undefined])
    assert.throws(() => canonicalJson(bad), /canonicalJson/, String(bad));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /too deep/);
});

test("each record names the one before it, is flushed, and the file is owner-only", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  assert.deepEqual(audit.head(), { hash: GENESIS, seq: 0 });
  for (let i = 1; i <= 3; i++) await audit.append(entry(i));
  const records = lines(file).map(l => JSON.parse(l));
  assert.deepEqual(records.map(r => r.seq), [1, 2, 3]);
  assert.equal(records[0].prev, GENESIS);
  assert.equal(records[1].prev, records[0].hash);
  assert.equal(records[2].prev, records[1].hash);
  assert.equal(records[0].at, "2026-11-03T12:00:00.000Z");
  assert.deepEqual(audit.head(), { hash: records[2].hash, seq: 3 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(verifyChain(readFileSync(file, "utf8")), { ok: true, count: 3, head: records[2].hash, seq: 3, skipped: 0 });
});

test("a record's hash is over its canonical form, so it can be recomputed from the line", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await audit.append(entry(1));
  const r = JSON.parse(lines(file)[0]!);
  assert.equal(r.hash, recordHash({ seq: r.seq, at: r.at, prev: r.prev, entry: r.entry }));
});

test("the same entries at the same times give the same chain", async () => {
  const run = async () => { const f = fresh(); const a = open(f, () => T0); await a.check(); await a.append(entry(1)); await a.append(entry(2)); return a.head().hash; };
  assert.equal(await run(), await run());
});

test("changing a recorded entry is found at that record", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  for (let i = 1; i <= 3; i++) await audit.append(entry(i));
  const all = lines(file);
  all[1] = all[1]!.replace('"subject":"c2"', '"subject":"c9"');
  assert.deepEqual(verifyChain(all.join("\n")), { ok: false, line: 2, reason: "the record was changed: its hash doesn't match" });
});

test("removing, reordering or replaying a record breaks the chain", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  for (let i = 1; i <= 4; i++) await audit.append(entry(i));
  const [a, b, c, d] = lines(file) as [string, string, string, string];
  const broken = (ls: string[]) => { const v = verifyChain(ls.join("\n")); return v.ok ? "ok" : `${v.line}:${v.reason.split(" ")[0]}`; };
  assert.match(broken([a, c, d]), /^2:/, "a removed record");
  assert.match(broken([a, c, b, d]), /^2:/, "reordered records");
  assert.match(broken([a, b, b, c]), /^3:/, "a replayed record");
  assert.equal(broken([a, b, c, d]), "ok");
});

test("cutting the end off the log can't be seen from the log itself (the anchored head is what shows it)", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  for (let i = 1; i <= 3; i++) await audit.append(entry(i));
  const cut = lines(file).slice(0, 2).join("\n");
  const v = verifyChain(cut);
  assert.equal(v.ok && v.count, 2);
  assert.notEqual(v.ok && v.head, audit.head().hash, "…but its head no longer matches the one that was anchored");
});

test("a torn last line from a crash is skipped and counted, and the next record still chains", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await audit.append(entry(1));
  appendFileSync(file, '{"seq":2,"at":"2026-11-03T12:00:00.000Z","prev":"ab');
  const again = open(file, () => T0);
  await again.check();
  assert.equal(again.head().seq, 1);
  await again.append(entry(2));
  const v = verifyChain(readFileSync(file, "utf8"));
  assert.deepEqual([v.ok && v.count, v.ok && v.skipped], [2, 1]);
});

test("a reopened log continues from its head", async () => {
  const file = fresh();
  const first = open(file, () => T0);
  await first.check(); await first.append(entry(1)); await first.append(entry(2));
  const second = open(file, () => T0 + 1000);
  await second.check();
  assert.deepEqual(second.head(), first.head());
  await second.append(entry(3));
  const v = verifyChain(readFileSync(file, "utf8"));
  assert.deepEqual([v.ok && v.count, v.ok && v.seq], [3, 3]);
});

test("appends made at once are queued, so each names the one before and none is lost", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await Promise.all(Array.from({ length: 25 }, (_, i) => audit.append(entry(i))));
  const v = verifyChain(readFileSync(file, "utf8"));
  assert.deepEqual([v.ok && v.count, v.ok && v.seq], [25, 25]);
});

test("a failed append doesn't stop the ones behind it", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  const results = await Promise.allSettled([audit.append(entry(1)), audit.append({ ...entry(2), n: Number.NaN }), audit.append(entry(3))]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected", "fulfilled"]);
  const v = verifyChain(readFileSync(file, "utf8"));
  assert.deepEqual([v.ok && v.count, v.ok && v.seq], [2, 2], "the refused entry left no gap");
});

test("appending before check() is refused", async () => {
  const audit = open(fresh());
  await assert.rejects(audit.append(entry(1)), /check\(\)/);
  assert.throws(() => audit.head(), /check\(\)/);
});

test("an entry has no room for a credential, session or signature, by name or by shape", async () => {
  const audit = open(fresh(), () => T0);
  await audit.check();
  await assert.rejects(audit.append({ ...entry(1), signature: "x" }), /no field for a credential/);
  await assert.rejects(audit.append({ ...entry(1), answer: { sessionToken: "x" } }), /no field for a credential/);
  await assert.rejects(audit.append({ ...entry(1), note: "key tap_abcdefghijklmnop" }), /looks like a credential/);
  await assert.rejects(audit.append({ ...entry(1), note: "ed25519:" + "1".repeat(64) }), /looks like a credential/);
  await audit.append({ ...entry(1), signedTextSha256: "ab".repeat(32) }); // a hash of what was signed is fine
});

test("asset and PRNG fields are recorded: a token is an asset here and a seed is a PRNG's (#90)", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await audit.append({ kind: "order", token: "nep141:wrap.near", amount: "1" });
  await audit.append({ kind: "oracle", tokens: ["USDC"] });
  await audit.append({ kind: "fill", tokenIn: "USDC", tokenOut: "wNEAR" });
  await audit.append({ kind: "note", replay: { seed: 1, sources: ["a"] } });
  await audit.append({ kind: "note", seedSamples: 3 });
  const v = verifyChain(readFileSync(file, "utf8"));
  assert.equal(v.ok && v.count, 5);
});

test("credentials are refused by their exact names, in any case or separator, and as a name's ending (#90)", async () => {
  const audit = open(fresh(), () => T0);
  await audit.check();
  for (const key of ["signature", "credential", "secret", "password", "privateKey", "private_key", "cookie", "Authorization",
    "mnemonic", "seedPhrase", "seed_phrase", "apiKey", "api-key", "accessToken", "sessionToken", "refreshToken", "ownerSignature"])
    await assert.rejects(audit.append({ ...entry(1), [key]: "x" }), /no field for a credential/, key);
});

test("an append whose line reached the disk before it failed doesn't reuse its sequence number (#90)", async () => {
  const file = fresh();
  let failNext = false;
  const flaky = async (path: string, line: string) => {
    appendFileSync(path, `${line}\n`);
    if (failNext) { failNext = false; throw new Error("flush failed"); }
  };
  const audit = chainedFileAudit<Record<string, unknown>>(file, () => T0, flaky);
  await audit.check();
  await audit.append(entry(1));
  failNext = true;
  await assert.rejects(audit.append(entry(2)), /flush failed/);
  await audit.append(entry(3));
  assert.deepEqual(audit.head().seq, 3, "the head was read back from the file");
  const reopened = open(file);
  await reopened.check();
  assert.equal(reopened.head().seq, 3);
});

test("a newline in a value can't break the one-line-per-record format", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await audit.append({ ...entry(1), agent: "port\nfolio" });
  assert.equal(lines(file).length, 1);
  assert.equal(JSON.parse(lines(file)[0]!).entry.agent, "port\nfolio");
});

test("a log in the old plain format is refused at startup, not silently chained over", async () => {
  const file = fresh();
  const plain = fileAudit(file, () => T0);
  await plain.check();
  await plain.append({ who: "owner.near", action: "consent", agent: "portfolio", stage: "attempt" });
  await assert.rejects(open(file).check(), /broken at line 1: not a chained record/);
});

test("a log that was edited is refused at startup, and one others can read is too", async () => {
  const file = fresh();
  const audit = open(file, () => T0);
  await audit.check();
  await audit.append(entry(1));
  writeFileSync(file, readFileSync(file, "utf8").replace("owner.near", "intruder.near"), { mode: 0o600 });
  await assert.rejects(open(file).check(), /broken at line 1/);
  const other = fresh();
  await open(other).check();
  chmodSync(other, 0o644);
  await assert.rejects(open(other).check(), /0600/);
});

test("the kinds of record include consent and revocation, as asked on #53", () => {
  for (const k of ["mandate", "oracle", "proposal", "policy", "approval", "order", "fill", "level", "payout", "note", "anchor", "consent", "revocation"]) assert.ok((AUDIT_KINDS as readonly string[]).includes(k), k);
  assert.equal(new Set(AUDIT_KINDS).size, AUDIT_KINDS.length);
});

test("the chained store can stand in for fileAudit where the server takes an Audit", async () => {
  const file = fresh();
  const store = chainedFileAudit(file, () => T0);
  await store.check();
  const audit: Audit = store; // the same interface the server writes through
  await audit.append({ who: "owner.near", action: "revoke", agent: "portfolio", subject: "c1", stage: "result", answer: { ok: true } });
  assert.equal(lines(file).length, 1);
});
