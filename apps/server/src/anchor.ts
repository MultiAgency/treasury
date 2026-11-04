import { open, readFile } from "node:fs/promises";
import { Near } from "near-kit";
import { Secret } from "./config.ts";
import { verifyChain, type ChainRecord } from "./chain.ts";

// A7.3 (#55): the audit log's head hash goes on NEAR once an hour, so a log that was cut short or rewritten after an
// anchor can be told apart from the one that was anchored. Only the sequence number and hash leave the machine; the
// entries stay here.
//
// Mechanism (decided on #55): a function-call transaction from the anchor account to itself, whose arguments carry the
// hash. A NEAR transfer has no memo field, so the arguments are the memo. The account needs no contract: the call's
// receipt fails, but the transaction, and its arguments, are in a final block, which is all an anchor needs. It's
// signed with a function-call key limited to this receiver and method, so the server holds no key that can move funds.

/** The method the anchor transaction names. The anchor key's permission is limited to it. */
export const ANCHOR_METHOD = "treasury_audit_anchor";

/** What an anchor puts on chain: the format version, and the log's head when it was anchored. */
export type AnchorArgs = { v: 1; seq: number; hash: string };

/** How an anchor is recorded in the log itself, after its transaction is final. */
export type AnchorEntry = { kind: "anchor"; seq: number; hash: string; txHash: string; account: string };

/** The chain, as the anchor uses it: send the arguments and get the transaction's hash; read them back by that hash. */
export type AnchorChain = {
  account: string;
  /** Sends the anchor transaction and resolves with its hash once it's in a final block. */
  submit(args: AnchorArgs): Promise<string>;
  /** The anchor transaction's arguments as the chain has them, or `null` if it has no such transaction. */
  read(txHash: string): Promise<AnchorArgs | null>;
};

const isAnchorArgs = (value: unknown): value is AnchorArgs =>
  typeof value === "object" && value !== null && (value as AnchorArgs).v === 1
  && Number.isSafeInteger((value as AnchorArgs).seq) && (value as AnchorArgs).seq > 0
  && typeof (value as AnchorArgs).hash === "string" && /^[0-9a-f]{64}$/.test((value as AnchorArgs).hash);

const isAnchorEntry = (entry: unknown): entry is AnchorEntry =>
  typeof entry === "object" && entry !== null && (entry as AnchorEntry).kind === "anchor";

const records = (text: string) => text.split("\n").flatMap(line => {
  try { return [JSON.parse(line) as ChainRecord]; } catch { return []; }
});

/**
 * Whether the log needs an anchor now: it has records, and something other than the last anchor's own record was
 * added since that anchor. Without that second rule, recording an anchor would make the log need another, every hour.
 */
export function needsAnchor(head: { seq: number }, last: { anchoredSeq: number; recordSeq: number } | undefined) {
  if (head.seq === 0) return false;
  if (last === undefined) return true;
  return head.seq > last.recordSeq;
}

/** The last anchor the log records: the head it anchored, and the sequence number of the record that says so. */
export function lastAnchor(text: string): { anchoredSeq: number; recordSeq: number } | undefined {
  let last: { anchoredSeq: number; recordSeq: number } | undefined;
  for (const record of records(text)) if (isAnchorEntry(record.entry)) last = { anchoredSeq: record.entry.seq, recordSeq: record.seq };
  return last;
}

export type AnchorAudit = { head(): { hash: string; seq: number }; append(entry: AnchorEntry): Promise<void> };

/**
 * One anchor, if the log needs one: the head goes on chain, then the log records the transaction. If the log can't
 * record it the anchor is still on chain, and the next run anchors again; nothing is lost, an hour's anchor is repeated.
 */
