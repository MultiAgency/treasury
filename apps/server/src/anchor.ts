import { open, readFile } from "node:fs/promises";
import { Near } from "near-kit";
import { Secret } from "./config.ts";
import { verifyChain, type ChainRecord } from "./chain.ts";

// A7.3 (#55): the audit log's head hash goes on NEAR once an hour, so a log that was cut short or rewritten after an
// anchor can be told apart from the one that was anchored. Only the sequence number and hash leave the machine; the
// entries stay here.
//
// The anchor is a FastData KV write: the anchor account calls `__fastdata_kv` on itself with
// `{"audit/<deployment>": {"v":1,"seq":<n>,"hash":"<64 hex>"}}`. The account's contract has that method, so the receipt
// succeeds and FastData's indexes keep every value written to the key, each with its transaction hash. It's signed with
// a function-call key limited to this receiver and method, which attaches no deposit, so the server holds no key that
// can move funds.

/** The method the anchor transaction names. The anchor key's permission is limited to it. */
export const ANCHOR_METHOD = "__fastdata_kv";

/** The FastData key a deployment's anchors are written under, so each deployment keeps its own history. */
export const anchorKey = (deployment: string) => `audit/${deployment}`;

/**
 * Each network's FastNEAR endpoints for anchors: the archival RPC anchors are read back from (a regular node forgets a
 * transaction after a few epochs, which would read as a missing anchor), FastData KV, which lists every value written to
 * a key, and on testnet the RPC a send goes to (on mainnet it's the server's own, `NEAR_RPC_URL` or FastNEAR's).
 */
export const ANCHOR_NETWORKS = {
  mainnet: { archivalRpcUrl: "https://archival-rpc.mainnet.fastnear.com", kvUrl: "https://kv.main.fastnear.com" },
  testnet: { rpcUrl: "https://rpc.testnet.fastnear.com", archivalRpcUrl: "https://archival-rpc.testnet.fastnear.com", kvUrl: "https://kv.test.fastnear.com" },
} as const;
export type AnchorNetwork = keyof typeof ANCHOR_NETWORKS;

/** What an anchor puts on chain: the format version, and the log's head when it was anchored. */
export type AnchorArgs = { v: 1; seq: number; hash: string };

/** How an anchor is recorded in the log itself, after its transaction is final. */
export type AnchorEntry = { kind: "anchor"; seq: number; hash: string; txHash: string; account: string; key: string };

/** Where anchors are written: the account that writes them to itself, and the key it writes under. */
export type AnchorTarget = { account: string; key: string };

/** The chain, as the anchor uses it: send the arguments and get the transaction's hash; read them back by that hash. */
export type AnchorChain = AnchorTarget & {
  /** Sends the anchor transaction and resolves with its hash once it, and its receipts, have succeeded in final blocks. */
  submit(args: AnchorArgs): Promise<string>;
  /** The anchor the chain has under that hash, or `null` if it has no such successful anchor of this account and key. */
  read(txHash: string): Promise<AnchorArgs | null>;
};

export const isAnchorArgs = (value: unknown): value is AnchorArgs =>
  typeof value === "object" && value !== null && Object.keys(value).length === 3 && (value as AnchorArgs).v === 1
  && Number.isSafeInteger((value as AnchorArgs).seq) && (value as AnchorArgs).seq > 0
  && typeof (value as AnchorArgs).hash === "string" && /^[0-9a-f]{64}$/.test((value as AnchorArgs).hash);

const isAnchorEntry = (entry: unknown): entry is AnchorEntry =>
  typeof entry === "object" && entry !== null && (entry as AnchorEntry).kind === "anchor";

const records = (text: string) => text.split("\n").flatMap(line => {
  try { return [JSON.parse(line) as ChainRecord]; } catch { return []; }
});

/** The anchors a log records, in order, with the sequence number and time of the record that says so. */
export function recordedAnchors(text: string): (AnchorEntry & { recordSeq: number; recordedAt: string })[] {
  return records(text).flatMap(record => isAnchorEntry(record.entry) ? [{ ...record.entry, recordSeq: record.seq, recordedAt: record.at }] : []);
}

/**
 * How long an idle log goes without an anchor: after a day with nothing recorded, the last anchored head is sent again,
 * unrecorded, so the outside check can tell a quiet deployment from one whose anchors stopped.
 */
export const ANCHOR_HEARTBEAT_MS = 24 * 3_600_000;

/**
 * What to anchor now: the head, when the log has records and something other than the last anchor's own record was
 * added since that anchor (without that rule, recording an anchor would make the log need another, every hour); else
 * the last anchored head again, when the last send is a heartbeat ago; else nothing.
 */
