import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  ANCHOR_HEARTBEAT_MS, ANCHOR_NETWORKS, checkAnchors, isAnchorArgs, jsonRpc, readAnchorTx, recordedAnchors,
  type AnchorArgs, type AnchorNetwork, type AnchorTarget,
} from "./anchor.ts";
import { Secret } from "./config.ts";
import { rpcHeaders } from "./keys.ts";

// The outside check A7.3 needs (#55): it doesn't trust the server or its log. It reads every value FastData KV lists
// under the anchor key, confirms each one on chain by its transaction through an archival RPC, and fails when one isn't
// an anchor the chain confirms, when the sequence goes back or names one record with two hashes, or when the newest
// anchor is older than a heartbeat and two intervals, with room for the index's lag. Given a copy of the log, it also
// refuses a log that records an anchor outside the key's history, or that no longer has a record an anchor names. It
// runs on a schedule in GitHub Actions (`.github/workflows/anchor-check.yml`), away from the server.

/** How far FastData KV may lag the chain before a missing anchor counts: the live run (#55) saw under 12 s. */
export const INDEX_LAG_MS = 10 * 60_000;

/** How many transactions are read from the archival RPC at once. */
export const READS_AT_ONCE = 8;

/** `fn` over `items`, at most `limit` at a time, answering in the items' order. */
async function inOrder<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One value written under the key, as FastData KV lists it with `include_metadata`. */
export type KvEntry = {
  predecessor_id: string; current_account_id: string; signer_id?: string; key: string; value: unknown;
  tx_hash?: string; receipt_id?: string; block_height: number; block_timestamp: number;
};

/**
 * Every value written to `key` by `account` on itself, oldest first, from FastData KV's history, page by page. An answer
 * that isn't a page of entries throws, so an index that's down never reads as an empty history.
 */
export async function readKvHistory({ kvUrl, account, key, timeoutMs, fetch: send = fetch }: AnchorTarget & {
  kvUrl: string; timeoutMs: number; fetch?: typeof fetch;
}): Promise<KvEntry[]> {
  const entries: KvEntry[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await send(`${kvUrl}/v0/history/${account}/${account}`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ key, include_metadata: true, asc: true, limit: 200, ...(pageToken && { page_token: pageToken }) }),
    });
    if (!response.ok) throw new Error(`FastData KV answered ${response.status}`);
    const page = await response.json() as { entries?: unknown; page_token?: unknown };
    if (!Array.isArray(page.entries)) throw new Error("FastData KV's answer has no entries");
    entries.push(...page.entries as KvEntry[]);
    pageToken = page.entries.length > 0 && typeof page.page_token === "string" ? page.page_token : undefined;
    if (pageToken !== undefined && seen.has(pageToken)) throw new Error("FastData KV repeated a page");
    if (pageToken !== undefined) seen.add(pageToken);
  } while (pageToken !== undefined);
  return entries;
}

/** An anchor the history lists and the chain confirms. */
export type ListedAnchor = AnchorArgs & { txHash: string; blockHeight: number; at: number };

export type HistoryCheck = { problems: string[]; anchors: ListedAnchor[] };

/**
 * Checks the key's history: each entry is an anchor written by `account` on itself under `key`, with a transaction the
 * chain confirms holding the same anchor; sequence numbers never go back, and one sequence number has one hash (a
 * repeat of the same anchor, a heartbeat or a resend, is fine); the newest anchor is no older than `maxAgeMs`. No anchor
 * at all passes only within `maxAgeMs` of `since`, when anchoring began: after that, or with no `since`, an empty history
 * is a broken anchorer or a check pointed at the wrong account or key, and fails like a stale one. An RPC
 * that doesn't answer throws, so an outage never passes or fails as a finding.
 */
