import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANCHOR_HEARTBEAT_MS, anchorOnce, type AnchorArgs, type AnchorChain } from "../src/anchor.ts";
import { checkHistory, checkLog, checkSettings, INDEX_LAG_MS, main, readKvHistory, type KvEntry } from "../src/anchor-check.ts";
import { chainedFileAudit } from "../src/chain.ts";
import { tempDir } from "../../../scripts/temp-dirs.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const target = { account: "contextual.testnet", key: "audit/treasury" };
const H = (c: string) => c.repeat(64);
const MAX_AGE = ANCHOR_HEARTBEAT_MS + 2 * 3_600_000 + INDEX_LAG_MS;

/** An entry as FastData KV lists it with `include_metadata` (the shape the live run's anchors came back in, #55). */
const entry = (n: number, value: unknown, at = T0, extra: Partial<KvEntry> = {}): KvEntry => ({
  receipt_id: `r${n}`, tx_hash: `tx${n}`, signer_id: target.account, predecessor_id: target.account, current_account_id: target.account,
  block_height: 276_327_000 + n, block_timestamp: at * 1e6, key: target.key, value, ...extra,
});
const anchor = (seq: number, c: string): AnchorArgs => ({ v: 1, seq, hash: H(c) });
/** The chain: each listed transaction holds the entry's own value, unless told otherwise. */
const chainOf = (entries: KvEntry[], override: Record<string, AnchorArgs | null> = {}) =>
  async (txHash: string): Promise<AnchorArgs | null> => txHash in override ? override[txHash]! : (entries.find(e => e.tx_hash === txHash)?.value as AnchorArgs | undefined) ?? null;
const run = (history: KvEntry[], { now = T0, read = chainOf(history), since = undefined as number | undefined } = {}) => checkHistory({ history, target, read, now, maxAgeMs: MAX_AGE, since });

test("a history of anchors the chain confirms, in order and fresh, passes; a repeated anchor (a heartbeat) is fine", async () => {
  const history = [entry(1, anchor(1, "a")), entry(2, anchor(3, "b")), entry(3, anchor(3, "b"), T0 + ANCHOR_HEARTBEAT_MS)];
  const { problems, anchors } = await run(history, { now: T0 + ANCHOR_HEARTBEAT_MS });
  assert.deepEqual(problems, []);
  assert.deepEqual(anchors.map(a => [a.seq, a.txHash]), [[1, "tx1"], [3, "tx2"], [3, "tx3"]]);
});

test("a listed write the chain doesn't confirm fails: none on chain, other values, or no transaction to read", async () => {
  const history = [entry(1, anchor(1, "a")), entry(2, anchor(2, "b")), entry(3, anchor(3, "c"), T0, { tx_hash: undefined })];
  const { problems } = await run(history, { read: chainOf(history, { tx1: null, tx2: anchor(2, "f") }) });
  assert.deepEqual(problems, [
    "the write at block 276327001 (tx1) isn't a successful anchor on chain",
    `the write at block 276327002 (tx2): the chain has record 2 ${H("f")}, the index lists 2 ${H("b")}`,
    "the write at block 276327003 has no transaction to confirm it by",
    "no anchor is listed under contextual.testnet audit/treasury, and ANCHOR_SINCE doesn't say when anchoring began",
  ]);
});

test("a write under the key that isn't an anchor fails, as does an entry listed for another account or key", async () => {
  const history = [entry(1, { v: 1, seq: 1, hash: "nothex" }), entry(2, anchor(2, "b"), T0, { predecessor_id: "intruder.testnet" }), entry(3, anchor(3, "c"), T0, { key: "audit/staging" }), entry(4, anchor(4, "d"))];
  const { problems } = await run(history);
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /isn't an anchor/);
  assert.match(problems[1]!, /under intruder\.testnet → contextual\.testnet audit\/treasury, not contextual\.testnet audit\/treasury/);
  assert.match(problems[2]!, /audit\/staging, not contextual\.testnet audit\/treasury/);
});

