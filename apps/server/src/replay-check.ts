import { replayAuditLog } from "../../../packages/core/src/index.ts";
import { readAuditLog, verifyChain } from "./chain.ts";

// The replay check A7.2 needs (#54): an audit log end to end, the hash chain first (`verifyChain`), then every recorded
// decision replayed through the engines (`replayAuditLog`), naming the first record that differs. Run it on the server,
// against the live log, or on a copy of it with its closed segments beside it (#173), every segment read in order:
//
//   pnpm --filter @treasury/server check:replay <audit log>
//   node src/replay-check.ts /data/audit.jsonl        (in the deployed image, from apps/server)

/** What the check found: whether the log passes, and what to print. */
export function checkAuditLog(text: string): { ok: boolean; message: string } {
  const chain = verifyChain(text);
  if (!chain.ok) return { ok: false, message: `the chain is broken at line ${chain.line}: ${chain.reason}` };
  const replay = replayAuditLog(text);
  if (!replay.ok) return { ok: false, message: `decision ${replay.index + 1} (seq ${replay.seq}) differs in its ${replay.part}:\n${JSON.stringify({ recorded: replay.recorded, replayed: replay.replayed }, null, 2)}` };
  return { ok: true, message: `ok: ${chain.count} records chain to ${chain.head}; ${replay.count} decisions replay the same` };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node src/replay-check.ts <audit log>"); process.exit(2); }
  const result = checkAuditLog(await readAuditLog(file));
  (result.ok ? console.log : console.error)(result.message);
  process.exit(result.ok ? 0 : 1);
}