export async function checkHistory({ history, target, read, now, maxAgeMs, since }: {
  history: KvEntry[]; target: AnchorTarget; read: (txHash: string) => Promise<AnchorArgs | null>; now: number; maxAgeMs: number; since?: number;
}): Promise<HistoryCheck> {
  const problems: string[] = [], anchors: ListedAnchor[] = [];
  const { account, key } = target;
  const listed = (entry: KvEntry) => entry.predecessor_id === account && entry.current_account_id === account && entry.key === key
    && isAnchorArgs(entry.value) && entry.tx_hash ? entry.tx_hash : undefined;
  const onChain = await inOrder(history, READS_AT_ONCE, entry => { const tx = listed(entry); return tx ? read(tx) : Promise.resolve(null); });
  history.forEach((entry, i) => {
    const at = Math.floor(Number(entry.block_timestamp) / 1e6);
    const where = `the write at block ${entry.block_height}${entry.tx_hash ? ` (${entry.tx_hash})` : ""}`;
    if (entry.predecessor_id !== account || entry.current_account_id !== account || entry.key !== key)
      return void problems.push(`${where} is listed under ${entry.predecessor_id} → ${entry.current_account_id} ${entry.key}, not ${account} ${key}`);
    if (!isAnchorArgs(entry.value)) return void problems.push(`${where} isn't an anchor: ${JSON.stringify(entry.value)}`);
    if (!entry.tx_hash) return void problems.push(`${where} has no transaction to confirm it by`);
    const confirmed = onChain[i];
    if (!confirmed) return void problems.push(`${where} isn't a successful anchor on chain`);
    if (confirmed.seq !== entry.value.seq || confirmed.hash !== entry.value.hash)
      return void problems.push(`${where}: the chain has record ${confirmed.seq} ${confirmed.hash}, the index lists ${entry.value.seq} ${entry.value.hash}`);
    anchors.push({ ...confirmed, txHash: entry.tx_hash, blockHeight: entry.block_height, at });
  });
  const hashes = new Map<number, string>();
  let highest = 0;
  for (const anchor of anchors) {
    const known = hashes.get(anchor.seq);
    if (known !== undefined && known !== anchor.hash) problems.push(`record ${anchor.seq} was anchored with two hashes: ${known}, then ${anchor.hash} in ${anchor.txHash}`);
    if (anchor.seq < highest) problems.push(`the anchors went back from record ${highest} to ${anchor.seq} in ${anchor.txHash}`);
    hashes.set(anchor.seq, anchor.hash);
    highest = Math.max(highest, anchor.seq);
  }
  const newest = anchors.at(-1);
  if (newest === undefined) {
    if (since === undefined) problems.push(`no anchor is listed under ${account} ${key}, and ANCHOR_SINCE doesn't say when anchoring began`);
    else if (now - since > maxAgeMs) problems.push(`no anchor is listed under ${account} ${key}, though anchoring began ${new Date(since).toISOString()}`);
  }
  else if (now - newest.at > maxAgeMs)
    problems.push(`the newest anchor (${newest.txHash}, record ${newest.seq}) is ${Math.floor((now - newest.at) / 3_600_000)} h old: anchoring has stopped`);
  return { problems, anchors };
}

/**
 * Checks a copy of the log against the key's history: the log itself and each anchor it records, and each listed anchor
 * naming a record the log still has with that hash (`checkAnchors`, with the history as `listed`), and each anchor the
 * log records being one the history lists (a leaked key could write under another key). A log rewritten or cut short
 * after an anchor fails here even if it records none of the later anchors.
 */
export async function checkLog(text: string, { target, read, anchors }: {
  target: AnchorTarget; read: (txHash: string) => Promise<AnchorArgs | null>; anchors: ListedAnchor[];
}): Promise<string[]> {
  const checked = await checkAnchors(text, { ...target, read }, anchors);
  if (!checked.ok) return [checked.reason];
  const listed = new Set(anchors.map(anchor => anchor.txHash));
  return recordedAnchors(text).filter(anchor => !listed.has(anchor.txHash))
    .map(anchor => `the log records anchor ${anchor.txHash}, which isn't in ${target.account} ${target.key}'s history`);
}