export function anchorDue(head: { seq: number; hash: string }, last: { seq: number; hash: string; recordSeq: number } | undefined,
  sinceSentMs: number): { args: AnchorArgs; record: boolean } | undefined {
  if (head.seq === 0) return undefined;
  if (last === undefined || head.seq > last.recordSeq) return { args: { v: 1, seq: head.seq, hash: head.hash }, record: true };
  return sinceSentMs >= ANCHOR_HEARTBEAT_MS ? { args: { v: 1, seq: last.seq, hash: last.hash }, record: false } : undefined;
}

export type AnchorAudit = { head(): { hash: string; seq: number }; append(entry: AnchorEntry): Promise<void> };

export type AnchorResult = { anchored: false } | { anchored: true; seq: number; txHash: string; repeat?: true };

/**
 * The anchorer: each call sends one anchor if one is due (`anchorDue`). A new head goes on chain, then the log records
 * the transaction. If the log can't record it, or the answer to the send is lost, the anchor may still be on chain, and
 * the next run anchors the same head again: a repeated anchor, never a wrong one. A heartbeat repeats the last anchored
 * head and isn't recorded; when it was sent is kept here, and after a restart it's the last anchor record's time.
 */
export function createAnchorer({ audit, file, chain, now = Date.now }: { audit: AnchorAudit; file: string; chain: AnchorChain; now?: () => number }) {
  let repeatedAt = -Infinity;
  return async (): Promise<AnchorResult> => {
    const last = recordedAnchors(await readFile(file, "utf8")).at(-1);
    const sentAt = Math.max(repeatedAt, last ? Date.parse(last.recordedAt) : -Infinity);
    const due = anchorDue(audit.head(), last, now() - sentAt);
    if (!due) return { anchored: false };
    const txHash = await chain.submit(due.args);
    const { seq, hash } = due.args;
    if (!due.record) { repeatedAt = now(); return { anchored: true, seq, txHash, repeat: true }; }
    await audit.append({ kind: "anchor", seq, hash, txHash, account: chain.account, key: chain.key });
    return { anchored: true, seq, txHash };
  };
}

/** One anchor, if one is due, from the log alone. */
export const anchorOnce = (deps: Parameters<typeof createAnchorer>[0]) => createAnchorer(deps)();

export type AnchorEvent = AnchorResult | { anchored: false; error: string };

/**
 * Anchors every `everyMs`, starting now, until `signal` aborts; it resolves once the anchor in flight, if any, has
 * finished, so shutdown can wait for it. A failed anchor is logged and tried again next time; it never stops the server.
 */
export async function runAnchor({ anchor, everyMs, log, sleep, signal }: {
  anchor: () => Promise<AnchorResult>;
  everyMs: number;
  log: (event: AnchorEvent) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}) {
  while (!signal.aborted) {
    log(await anchor().catch(error => ({ anchored: false as const, error: String(error) })));
    if (!signal.aborted) await sleep(everyMs, signal);
  }
}

export type AnchorCheck =
  | { ok: true; /** Anchors checked against the chain. */ anchors: number }
  | { ok: false; reason: string };

/**
 * Checks the log against its anchors: the chain itself first (`verifyChain`), then, for each anchor it records, that
 * it names the monitored account and key, that the chain has that transaction with the same sequence number and hash,
 * and that the record at that sequence number still has that hash. A log cut short past an anchor, or rewritten before
 * one, fails here even though it still chains. `listed` are anchors known from outside the log (the key's history): each
 * must name a record the log still has, with that hash, since a log cut back to before its last anchor no longer records
 * it, and only an outside copy shows that.
 */
export async function checkAnchors(text: string, chain: AnchorTarget & Pick<AnchorChain, "read">, listed: readonly (AnchorArgs & { txHash: string })[] = []): Promise<AnchorCheck> {
  const verified = verifyChain(text);
  if (!verified.ok) return { ok: false, reason: `the log is broken at line ${verified.line}: ${verified.reason}` };
  const bySeq = new Map(records(text).map(record => [record.seq, record.hash] as const));
  let anchors = 0;
  for (const { seq, hash, txHash, account, key } of recordedAnchors(text)) {
    if (account !== chain.account || key !== chain.key) return { ok: false, reason: `anchor ${txHash} is under ${account} ${key}, not ${chain.account} ${chain.key}` };
    const onChain = await chain.read(txHash);
    if (onChain === null) return { ok: false, reason: `anchor ${txHash} isn't on chain under ${chain.key}` };
    if (onChain.seq !== seq || onChain.hash !== hash) return { ok: false, reason: `anchor ${txHash} names record ${onChain.seq}, not the log's record ${seq}` };
    if (bySeq.get(seq) !== hash) return { ok: false, reason: `record ${seq} no longer has the hash anchored in ${txHash}` };
    anchors++;
  }
  for (const { seq, hash, txHash } of listed) {
    if (seq > verified.seq) return { ok: false, reason: `the log ends at record ${verified.seq}, before record ${seq}, anchored in ${txHash}` };
    if (bySeq.get(seq) !== hash) return { ok: false, reason: `record ${seq} no longer has the hash anchored in ${txHash}` };
  }
  return { ok: true, anchors };
}

