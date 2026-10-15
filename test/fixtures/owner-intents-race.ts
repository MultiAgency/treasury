// Child process for owner-intents-race.test.ts: loads the owner intents, prints "loaded", waits until
// the file named by argv[3] exists (if given), then prepares an agent freeze whose correlation id is argv[2].
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { api } from "../../src/api.js";
import { prepare } from "../../src/owner-intents.js";
import { walletIntent, walletSigner } from "./wallet-signature.js";

Object.assign(api, {
  generateIntent: async (request: { type: string }) => ({ type: request.type, correlation_id: process.argv[2], preview: {},
    expires_at: new Date(Date.now() + 600_000).toISOString(), intent: walletIntent, signer: walletSigner }),
});
console.log("loaded");
while (process.argv[3] && !existsSync(process.argv[3])) await setTimeout(20);
await prepare({ type: "agent_freeze" });