test("anchors that go back, or name one record with two hashes, fail: the log was rewritten and anchored anew", async () => {
  const back = await run([entry(1, anchor(5, "a")), entry(2, anchor(3, "b"))]);
  assert.deepEqual(back.problems, ["the anchors went back from record 5 to 3 in tx2"]);
  const twice = await run([entry(1, anchor(5, "a")), entry(2, anchor(5, "b"))]);
  assert.deepEqual(twice.problems, [`record 5 was anchored with two hashes: ${H("a")}, then ${H("b")} in tx2`]);
});

test("the newest anchor may be a heartbeat, two intervals and the index's lag old; older, anchoring has stopped; none at all fails", async () => {
  const history = [entry(1, anchor(1, "a"))];
  assert.deepEqual((await run(history, { now: T0 + MAX_AGE })).problems, []);
  assert.deepEqual((await run(history, { now: T0 + MAX_AGE + 1 })).problems, ["the newest anchor (tx1, record 1) is 26 h old: anchoring has stopped"]);
  assert.deepEqual((await run([])).problems, ["no anchor is listed under contextual.testnet audit/treasury, and ANCHOR_SINCE doesn't say when anchoring began"]);
});

test("an RPC that doesn't answer stops the check instead of passing or failing an anchor", async () => {
  await assert.rejects(run([entry(1, anchor(1, "a"))], { read: async () => { throw new Error("RPC error TIMEOUT_ERROR"); } }), /TIMEOUT_ERROR/);
});

/** FastData KV, answering each request from `pages` in turn, and keeping the bodies it was sent. */
function kv(pages: unknown[], status = 200) {
  const sent: Record<string, unknown>[] = [], urls: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    urls.push(url);
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(pages[sent.length - 1] ?? { entries: [] }), { status });
  }) as typeof globalThis.fetch;
  return { fetch, sent, urls };
}

test("the history is read oldest first with each write's transaction, page by page until no page token is left", async () => {
  const index = kv([{ entries: [entry(1, anchor(1, "a"))], page_token: "p1" }, { entries: [entry(2, anchor(2, "b"))] }]);
  const history = await readKvHistory({ kvUrl: "https://kv.test.fastnear.com", ...target, timeoutMs: 1000, fetch: index.fetch });
  assert.deepEqual(history.map(e => e.tx_hash), ["tx1", "tx2"]);
  assert.deepEqual(index.urls, ["https://kv.test.fastnear.com/v0/history/contextual.testnet/contextual.testnet", "https://kv.test.fastnear.com/v0/history/contextual.testnet/contextual.testnet"]);
  assert.deepEqual(index.sent, [
    { key: "audit/treasury", include_metadata: true, asc: true, limit: 200 },
    { key: "audit/treasury", include_metadata: true, asc: true, limit: 200, page_token: "p1" },
  ]);
});

test("a token on an empty last page ends the history, as the live index answers; a repeated page or a failed answer throws", async () => {
  const live = kv([{ entries: [entry(1, anchor(1, "a"))], page_token: "p1" }, { entries: [], page_token: "p2" }]);
  assert.equal((await readKvHistory({ kvUrl: "https://kv", ...target, timeoutMs: 1000, fetch: live.fetch })).length, 1);
  assert.equal(live.sent.length, 2);
  const looping = kv([{ entries: [entry(1, anchor(1, "a"))], page_token: "p1" }, { entries: [entry(2, anchor(2, "b"))], page_token: "p1" }]);
  await assert.rejects(readKvHistory({ kvUrl: "https://kv", ...target, timeoutMs: 1000, fetch: looping.fetch }), /repeated a page/);
  await assert.rejects(readKvHistory({ kvUrl: "https://kv", ...target, timeoutMs: 1000, fetch: kv([{ error: "Internal error" }], 500).fetch }), /answered 500/);
  await assert.rejects(readKvHistory({ kvUrl: "https://kv", ...target, timeoutMs: 1000, fetch: kv([{ error: "bad" }]).fetch }), /has no entries/);
});

