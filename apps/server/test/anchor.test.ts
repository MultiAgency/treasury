import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Secret } from "../src/config.ts";
import { ANCHOR_HEARTBEAT_MS, anchorDue, anchorKey, anchorOnce, checkAnchors, createAnchorer, jsonRpc, nearAnchorChain, readAnchorTx, recordedAnchors, runAnchor, type AnchorArgs, type AnchorChain, type AnchorEvent, type Rpc } from "../src/anchor.ts";
import { chainedFileAudit } from "../src/chain.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const H = "a".repeat(64);
const fresh = () => join(tempDir("anchor-"), "audit.jsonl");
const note = (n: number) => ({ kind: "note", text: `n${n}` });

/** A chain that keeps each anchor's arguments by a made-up transaction hash. */
function fakeChain(): AnchorChain & { sent: AnchorArgs[]; txs: Map<string, AnchorArgs> } {
  const txs = new Map<string, AnchorArgs>(), sent: AnchorArgs[] = [];
  return {
    account: "contextual.near", key: anchorKey("treasury"), sent, txs,
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
  const head = { seq: 3, hash: "c".repeat(64) };
  assert.equal(anchorDue({ seq: 0, hash: "0".repeat(64) }, undefined, Infinity), undefined);
  assert.deepEqual(anchorDue(head, undefined, 0), { args: { v: 1, ...head }, record: true });
});

test("an idle log repeats its last anchored head once a heartbeat has passed, unrecorded; a new record is anchored at once", () => {
  const last = { seq: 2, hash: "b".repeat(64), recordSeq: 3 };
  const idle = { seq: 3, hash: "c".repeat(64) };
  assert.equal(anchorDue(idle, last, ANCHOR_HEARTBEAT_MS - 1), undefined);
  assert.deepEqual(anchorDue(idle, last, ANCHOR_HEARTBEAT_MS), { args: { v: 1, seq: 2, hash: "b".repeat(64) }, record: false }, "the anchored head, not the anchor's own record");
  assert.deepEqual(anchorDue({ seq: 4, hash: "d".repeat(64) }, last, 0), { args: { v: 1, seq: 4, hash: "d".repeat(64) }, record: true });
});

test("the anchorer sends a heartbeat a day after the last send, keeps the log as it was, and counts from the heartbeat after that", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  let now = T0;
  const anchor = createAnchorer({ audit, file, chain, now: () => now });
  await audit.append(note(1));
  assert.deepEqual(await anchor(), { anchored: true, seq: 1, txHash: "tx1" });
  const logged = readFileSync(file, "utf8");
  now = T0 + ANCHOR_HEARTBEAT_MS - 1;
  assert.deepEqual(await anchor(), { anchored: false });
  now = T0 + ANCHOR_HEARTBEAT_MS;
  assert.deepEqual(await anchor(), { anchored: true, seq: 1, txHash: "tx2", repeat: true });
  assert.equal(readFileSync(file, "utf8"), logged, "a heartbeat isn't recorded");
  assert.deepEqual(chain.sent[1], chain.sent[0], "the same head, sent again");
  now += ANCHOR_HEARTBEAT_MS - 1;
  assert.deepEqual(await anchor(), { anchored: false }, "counted from the heartbeat, not the record");
  now += 1;
  assert.equal((await anchor() as { repeat?: true }).repeat, true);
  assert.equal((await anchorOnce({ now: () => now, audit, file, chain })).anchored, true, "after a restart, counted from the last anchor record");
  await audit.append(note(2));
  assert.deepEqual(await anchor(), { anchored: true, seq: 3, txHash: "tx5" });
  assert.deepEqual(await checkAnchors(readFileSync(file, "utf8"), chain), { ok: true, anchors: 2 });
});

test("the anchor's own record doesn't make the log need another anchor: nothing new, no transaction", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  assert.deepEqual(await anchorOnce({ now: () => T0, audit, file, chain }), { anchored: true, seq: 1, txHash: "tx1" });
  assert.deepEqual(await anchorOnce({ now: () => T0, audit, file, chain }), { anchored: false });
  assert.equal(chain.sent.length, 1);
  await audit.append(note(2));
  assert.equal((await anchorOnce({ now: () => T0, audit, file, chain })).anchored, true, "a new record needs a new anchor");
  assert.deepEqual(chain.sent.map(a => a.seq), [1, 3]);
});

test("only the sequence number and head hash go on chain, never an entry", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append({ kind: "note", text: "private detail" });
  await anchorOnce({ now: () => T0, audit, file, chain });
  assert.deepEqual(Object.keys(chain.sent[0]!).sort(), ["hash", "seq", "v"]);
  assert.equal(chain.sent[0]!.hash, JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).hash, "the hash of record 1, the head when anchored");
  assert.ok(!JSON.stringify(chain.sent).includes("private detail"));
});

test("the last anchor is found in the log after a restart", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ now: () => T0, audit, file, chain });
  assert.deepEqual(recordedAnchors(readFileSync(file, "utf8")).map(({ seq, recordSeq, key }) => ({ seq, recordSeq, key })), [{ seq: 1, recordSeq: 2, key: "audit/treasury" }]);
  const { audit: reopened } = await openLog(file);
  assert.deepEqual(await anchorOnce({ now: () => T0, audit: reopened, file, chain }), { anchored: false });
});

