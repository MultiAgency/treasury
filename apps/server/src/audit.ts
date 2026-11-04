import { createHash } from "node:crypto";
import { appendLine, ensureAppendable } from "./files.ts";

/**
 * What an audit record says about a relayed owner action. It has no field that could carry a credential, session or
 * signature. Each action is recorded twice: its `attempt` before the platform is asked, so nothing reaches the
 * platform unrecorded, and its `result` with the platform's answer.
 */
export type AuditEntry = {
  /** The signed-in NEAR account the action was relayed for. */
  who: string;
  action: "consent" | "revoke" | "approve" | "reject" | "execute";
  agent: string;
  /** The consent or proposal the action concerns, once it's known. */
  subject?: string;
  /** The SHA-256 of the text the owner signed, never the signature. For a DAO, of the text its vote signs. */
  signedTextSha256?: string;
  /**
   * For a DAO-owned agent (`signer: "dao"`), the action is the DAO's vote, relayed in two steps: `file`, the request this
   * server filed for a member, and `relay`, a read of its state that found the vote final (the consent stored or the
   * verdict relayed, or the vote ended). `who` is the member. `daoRequest` is the platform's request ID and `daoHash`
   * the NEP-413 hash the DAO's key signs: both public, shown on the platform's check page.
   */
  signer?: "dao";
  step?: "file" | "relay";
  daoRequest?: string;
  daoHash?: string;
} & (
  | { stage: "attempt" }
  /** The platform's answer: `ok`, or the failure's kind, its HTTP status, and the code the browser was given. */
  | { stage: "result"; answer: { ok: true } | { ok: false; kind: string; status?: number; code?: string } }
);

/**
 * Where relayed owner actions are recorded, append-only: each `append` resolves once its record is durable. One JSON
 * line per record for now; A7's hash-chained store (#53) can implement the same interface.
 */
export type Audit = { append(entry: AuditEntry): Promise<void> };

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The audit trail as a file of JSON lines, owner-only, each flushed before `append` resolves. `check` opens it for
 * appending and checks its mode, so a server that couldn't record relayed actions stops at startup rather than at the
 * first one.
 */
export function fileAudit(file: string, now: () => number = Date.now): Audit & { file: string; check(): Promise<void> } {
  return {
    file,
    check: () => ensureAppendable(file),
    append: entry => appendLine(file, JSON.stringify({ at: new Date(now()).toISOString(), ...entry })),
  };
}
