import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendLine } from "./files.ts";

/** What an audit record says about a relayed action. It has no field that could carry a credential, session or signature. */
export type AuditEntry = {
  /** The signed-in NEAR account the action was relayed for. */
  who: string;
  action: "approve" | "reject" | "consent" | "revoke" | "execute";
  agent: string;
  /** The proposal or consent the action concerns, when it has one. */
  subject?: string;
  /** The SHA-256 of the text the owner signed, never the signature. */
  signedTextSha256?: string;
  /** The platform's answer: `ok`, or the failure's kind and code. */
  answer: { ok: true } | { ok: false; kind: string; code?: string };
};

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The append-only audit trail: one JSON line per relayed action, flushed before the action's answer is returned. */
export function createAudit(dataDir: string, now: () => number = Date.now) {
  const file = join(dataDir, "audit.jsonl");
  return {
    file,
    record: (entry: AuditEntry) => appendLine(file, JSON.stringify({ at: new Date(now()).toISOString(), ...entry })),
  };
}
export type Audit = ReturnType<typeof createAudit>;