/** A JSON-RPC call; an RPC error is thrown with its cause's name, so a missing transaction can be told from an outage. */
export type Rpc = (method: string, params: unknown) => Promise<unknown>;

export function jsonRpc({ rpcUrl, headers = {}, timeoutMs, fetch: send = fetch }: {
  rpcUrl: string; headers?: Record<string, string>; timeoutMs: number; fetch?: typeof fetch;
}): Rpc {
  return async (method, params) => {
    const response = await send(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`RPC answered ${response.status}`);
    const body = await response.json() as { result?: unknown; error?: { cause?: { name?: string }; message?: string } };
    if (body.error) throw Object.assign(new Error(`RPC error ${body.error.cause?.name ?? body.error.message}`), { cause: body.error.cause?.name });
    return body.result;
  };
}

type TxStatus = {
  final_execution_status?: string;
  status?: { SuccessValue?: string };
  transaction?: { signer_id?: string; receiver_id?: string; actions?: { FunctionCall?: { method_name?: string; args?: string; deposit?: string } }[] };
};

/**
 * The anchor in a transaction, read through RPC: `null` unless the chain has it in a final block, signed by `account`
 * to itself, a single successful `__fastdata_kv` call with no deposit whose only key is `key`, holding an anchor. A
 * transaction the RPC doesn't know is `null`; any other RPC failure throws, so an outage never reads as a missing anchor.
 */
export async function readAnchorTx(rpc: Rpc, { account, key }: AnchorTarget, txHash: string): Promise<AnchorArgs | null> {
  let status: TxStatus;
  try {
    status = await rpc("tx", { tx_hash: txHash, sender_account_id: account, wait_until: "NONE" }) as TxStatus;
  } catch (error) {
    if ((error as { cause?: unknown }).cause === "UNKNOWN_TRANSACTION") return null;
    throw error;
  }
  const tx = status.transaction;
  if (status.final_execution_status !== "FINAL" || status.status?.SuccessValue === undefined) return null;
  if (tx?.signer_id !== account || tx.receiver_id !== account || tx.actions?.length !== 1) return null;
  const call = tx.actions[0]!.FunctionCall;
  if (call?.method_name !== ANCHOR_METHOD || call.deposit !== "0" || typeof call.args !== "string") return null;
  try {
    const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) as Record<string, unknown>;
    return Object.keys(args).length === 1 && isAnchorArgs(args[key]) ? args[key] : null;
  } catch { return null; }
}

/**
 * The anchor chain through near-kit: `account` signs with `signer`, a function-call key limited to `account` and
 * `__fastdata_kv`. The send waits until its receipts are final, so a failed call throws instead of being recorded, and
 * the hash is the one near-kit sent last (it signs again after a stale nonce, which changes the hash). near-kit's RPC
 * calls have no timeout, so a send that hasn't answered in `sendTimeoutMs` fails, and the loop goes on: the anchor may
 * still land, and the next one repeats it. Anchors are read back from the archival RPC, since they're read long after
 * they were sent.
 */
export function nearAnchorChain({ account, key, signer, networkId, send, archival, timeoutMs, sendTimeoutMs = 60_000 }: AnchorTarget & {
  signer: Secret; networkId: AnchorNetwork; timeoutMs: number; sendTimeoutMs?: number;
  send: { rpcUrl: string; headers: Record<string, string> }; archival: { rpcUrl: string; headers: Record<string, string> };
}): AnchorChain {
  const near = new Near({ network: { networkId, rpcUrl: send.rpcUrl }, headers: send.headers, privateKey: signer.reveal() as `ed25519:${string}`, defaultSignerId: account });
  const rpc = jsonRpc({ ...archival, timeoutMs });
  return {
    account, key,
    async submit(args) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the anchor send didn't answer in ${sendTimeoutMs} ms`)), sendTimeoutMs); });
      try {
        const sent = near.transaction(account).functionCall(account, ANCHOR_METHOD, { [key]: args }, { gas: "5 Tgas" }).send({ waitUntil: "FINAL" });
        return (await Promise.race([sent, timeout])).transaction.hash;
      } finally { clearTimeout(timer); }
    },
    read: txHash => readAnchorTx(rpc, { account, key }, txHash),
  };
}

/** The anchor key from a file only its owner can read: an `ed25519:` secret key, as near-kit takes it. */
export async function readAnchorKey(file: string): Promise<Secret> {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).mode & 0o077) throw new Error(`${file} is readable by others: it must be 0600`);
    const value = (await handle.readFile("utf8")).trim();
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) throw new Error(`${file} doesn't hold an ed25519 secret key`);
    return new Secret(value);
  } finally { await handle.close(); }
}