test("a failed send records nothing and anchors again next time; the chain's error reaches the caller", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  const failing = { ...chain, submit: async () => { throw new Error("rpc down"); } };
  await assert.rejects(anchorOnce({ now: () => T0, audit, file, chain: failing }), /rpc down/);
  assert.deepEqual(recordedAnchors(readFileSync(file, "utf8")), []);
  assert.equal((await anchorOnce({ now: () => T0, audit, file, chain })).anchored, true);
});

test("an intact log checks against its anchors", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  for (let i = 1; i <= 3; i++) { await audit.append(note(i)); await anchorOnce({ now: () => T0, audit, file, chain }); }
  assert.deepEqual(await checkAnchors(readFileSync(file, "utf8"), chain), { ok: true, anchors: 3 });
});

test("a log rebuilt after an anchor, with a different record before it, chains but fails the anchor check", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ now: () => T0, audit, file, chain });
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

test("a log cut back to before its last anchor fails against the anchors listed outside it, or one rewritten under them", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await audit.append(note(2));
  await anchorOnce({ now: () => T0, audit, file, chain });
  const listed = [...chain.txs].map(([txHash, args]) => ({ ...args, txHash }));
  assert.deepEqual(await checkAnchors(readFileSync(file, "utf8"), chain, listed), { ok: true, anchors: 1 });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  writeFileSync(file, `${lines.slice(0, 1).join("\n")}\n`);
  assert.deepEqual(await checkAnchors(readFileSync(file, "utf8"), chain, listed), { ok: false, reason: "the log ends at record 1, before record 2, anchored in tx1" });
  const rebuilt = fresh();
  const { audit: forged } = await openLog(rebuilt);
  await forged.append({ kind: "note", text: "altered" });
  await forged.append(note(2));
  assert.deepEqual(await checkAnchors(readFileSync(rebuilt, "utf8"), chain, listed), { ok: false, reason: "record 2 no longer has the hash anchored in tx1" });
});

test("an anchor the chain doesn't have, or has with other values, fails the check", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ now: () => T0, audit, file, chain });
  chain.txs.set("tx1", { ...chain.txs.get("tx1")!, seq: 9 });
  assert.match(String((await checkAnchors(readFileSync(file, "utf8"), chain) as { reason?: string }).reason), /names record 9/);
  chain.txs.delete("tx1");
  assert.match(String((await checkAnchors(readFileSync(file, "utf8"), chain) as { reason?: string }).reason), /isn't on chain under audit\/treasury/);
});

test("a log that records an anchor under another account or key fails the check without asking the chain", async () => {
  const { file, audit } = await openLog();
  const chain = fakeChain();
  await audit.append(note(1));
  await anchorOnce({ now: () => T0, audit, file, chain: { ...chain, key: "audit/staging" } });
  let reads = 0;
  const result = await checkAnchors(readFileSync(file, "utf8"), { ...chain, read: async hash => { reads++; return chain.read(hash); } });
  assert.match(!result.ok ? result.reason : "", /under contextual\.near audit\/staging, not contextual\.near audit\/treasury/);
  assert.equal(reads, 0);
});

test("each deployment anchors under its own key", () => {
  assert.equal(anchorKey("treasury"), "audit/treasury");
  assert.equal(anchorKey("staging"), "audit/staging");
});

test("the anchor loop anchors at once and then every interval, logs a failure instead of stopping, and ends on abort", async () => {
  const events: AnchorEvent[] = [], waits: number[] = [];
  const shutdown = new AbortController();
  let calls = 0;
  await runAnchor({
    anchor: async () => {
      calls++;
      if (calls === 2) throw new Error("rpc down");
      return calls === 1 ? { anchored: true, seq: 1, txHash: "tx1" } : { anchored: false };
    },
    everyMs: 3_600_000,
    log: event => events.push(event),
    sleep: async ms => { waits.push(ms); if (waits.length === 3) shutdown.abort(); },
    signal: shutdown.signal,
  });
  assert.deepEqual(events, [{ anchored: true, seq: 1, txHash: "tx1" }, { anchored: false, error: "Error: rpc down" }, { anchored: false }]);
  assert.deepEqual(waits, [3_600_000, 3_600_000, 3_600_000]);
});

test("an anchor in flight at shutdown finishes, and is logged, before the loop ends", async () => {
  const shutdown = new AbortController();
  const events: AnchorEvent[] = [];
  let finish!: () => void;
  const running = runAnchor({
    anchor: () => new Promise(resolve => { finish = () => resolve({ anchored: true, seq: 4, txHash: "tx4" }); }),
    everyMs: 60_000, log: event => events.push(event), sleep: async () => { throw new Error("no sleep after abort"); }, signal: shutdown.signal,
  });
  shutdown.abort();
  finish();
  await running;
  assert.deepEqual(events, [{ anchored: true, seq: 4, txHash: "tx4" }]);
});

