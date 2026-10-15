import { api } from "../../src/api.js";
import { prepare, submit } from "../../src/owner-intents.js";
import { acquireExecutorLease } from "../../src/executor-lease.js";
import { walletIntent, walletSignature, walletSigner } from "./wallet-signature.js";

// A real server starts without an agent, then learns its identity through owner settlement.
delete process.env.AGENT_ID;
const id = process.argv[2]!;
const intervals: number[] = [];
const interval = globalThis.setInterval;
globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  intervals.push(Number(ms));
  return interval(callback, ms, ...args);
}) as typeof setInterval;
Object.assign(api, {
  generateIntent: async () => ({ type: "agent_create", correlation_id: "creation", preview: {},
    expires_at: new Date(Date.now() + 60_000).toISOString(), intent: walletIntent, signer: walletSigner }),
  submitIntent: async () => ({ correlation_id: "creation", status: "SUCCESS" }),
  getStatus: async (correlation_id: string) => ({ correlation_id, status: "SUCCESS", agent_id: id }),
});
await import("../../src/server.js");
await new Promise(resolve => setImmediate(resolve));
const before = intervals.slice();
await prepare({ type: "agent_create", owner: walletSigner });
await submit("creation", await walletSignature());
let protectedByLease = false;
try { const release = await acquireExecutorLease(id); await release(); }
catch { protectedByLease = true; }
console.log(JSON.stringify({ reviewResult: true, protectedByLease, before, after: intervals, agentId: process.env.AGENT_ID }));
process.kill(process.pid, "SIGTERM");
