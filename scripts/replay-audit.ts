// Checks an audit log end to end (A7.2, #54): the hash chain first (`verifyChain`), then every recorded decision replayed
// through the engines (`replayAuditLog`), naming the first record that differs. Exits non-zero on any failure.
//
//   node scripts/replay-audit.ts <audit log>
import { readFileSync } from "node:fs";
import { verifyChain } from "../apps/server/src/chain.ts";
import { replayAuditLog } from "../packages/core/src/decisions.ts";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/replay-audit.ts <audit log>"); process.exit(2); }
const text = readFileSync(file, "utf8");

const chain = verifyChain(text);
if (!chain.ok) { console.error(`chain broken at line ${chain.line}: ${chain.reason}`); process.exit(1); }
const replay = replayAuditLog(text);
if (!replay.ok) {
  console.error(`decision ${replay.index} (seq ${replay.seq}) differs in its ${replay.part}:`);
  console.error(JSON.stringify({ recorded: replay.recorded, replayed: replay.replayed }, null, 2));
  process.exit(1);
}
console.log(`ok: ${chain.count} records chain to ${chain.head}; ${replay.count} decisions replay the same`);