/** The check's settings, from its environment: which network, account and key, and the server's anchor interval. */
export function checkSettings(env: NodeJS.ProcessEnv) {
  const network = (env.ANCHOR_NETWORK || "mainnet") as AnchorNetwork;
  if (!Object.hasOwn(ANCHOR_NETWORKS, network)) throw new Error(`ANCHOR_NETWORK: ${network} isn't mainnet or testnet`);
  const account = env.ANCHOR_ACCOUNT || (network === "testnet" ? "contextual.testnet" : "contextual.near");
  const key = env.ANCHOR_KEY || "audit/multiagency-treasury";
  const intervalS = Number(env.ANCHOR_INTERVAL_S || 3600);
  if (!Number.isSafeInteger(intervalS) || intervalS < 60) throw new Error("ANCHOR_INTERVAL_S: a whole number of seconds, at least 60");
  // The server sends at least once a heartbeat, on its first tick after; one failed tick is tried again the next.
  const maxAgeMs = ANCHOR_HEARTBEAT_MS + 2 * intervalS * 1000 + INDEX_LAG_MS;
  // When this deployment began anchoring: until then and for one allowance after, no anchor yet is a new deployment.
  const since = env.ANCHOR_SINCE ? Date.parse(env.ANCHOR_SINCE) : undefined;
  if (since !== undefined && (!Number.isFinite(since) || !/^\d{4}-\d{2}-\d{2}/.test(env.ANCHOR_SINCE!)))
    throw new Error(`ANCHOR_SINCE: ${env.ANCHOR_SINCE} isn't an ISO date`);
  const apiKey = env.FASTNEAR_API_KEY ? new Secret(env.FASTNEAR_API_KEY) : undefined;
  return { network, target: { account, key }, maxAgeMs, since, apiKey, ...ANCHOR_NETWORKS[network] };
}

/** Runs the check: exit 0 when it passes, 1 with each problem when it fails, 2 when it couldn't read what it needs. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, out: (line: string) => void, now = Date.now()): Promise<number> {
  const annotate = (line: string) => out(env.GITHUB_ACTIONS === "true" ? `::error::${line}` : `problem: ${line}`);
  let settings: ReturnType<typeof checkSettings>, log: string | undefined;
  try {
    settings = checkSettings(env);
    const { values } = parseArgs({ args: argv, options: { log: { type: "string" } } });
    log = values.log === undefined ? undefined : await readFile(values.log, "utf8");
  } catch (error) { annotate(`can't run: ${(error as Error).message}`); return 2; }
  const { target, network, kvUrl, archivalRpcUrl, maxAgeMs, since, apiKey } = settings;
  const rpc = jsonRpc({ rpcUrl: archivalRpcUrl, headers: rpcHeaders(archivalRpcUrl, apiKey), timeoutMs: 15_000 });
  // Each transaction is read once a run, though the history and a log's copy both name it.
  const reads = new Map<string, Promise<AnchorArgs | null>>();
  const read = (txHash: string) => { if (!reads.has(txHash)) reads.set(txHash, readAnchorTx(rpc, target, txHash)); return reads.get(txHash)!; };
  try {
    const history = await readKvHistory({ kvUrl, ...target, timeoutMs: 15_000 });
    const { problems, anchors } = await checkHistory({ history, target, read, now, maxAgeMs, since });
    if (log !== undefined) problems.push(...await checkLog(log, { target, read, anchors }));
    const newest = anchors.at(-1);
    out(`${network} ${target.account} ${target.key}: ${history.length} listed, ${anchors.length} confirmed on chain`
      + (newest ? `, newest record ${newest.seq} at ${new Date(newest.at).toISOString()} (${newest.txHash})` : "")
      + (log !== undefined ? ", log checked" : ""));
    for (const problem of problems) annotate(problem);
    return problems.length ? 1 : 0;
  } catch (error) {
    annotate(`can't run: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env, line => console.log(line));