// The `tx` answer the testnet RPC gave for the live run's second anchor (#55): `contextual.testnet` calling
// `__fastdata_kv` on itself with `{"audit/live-run": {"v":1,"seq":2,"hash":"dbd6…"}}`, signed with its function-call key.
const LIVE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "anchor-tx-testnet.json"), "utf8"));
const LIVE_TX = "6owZPqxSNU2rrTPg6gnCBVRn1kyAUUfzDB8n7PRi2YRc";
const LIVE_TARGET = { account: "contextual.testnet", key: "audit/live-run" };
const callArgs = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const withTx = (change: (tx: typeof LIVE) => void) => { const copy = structuredClone(LIVE); change(copy); return copy; };
const answering = (result: unknown): Rpc => async (method, params) => {
  assert.equal(method, "tx");
  assert.deepEqual(params, { tx_hash: LIVE_TX, sender_account_id: "contextual.testnet", wait_until: "NONE" }, "never waits on a transaction that may not exist");
  return result;
};

test("an anchor is read back from the transaction as the chain has it", async () => {
  assert.deepEqual(await readAnchorTx(answering(LIVE), LIVE_TARGET, LIVE_TX),
    { v: 1, seq: 2, hash: "dbd6aabdae9d111fe6d37795c0aa28834d3626dcefafdc5ae79f5110d5bd26cf" });
});

test("a transaction that isn't exactly a successful, final anchor of this account under this key reads as none", async () => {
  const anchor = { v: 1, seq: 2, hash: "d".repeat(64) };
  const cases: [string, unknown][] = [
    ["another key", withTx(tx => { tx.transaction.actions[0].FunctionCall.args = callArgs({ "audit/treasury": anchor }); })],
    ["a second key beside it", withTx(tx => { tx.transaction.actions[0].FunctionCall.args = callArgs({ "audit/live-run": anchor, other: 1 }); })],
    ["a value that isn't an anchor", withTx(tx => { tx.transaction.actions[0].FunctionCall.args = callArgs({ "audit/live-run": { ...anchor, extra: true } }); })],
    ["arguments that aren't JSON", withTx(tx => { tx.transaction.actions[0].FunctionCall.args = Buffer.from("{").toString("base64"); })],
    ["another method", withTx(tx => { tx.transaction.actions[0].FunctionCall.method_name = "treasury_audit_anchor"; })],
    ["a deposit", withTx(tx => { tx.transaction.actions[0].FunctionCall.deposit = "1"; })],
    ["a second action", withTx(tx => { tx.transaction.actions.push(tx.transaction.actions[0]); })],
    ["another signer", withTx(tx => { tx.transaction.signer_id = "someone.testnet"; })],
    ["another receiver", withTx(tx => { tx.transaction.receiver_id = "someone.testnet"; })],
    ["a failed call", withTx(tx => { tx.status = { Failure: { ActionError: {} } }; })],
    ["not yet final", withTx(tx => { tx.final_execution_status = "INCLUDED"; })],
  ];
  for (const [name, result] of cases) assert.equal(await readAnchorTx(answering(result), LIVE_TARGET, LIVE_TX), null, name);
});

test("a transaction the RPC doesn't know reads as none, and any other RPC failure throws instead", async () => {
  const rpcAnswering = (body: unknown, status = 200) => jsonRpc({ rpcUrl: "https://rpc.test", timeoutMs: 1000, fetch: async () => new Response(JSON.stringify(body), { status }) });
  const unknown = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, code: -32000, message: "Server error" } };
  assert.equal(await readAnchorTx(rpcAnswering(unknown), LIVE_TARGET, LIVE_TX), null);
  const timeout = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" }, message: "Server error" } };
  await assert.rejects(readAnchorTx(rpcAnswering(timeout), LIVE_TARGET, LIVE_TX), /TIMEOUT_ERROR/);
  await assert.rejects(readAnchorTx(rpcAnswering({}, 503), LIVE_TARGET, LIVE_TX), /503/);
  assert.deepEqual(await readAnchorTx(rpcAnswering({ jsonrpc: "2.0", id: 1, result: LIVE }), LIVE_TARGET, LIVE_TX), { v: 1, seq: 2, hash: "dbd6aabdae9d111fe6d37795c0aa28834d3626dcefafdc5ae79f5110d5bd26cf" });
});

test("a send that doesn't answer fails after its timeout instead of holding the loop", async () => {
  const server = createServer(() => {}); // accepts, never answers
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const chain = nearAnchorChain({ account: "contextual.testnet", key: "audit/treasury", signer: new Secret(`ed25519:${"3".repeat(88)}`),
      networkId: "testnet", send: { rpcUrl, headers: {} }, archival: { rpcUrl, headers: {} }, timeoutMs: 100, sendTimeoutMs: 200 });
    const started = Date.now();
    await assert.rejects(chain.submit({ v: 1, seq: 1, hash: H }), /didn't answer in 200 ms/);
    assert.ok(Date.now() - started < 5_000);
  } finally { server.closeAllConnections(); server.close(); }
});