/** A log with anchors sent to a chain that remembers each, and the history FastData KV would list for them. */
async function anchoredLog(records: number) {
  const file = join(tempDir("anchor-check-"), "audit.jsonl");
  const audit = chainedFileAudit<Record<string, unknown>>(file, () => T0);
  await audit.check();
  const txs = new Map<string, AnchorArgs>();
  const chain: AnchorChain = { ...target, async submit(args) { const hash = `tx${txs.size + 1}`; txs.set(hash, { ...args }); return hash; }, read: async hash => txs.get(hash) ?? null };
  for (let i = 1; i <= records; i++) { await audit.append({ kind: "note", text: `n${i}` }); await anchorOnce({ now: () => T0, audit, file, chain }); }
  const history = [...txs].map(([hash, value], i) => entry(i + 1, value, T0, { tx_hash: hash }));
  const { anchors } = await run(history, { read: chain.read });
  return { file, chain, history, anchors, text: () => readFileSync(file, "utf8") };
}

test("a copy of the log that matches the history passes", async () => {
  const { chain, anchors, text } = await anchoredLog(3);
  assert.deepEqual(await checkLog(text(), { target, read: chain.read, anchors }), []);
});

test("a log cut short past an anchor fails, even with the anchors it no longer records gone too", async () => {
  const { file, chain, anchors, text } = await anchoredLog(2);
  const lines = text().trim().split("\n");
  writeFileSync(file, `${lines.slice(0, 2).join("\n")}\n`);
  assert.deepEqual(await checkLog(text(), { target, read: chain.read, anchors }), ["the log ends at record 2, before record 3, anchored in tx2"]);
});

test("a log that records an anchor outside the key's history is refused", async () => {
  const { chain, anchors, text } = await anchoredLog(2);
  assert.deepEqual(await checkLog(text(), { target, read: chain.read, anchors: anchors.slice(0, 1) }), ["the log records anchor tx2, which isn't in contextual.testnet audit/treasury's history"]);
});

test("a log rebuilt with a record changed before an anchor the history lists fails, though it chains", async () => {
  const { chain, anchors } = await anchoredLog(1);
  const rebuilt = join(tempDir("anchor-check-"), "audit.jsonl");
  const forged = chainedFileAudit<Record<string, unknown>>(rebuilt, () => T0);
  await forged.check();
  await forged.append({ kind: "note", text: "altered" });
  assert.deepEqual(await checkLog(readFileSync(rebuilt, "utf8"), { target, read: chain.read, anchors }), [`record 1 no longer has the hash anchored in tx1`]);
});

test("the settings default to contextual's account on the network and the deployment's key, and allow for a heartbeat", () => {
  const testnet = checkSettings({ ANCHOR_NETWORK: "testnet" });
  assert.deepEqual(testnet.target, { account: "contextual.testnet", key: "audit/multiagency-treasury" });
  assert.equal(testnet.kvUrl, "https://kv.test.fastnear.com");
  assert.equal(testnet.archivalRpcUrl, "https://archival-rpc.testnet.fastnear.com");
  assert.equal(testnet.maxAgeMs, MAX_AGE);
  assert.deepEqual(checkSettings({}).target, { account: "contextual.near", key: "audit/multiagency-treasury" });
  assert.equal(checkSettings({ ANCHOR_INTERVAL_S: "600" }).maxAgeMs, ANCHOR_HEARTBEAT_MS + 1_200_000 + INDEX_LAG_MS);
  assert.throws(() => checkSettings({ ANCHOR_NETWORK: "betanet" }), /ANCHOR_NETWORK/);
  assert.throws(() => checkSettings({ ANCHOR_NETWORK: "constructor" }), /ANCHOR_NETWORK/, "only the table's own networks");
  assert.throws(() => checkSettings({ ANCHOR_INTERVAL_S: "5" }), /ANCHOR_INTERVAL_S/);
});

