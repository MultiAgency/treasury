import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anchorOnce, checkAnchors, lastAnchor, needsAnchor, type AnchorArgs, type AnchorChain } from "../src/anchor.ts";
import { chainedFileAudit } from "../src/chain.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const fresh = () => join(tempDir("anchor-"), "audit.jsonl");
const note = (n: number) => ({ kind: "note", text: `n${n}` });

/** A chain that keeps each anchor's arguments by a made-up transaction hash. */
function fakeChain(): AnchorChain & { sent: AnchorArgs[]; txs: Map<string, AnchorArgs> } {
  const txs = new Map<string, AnchorArgs>(), sent: AnchorArgs[] = [];
  return {
    account: "anchor.near", sent, txs,
    async submit(args) { sent.push(args); const hash = `tx${sent.length}`; txs.set(hash, { ...args }); return hash; },
    async read(hash) { return txs.get(hash) ?? null; },
  };
}

async function openLog(file = fresh()) {
  const audit = chainedFileAudit<Record<string, unknown>>(file, () => T0);
  await audit.check();
  return { file, audit };
}

test("an empty log has nothing to anchor, and a log with records needs its first anchor", () => {
  assert.equal(needsAnchor({ seq: 0 }, undefined), false);
  assert.equal(needsAnchor({ seq: 3 }, undefined), true);
});

test("the anchor's own record doesn't make the log need another anchor: nothing new, no transaction", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  assert.deepEqual(await anchorOnce({ audit, file, chain }), { anchored: true, seq: 1, txHash: "tx1" });
  assert.deepEqual(await anchorOnce({ audit, file, chain }), { anchored: false });
  assert.equal(chain.sent.length, 1);
  await audit.append(note(2));
  assert.equal((await anchorOnce({ audit, file, chain })).anchored, true, "a new record needs a new anchor");
  assert.deepEqual(chain.sent.map(a => a.seq), [1, 3]);
});

test("only the sequence number and head hash go on chain, never an entry", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append({ kind: "note", text: "private detail" });
  await anchorOnce({ audit, file, chain });
  assert.deepEqual(Object.keys(chain.sent[0]!).sort(), ["hash", "seq", "v"]);
  assert.equal(chain.sent[0]!.hash, JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).hash, "the hash of record 1, the head when anchored");
  assert.ok(!JSON.stringify(chain.sent).includes("private detail"));
});

test("the last anchor is found in the log after a restart", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ audit, file, chain });
  assert.deepEqual(lastAnchor(readFileSync(file, "utf8")), { anchoredSeq: 1, recordSeq: 2 });
  const { audit: reopened } = await openLog(file);
  assert.deepEqual(await anchorOnce({ audit: reopened, file, chain }), { anchored: false });
});

test("a failed send records nothing and anchors again next time; the chain's error reaches the caller", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  const failing = { ...chain, submit: async () => { throw new Error("rpc down"); } };
  await assert.rejects(anchorOnce({ audit, file, chain: failing }), /rpc down/);
  assert.equal(lastAnchor(readFileSync(file, "utf8")), undefined);
  assert.equal((await anchorOnce({ audit, file, chain })).anchored, true);
});

test("an intact log checks against its anchors", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  for (let i = 1; i <= 3; i++) { await audit.append(note(i)); await anchorOnce({ audit, file, chain }); }
  assert.deepEqual(await checkAnchors(readFileSync(file, "utf8"), chain), { ok: true, anchors: 3 });
});

test("a log rebuilt after an anchor, with a different record before it, chains but fails the anchor check", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ audit, file, chain });
  // Rebuild the log from scratch with an altered first record, copying the anchor record's claim into a new chain.
  const rebuilt = fresh();
  const { audit: forged } = await openLog(rebuilt);
  await forged.append({ kind: "note", text: "altered" });
  const anchor = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[1]!).entry;
  await forged.append(anchor);
  const result = await checkAnchors(readFileSync(rebuilt, "utf8"), chain);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /no longer has the hash anchored/);
});

test("a log cut back to before its last anchor fails against the anchor known from outside", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await audit.append(note(2));
  await anchorOnce({ audit, file, chain });
  const known = chain.sent.at(-1)!;
  const lines = readFileSync(file, "utf8").trim().split("\n");
  writeFileSync(file, `${lines.slice(0, 1).join("\n")}\n`);
  const result = await checkAnchors(readFileSync(file, "utf8"), chain, known);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /ends before record 2/);
});

test("an anchor the chain doesn't have, or has with other values, fails the check", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ audit, file, chain });
  chain.txs.set("tx1", { ...chain.txs.get("tx1")!, seq: 9 });
  assert.match(String((await checkAnchors(readFileSync(file, "utf8"), chain) as { reason?: string }).reason), /names record 9/);
  chain.txs.delete("tx1");
  assert.match(String((await checkAnchors(readFileSync(file, "utf8"), chain) as { reason?: string }).reason), /isn't on chain/);
});