export async function anchorOnce({ audit, file, chain }: { audit: AnchorAudit; file: string; chain: AnchorChain }):
  Promise<{ anchored: false } | { anchored: true; seq: number; txHash: string }> {
  const head = audit.head();
  if (!needsAnchor(head, lastAnchor(await readFile(file, "utf8")))) return { anchored: false };
  const txHash = await chain.submit({ v: 1, seq: head.seq, hash: head.hash });
  await audit.append({ kind: "anchor", seq: head.seq, hash: head.hash, txHash, account: chain.account });
  return { anchored: true, seq: head.seq, txHash };
}

export type AnchorCheck =
  | { ok: true; /** Anchors checked against the chain. */ anchors: number }
  | { ok: false; reason: string };

/**
 * Checks the log against its anchors: the chain itself first (`verifyChain`), then, for each anchor it records, that
 * the chain has that transaction with the same sequence number and hash, and that the record at that sequence number
 * still has that hash. A log cut short past an anchor, or rewritten before one, fails here even though it still chains.
 * `known` is the most recent anchor known from outside the log (from monitoring, say): a log cut back to before its
 * last anchor no longer records it, and only an outside copy shows that.
 */
export async function checkAnchors(text: string, chain: Pick<AnchorChain, "read">, known?: { seq: number; hash: string }): Promise<AnchorCheck> {
  const verified = verifyChain(text);
  if (!verified.ok) return { ok: false, reason: `the log is broken at line ${verified.line}: ${verified.reason}` };
  const bySeq = new Map(records(text).map(record => [record.seq, record.hash] as const));
  let anchors = 0;
  for (const record of records(text)) {
    if (!isAnchorEntry(record.entry)) continue;
    const { seq, hash, txHash } = record.entry;
    const onChain = await chain.read(txHash);
    if (onChain === null) return { ok: false, reason: `anchor ${txHash} isn't on chain` };
    if (onChain.seq !== seq || onChain.hash !== hash) return { ok: false, reason: `anchor ${txHash} names record ${onChain.seq}, not the log's record ${seq}` };
    if (bySeq.get(seq) !== hash) return { ok: false, reason: `record ${seq} no longer has the hash anchored in ${txHash}` };
    anchors++;
  }
  if (known && bySeq.get(known.seq) !== known.hash)
    return { ok: false, reason: bySeq.has(known.seq) ? `record ${known.seq} no longer has its anchored hash` : `the log ends before record ${known.seq}, which was anchored` };
  return { ok: true, anchors };
}

/**
 * The anchor chain through near-kit: `account` signs with `key`, a function-call key limited to `account` and
 * `ANCHOR_METHOD`. The hash is taken from the signed transaction before it's sent, so a send whose answer is lost can
 * still be looked up; it's sent waiting only for its block to be final, since the call's own outcome doesn't matter.
 */
export function nearAnchorChain({ account, key, networkId, rpcUrl, headers }: {
  account: string; key: Secret; networkId: string; rpcUrl: string; headers?: Record<string, string>;
}): AnchorChain {
  const near = new Near({ network: { networkId, rpcUrl }, headers, privateKey: key.reveal() as `ed25519:${string}`, defaultSignerId: account });
  return {
    account,
    async submit(args) {
      const tx = await near.transaction(account).functionCall(account, ANCHOR_METHOD, args, { gas: "5 Tgas" }).sign();
      const txHash = tx.getHash();
      if (txHash === null) throw new Error("the anchor transaction wasn't signed");
      await tx.send({ waitUntil: "INCLUDED_FINAL" });
      return txHash;
    },
    async read(txHash) {
      const status = await near.getTransactionStatus(txHash, account, "INCLUDED_FINAL") as { transaction?: { actions?: unknown[] } };
      const action = status.transaction?.actions?.[0] as { FunctionCall?: { method_name?: string; args?: string } } | undefined;
      const call = action?.FunctionCall;
      if (call?.method_name !== ANCHOR_METHOD || typeof call.args !== "string") return null;
      try {
        const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
        return isAnchorArgs(args) ? args : null;
      } catch { return null; }
    },
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