test("the check can't run without readable settings or log, and says so as an error, with its own exit code", async () => {
  const lines: string[] = [];
  assert.equal(await main([], { ANCHOR_NETWORK: "betanet", GITHUB_ACTIONS: "true" }, line => lines.push(line)), 2);
  assert.equal(await main(["--log", join(tempDir("anchor-check-"), "missing.jsonl")], { ANCHOR_NETWORK: "testnet" }, line => lines.push(line)), 2);
  assert.match(lines[0]!, /^::error::can't run: ANCHOR_NETWORK/);
  assert.match(lines[1]!, /^problem: can't run: ENOENT/);
});

test("transactions are read a few at a time, and the findings keep the history's order", async () => {
  const history = Array.from({ length: 20 }, (_, i) => entry(i + 1, anchor(i + 1, "a")));
  let inFlight = 0, most = 0;
  const read = async (txHash: string) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 21 - Number(txHash.slice(2))));
    inFlight--;
    return txHash === "tx3" ? null : chainOf(history)(txHash);
  };
  const { problems, anchors } = await run(history, { read });
  assert.equal(most, 8);
  assert.deepEqual(anchors.map(a => a.seq), [1, 2, ...Array.from({ length: 17 }, (_, i) => i + 4)]);
  assert.deepEqual(problems, ["the write at block 276327003 (tx3) isn't a successful anchor on chain"]);
});

test("a run reads each transaction once, though the history and the log's copy both name it", async t => {
  const { file, chain, history } = await anchoredLog(3);
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("/v0/history/")) return Response.json({ entries: history });
    reads.push(body.params.tx_hash);
    const args = await chain.read(body.params.tx_hash);
    const call = { method_name: "__fastdata_kv", deposit: "0", args: Buffer.from(JSON.stringify({ [target.key]: args })).toString("base64") };
    return Response.json({ jsonrpc: "2.0", id: 1, result: { final_execution_status: "FINAL", status: { SuccessValue: "" },
      transaction: { signer_id: target.account, receiver_id: target.account, actions: [{ FunctionCall: call }] } } });
  });
  const lines: string[] = [];
  assert.equal(await main(["--log", file], { ANCHOR_NETWORK: "testnet", ANCHOR_KEY: target.key }, line => lines.push(line), T0), 0, lines.join("\n"));
  assert.deepEqual(reads.sort(), ["tx1", "tx2", "tx3"]);
  assert.match(lines[0]!, /3 listed, 3 confirmed on chain, newest record 5 .* log checked/);
});

test("no anchor yet passes within an allowance of ANCHOR_SINCE, a new deployment; after it, it fails as a broken anchorer or a wrong key", async () => {
  assert.deepEqual((await run([], { since: T0, now: T0 + MAX_AGE })).problems, []);
  assert.deepEqual((await run([], { since: T0, now: T0 + MAX_AGE + 1 })).problems,
    ["no anchor is listed under contextual.testnet audit/treasury, though anchoring began 2026-11-05T12:00:00.000Z"]);
  assert.deepEqual((await run([entry(1, anchor(1, "a"))], { since: T0, now: T0 + MAX_AGE + 1 })).problems,
    ["the newest anchor (tx1, record 1) is 26 h old: anchoring has stopped"], "once anchors exist, ANCHOR_SINCE plays no part");
  assert.equal(checkSettings({ ANCHOR_SINCE: "2026-11-05T12:00:00Z" }).since, T0);
  assert.equal(checkSettings({ ANCHOR_SINCE: "" }).since, undefined, "set to nothing counts as unset");
  assert.throws(() => checkSettings({ ANCHOR_SINCE: "yesterday" }), /ANCHOR_SINCE: yesterday isn't an ISO date/);
  assert.throws(() => checkSettings({ ANCHOR_SINCE: "5" }), /ANCHOR_SINCE/);
});
