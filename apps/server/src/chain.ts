import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuditEntry } from "./audit.ts";
import { appendLine, ensureAppendable } from "./files.ts";

// The hash-chained audit store (A7.1, #53). With the server's own entry type it is an `Audit` like `fileAudit`, so the server writes
// through `append(entry)` unchanged. Every record carries the hash of the one before it, so an edit, a removed record
// or a reordering is found by `verifyChain`. Only hashes ever leave the machine (A7.3 anchors the head hash); the
// entries stay here.

/** The kinds of record the log holds. `approval` covers an owner's approve and reject, with a verdict; `order` covers an execute. */
export const AUDIT_KINDS = ["mandate", "oracle", "proposal", "policy", "approval", "order", "fill", "level", "payout", "note", "anchor", "consent", "revocation"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** The "previous hash" of the first record. */
export const GENESIS = "0".repeat(64);

export type ChainRecord<E = unknown> = { seq: number; at: string; prev: string; hash: string; entry: E };

/**
 * One fixed text for a value, whatever the order its keys were written in: object keys sorted, no whitespace, finite
 * numbers only. Properties that are `undefined` are left out, as JSON does. Anything that isn't plain JSON data
 * (a Date, a function, a bigint, NaN, a cycle) throws, so a hash never depends on how a value happens to stringify.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("canonicalJson: nesting is too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: numbers must be finite");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item, depth + 1)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error("canonicalJson: only plain objects");
      const record = value as Record<string, unknown>;
      const parts = Object.keys(record).filter(key => record[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    default: throw new Error(`canonicalJson: a ${typeof value} can't be recorded`);
  }
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The hash of a record: SHA-256 over the canonical form of its sequence, time, previous hash and entry. */
export function recordHash(record: Omit<ChainRecord, "hash">): string {
  return sha256Hex(canonicalJson({ seq: record.seq, at: record.at, prev: record.prev, entry: record.entry }));
}

/** Names that must never appear in an entry, and the shape of this deployment's credentials. An entry holds hashes, not secrets. */
const SECRET_KEY = /signature|credential|token|secret|password|privatekey|private_key|cookie|authorization|mnemonic|seed/i;
const SECRET_VALUE = /\b(?:tap_|tmc_)[A-Za-z0-9_-]{8,}|ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/;

/** Throws if an entry could carry a credential, session or signature. Fail closed: the record is refused, not redacted. */
function assertNoSecrets(value: unknown, path = "entry", depth = 0): void {
  if (depth > 64) return;
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) throw new Error(`${path} looks like a credential or key: an entry holds hashes, not secrets`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`, depth + 1));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new Error(`${path}.${key}: an entry has no field for a credential, session or signature`);
      assertNoSecrets(item, `${path}.${key}`, depth + 1);
    }
  }
}

export type Verified =
  | { ok: true; /** Records checked. */ count: number; /** The last record's hash (GENESIS when empty). */ head: string; /** Highest sequence number. */ seq: number; /** Lines that weren't JSON: torn writes from a crash. */ skipped: number }
  | { ok: false; /** 1-based line of the first broken record. */ line: number; reason: string };

const isRecord = (v: unknown): v is ChainRecord =>
  typeof v === "object" && v !== null && !Array.isArray(v)
  && Number.isSafeInteger((v as ChainRecord).seq) && typeof (v as ChainRecord).at === "string"
  && typeof (v as ChainRecord).prev === "string" && typeof (v as ChainRecord).hash === "string" && "entry" in v;

/**
 * Walks the log text and checks every record: it parses, its sequence follows the last, it names the last hash, and its
 * own hash is right. A line that isn't JSON is a write a crash tore; it was never a record, so it is skipped and counted.
 * A line that is JSON but isn't a valid next record (an old plain-format line, an edit, a removed or reordered record)
 * breaks the chain, and the first one is reported. Dropping the last records can't be seen from the log alone: the head
 * hash anchored on chain (A7.3) is what shows it.
 */
export function verifyChain(text: string): Verified {
  let prev = GENESIS, seq = 0, count = 0, skipped = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { skipped++; continue; }
    if (!isRecord(parsed)) return { ok: false, line: i + 1, reason: "not a chained record" };
    if (parsed.seq !== seq + 1) return { ok: false, line: i + 1, reason: `sequence ${parsed.seq} follows ${seq}` };
    if (parsed.prev !== prev) return { ok: false, line: i + 1, reason: "doesn't continue the previous record's hash" };
    if (!Number.isFinite(Date.parse(parsed.at))) return { ok: false, line: i + 1, reason: "no valid time" };
    let expected: string;
    try { expected = recordHash(parsed); } catch { return { ok: false, line: i + 1, reason: "the entry can't be hashed" }; }
    if (parsed.hash !== expected) return { ok: false, line: i + 1, reason: "the record was changed: its hash doesn't match" };
    prev = parsed.hash; seq = parsed.seq; count++;
  }
  return { ok: true, count, head: prev, seq, skipped };
}

export type ChainedAudit<E extends object> = {
  file: string;
  /** Creates and checks the file (owner-only), verifies the whole chain and takes its head. Throws if the chain is broken. */
  check(): Promise<void>;
  append(entry: E): Promise<void>;
  /** The last record's hash and sequence number, after `check` and every `append`. */
  head(): { hash: string; seq: number };
};

/**
 * The audit trail as a hash chain in a file of JSON lines, owner-only, each record flushed before `append` resolves.
 * Appends from one process are queued so each names the one before it. Call `check()` at startup: the server then
 * refuses to run on a broken log, as it does for an unwritable one. An existing plain-format log must be moved aside.
 */
export function chainedFileAudit<E extends object = AuditEntry>(file: string, now: () => number = Date.now): ChainedAudit<E> {
  let head: { hash: string; seq: number } | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const write = async (entry: E) => {
    if (head === undefined) throw new Error("the audit log wasn't checked: call check() before append()");
    assertNoSecrets(entry);
    const body = { seq: head.seq + 1, at: new Date(now()).toISOString(), prev: head.hash, entry };
    const hash = recordHash(body);
    // The line is built from the canonical text of the entry, so reading it back hashes to the same value.
    await appendLine(file, `{"seq":${body.seq},"at":${JSON.stringify(body.at)},"prev":"${body.prev}","hash":"${hash}","entry":${canonicalJson(entry)}}`);
    head = { hash, seq: body.seq };
  };

  return {
    file,
    async check() {
      await ensureAppendable(file);
      const verified = verifyChain(await readFile(file, "utf8"));
      if (!verified.ok) throw new Error(`the audit log is broken at line ${verified.line}: ${verified.reason}`);
      head = { hash: verified.head, seq: verified.seq };
    },
    append(entry: E) {
      const run = queue.then(() => write(entry));
      queue = run.catch(() => {}); // a failed append must not stop the ones behind it
      return run;
    },
    head() {
      if (head === undefined) throw new Error("the audit log wasn't checked: call check() first");
      return { ...head };
    },
  };
}
