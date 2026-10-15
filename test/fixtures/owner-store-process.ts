import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout } from "node:timers/promises";
import { api } from "../../src/api.js";
import { prepare, reconcileOwnerIntents, submit } from "../../src/owner-intents.js";
import { walletIntent, walletSignature, walletSigner } from "./wallet-signature.js";

const mode = process.argv[2]!;
const id = process.argv[3] ?? "shared";
if (mode === "prepare-crash") {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (String(to).endsWith(".env.json")) process.exit(71);
  };
  syncBuiltinESMExports();
}
Object.assign(api, {
  generateIntent: async (request: { type: string }) => ({ type: request.type, correlation_id: id, preview: {},
    expires_at: new Date(Date.now() + 600_000).toISOString(), intent: walletIntent, signer: walletSigner }),
  submitIntent: async () => {
    fs.appendFileSync("signatures.jsonl", JSON.stringify({ id }) + "\n");
    if (mode === "submit-crash") process.exit(71);
    await setTimeout(200);
    return { correlation_id: id, status: "SUCCESS" };
  },
  getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS" }),
});
if (mode.startsWith("prepare")) await prepare({ type: "agent_freeze" });
else if (mode === "poll") await reconcileOwnerIntents();
else await submit(id, await walletSignature());
