import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AuditEntry } from "./audit.ts";
import { appendLine, ensureAppendable, syncDir } from "./files.ts";

// The hash-chained audit store (A7.1, #53). With the server's own entry type it is the server's `Audit`, so the server writes
// through `append(entry)` unchanged. Every record carries the hash of the one before it, so an edit, a removed record
// or a reordering is found by `verifyChain`. Only hashes ever leave the machine (A7.3 anchors the head hash); the
// entries stay here.
//
// The log is kept in segments (#173): records go to the open segment, the file itself, and once it holds
// `SEGMENT_BYTES` it is closed, renamed beside itself with its last record's sequence number, and a new one is opened.
// The chain runs on across segments, so the segments in order are one log (`readAuditLog`), checked from its first
// record by `check:replay` and `check:anchors --log`. Startup reads only the open segment and the last closed one.

/**
 * The kinds of record the log holds. `approval` covers an owner's approve and reject, with a verdict; `order` covers an
 * execute. `decision` is one engine decision with every input it was made from, which a replay makes again (A7.2, #54).
 */
export const AUDIT_KINDS = ["mandate", "oracle", "proposal", "policy", "decision", "approval", "order", "fill", "level", "payout", "note", "anchor", "consent", "revocation"] as const;
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

/**
 * Field names that must never appear in an entry: credentials named exactly, compared without case, `_` or `-`, and any
 * name ending in one (`ownerSignature`), and any name ending in `token` (`accessToken`, `authToken`, `csrfToken`). Not
 * `token` alone, nor `seed`: here a token is an asset (`token`, `tokens`, `tokenIn`, the SDK's `PROPOSAL_TOKENS`) and a
 * seed is a PRNG's (`ReplayConfig.seed`). A wallet's seed is `mnemonic` or `seedPhrase`.
 */
const SECRET_NAMES = ["signature", "signatures", "credential", "credentials", "secret", "secrets", "password", "passphrase",
  "privatekey", "secretkey", "cookie", "cookies", "authorization", "mnemonic", "seedphrase", "apikey"];
const isSecretKey = (key: string) => {
  const name = key.toLowerCase().replace(/[_-]/g, "");
  return SECRET_NAMES.some(secret => name === secret || name.endsWith(secret)) || (name.endsWith("token") && name !== "token");
};
/** The shape of this deployment's credentials and of a full key. An entry holds hashes, not secrets. */
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
      if (isSecretKey(key)) throw new Error(`${path}.${key}: an entry has no field for a credential, session or signature`);
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
export function verifyChain(text: string, from: { seq: number; hash: string } = { seq: 0, hash: GENESIS }): Verified {
  let prev = from.hash, seq = from.seq, count = 0, skipped = 0;
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

/** How large the open segment grows before it is closed: about 25 days of one Ballast agent's decisions (#173). */
export const SEGMENT_BYTES = 8 * 1024 * 1024;

/** A closed segment's suffix: its last record's sequence number, zero-padded so the names sort in order. */
const SEGMENT_SUFFIX = /^\d{12}$/;
const closedSegment = (file: string, seq: number) => `${file}.${String(seq).padStart(12, "0")}`;

/** The log's segments, oldest first: each closed one, then the open one, `file` itself. */
export async function auditSegments(file: string): Promise<string[]> {
  const prefix = `${basename(file)}.`;
  const names = await readdir(dirname(file)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const closed = names.filter(name => name.startsWith(prefix) && SEGMENT_SUFFIX.test(name.slice(prefix.length))).sort();
  return [...closed.map(name => join(dirname(file), name)), file];
}

const readSegment = (file: string) => readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "" : Promise.reject(error));
/** Segments joined line by line: a closed segment may end in a line a crash tore, which must not run into the next. */
const joinSegments = (texts: string[]) => texts.map(text => text === "" || text.endsWith("\n") ? text : `${text}\n`).join("");

/**
 * The whole log as one text, every segment in order: what `verifyChain` checks from the first record. A log with no
 * segment at all throws, so a wrong path never reads as an empty log.
 */
export async function readAuditLog(file: string): Promise<string> {
  const segments = await auditSegments(file);
  if (segments.length === 1) return readFile(file, "utf8");
  return joinSegments(await Promise.all(segments.map(readSegment)));
}

/**
 * The log's records, oldest first, read for display (the assistant's decision and audit tools, #219): at most the newest
 * `keep` lines, and a line that isn't a record skipped. This doesn't verify the chain; `verifyChain` does.
 */
export function parseAuditLog(text: string, keep = 20_000): ChainRecord[] {
  const records: ChainRecord[] = [];
  for (const line of text.split("\n").slice(-keep)) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

/** Where a segment's chain starts: the sequence number and hash its first record continues. */
function segmentStart(text: string): { seq: number; hash: string } {
  for (const line of text.split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (isRecord(parsed)) return { seq: parsed.seq - 1, hash: parsed.prev };
    break;
  }
  return { seq: 0, hash: GENESIS };
}

export type ChainedAudit<E extends object> = {
  file: string;
  /**
   * Creates and checks the file (owner-only), verifies the open segment and the last closed one, and takes the head.
   * Throws if the chain is broken. The closed segments before them are checked by `check:replay` and `check:anchors`.
   */
  check(): Promise<void>;
  append(entry: E): Promise<void>;
  /** The last record's hash and sequence number, after `check` and every `append`. After a failed append it may lag the file until the next append reads it back. */
  head(): { hash: string; seq: number };
};

/**
 * The audit trail as a hash chain in a file of JSON lines, owner-only, each record flushed before `append` resolves.
 * Appends from one process are queued so each names the one before it. Call `check()` at startup: the server then
 * refuses to run on a broken log, as it does for an unwritable one. An existing plain-format log must be moved aside.
 * The open segment is closed before an append once it holds `segmentBytes`.
 */
export function chainedFileAudit<E extends object = AuditEntry>(file: string, now: () => number = Date.now,
  append: (path: string, line: string) => Promise<void> = appendLine, segmentBytes = SEGMENT_BYTES): ChainedAudit<E> {
  let head: { hash: string; seq: number } | undefined;
  // Set when a write failed: its line may be on disk even so (a flush that threw after writing), so the head is read back
  // from the file before the next write instead of reusing a sequence number the log may already hold.
  let unsure = false;
  let queue: Promise<unknown> = Promise.resolve();

  // The last closed segment, taken up where it starts, then the open one from its head. With no closed segment, the open
  // one is the whole log and starts at the first record.
  const readHead = async () => {
    const segments = (await auditSegments(file)).slice(-2);
    let from: { seq: number; hash: string } | undefined;
    for (const [i, segment] of segments.entries()) {
      const text = await readSegment(segment);
      const verified = verifyChain(text, i === 0 && segments.length === 2 ? segmentStart(text) : from);
      if (!verified.ok) throw new Error(`the audit log is broken at line ${verified.line}: ${verified.reason} (${segment})`);
      from = { seq: verified.seq, hash: verified.head };
    }
    head = { hash: from!.hash, seq: from!.seq };
  };

  // Closes the open segment under its last record's sequence number and opens a new one, then flushes the directory, so
  // both the rename and the new file survive a crash (`appendLine` flushes only the file). A crash before the new file
  // is made leaves no open segment, which `check()` creates; the head is the closed segment's.
  const rotate = async () => {
    const closed = closedSegment(file, head!.seq);
    if (await stat(closed).then(() => true, () => false)) throw new Error(`${closed} already exists: the open segment holds no record after it`);
    await rename(file, closed);
    await ensureAppendable(file);
    await syncDir(dirname(file));
  };

  const write = async (entry: E) => {
    if (head === undefined) throw new Error("the audit log wasn't checked: call check() before append()");
    assertNoSecrets(entry);
    if (unsure) { await readHead(); unsure = false; }
    try { if (await stat(file).then(s => s.size, () => 0) >= segmentBytes) await rotate(); } catch (error) { unsure = true; throw error; }
    const body = { seq: head.seq + 1, at: new Date(now()).toISOString(), prev: head.hash, entry };
    const hash = recordHash(body);
    // The line is built from the canonical text of the entry, so reading it back hashes to the same value.
    const line = `{"seq":${body.seq},"at":${JSON.stringify(body.at)},"prev":"${body.prev}","hash":"${hash}","entry":${canonicalJson(entry)}}`;
    try { await append(file, line); } catch (error) { unsure = true; throw error; }
    head = { hash, seq: body.seq };
  };

  return {
    file,
    async check() {
      await ensureAppendable(file);
      await readHead();
      unsure = false;
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

/**
 * Moves a log in the old plain format (one JSON line per record, as the server wrote before this store) aside before
 * the chained store takes the file, as the switch to this store requires (#90): it is renamed beside itself with the
 * time in its name, never deleted. Only a log with no line shaped like a chained record (`seq`, `prev` and `hash`) is
 * moved; a chained log that is broken, even at its first record, stays put, so `check()` refuses it. Answers the new
 * name, or `undefined` when nothing was moved.
 */
export async function movePlainLogAside(file: string, now: () => number = Date.now): Promise<string | undefined> {
  const size = await stat(file).then(s => s.size, () => 0);
  if (size === 0) return undefined;
  const text = await readFile(file, "utf8");
  const chainedShape = (line: string) => {
    try { const value = JSON.parse(line) as Record<string, unknown>; return ["seq", "prev", "hash"].some(field => field in value); } catch { return false; }
  };
  if (verifyChain(text).ok || text.split("\n").some(chainedShape)) return undefined;
  const aside = `${file}.plain-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
  await rename(file, aside);
  return aside;
}
