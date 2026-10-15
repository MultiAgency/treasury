// Private subprocess entry point. It has one settings file and never listens on a network port.
import lockfile from "proper-lockfile";
import { ENV_FILE, executes, saveEnv } from "./env.js";
import { acquireExecutorLease } from "./executor-lease.js";
import { createExecutorLifecycle } from "./executor-lifecycle.js";
import { resumeOwnerIntents, setAgentCreationHandler } from "./owner-intents.js";
import { startReconciliation } from "./recover.js";
import { currentWorkOrder } from "./work-order-store.js";
import { handleWorkOrderCommand } from "./work-order-runtime.js";
import { workOrderCommand } from "./work-order-protocol.js";

if (!process.send || !executes() || !currentWorkOrder()) throw new Error("Work order executors require private IPC and their own instance.");
const instanceRelease = await lockfile.lock(`${ENV_FILE}.executor`, {
  realpath: false, retries: 0, stale: 30_000, update: 5_000,
  onCompromised: () => { console.error("Work order instance lease lost."); process.exit(1); },
});
const lifecycle = createExecutorLifecycle({ executes, acquire: acquireExecutorLease,
  configure: id => saveEnv({ AGENT_ID: id }), start: () => { startReconciliation(); } });
setAgentCreationHandler(id => lifecycle.activate(id, true));
await lifecycle.activate(process.env.AGENT_ID);
resumeOwnerIntents();
let queue = Promise.resolve();
let stopping = false;
process.on("message", (raw: unknown) => {
  if (stopping || !raw || typeof raw !== "object" || !("id" in raw) || !("command" in raw) || typeof raw.id !== "string") return;
  const { id, command } = raw;
  queue = queue.then(async () => {
    try {
      if (stopping) throw new Error("Work order executor is stopping.");
      const result = await handleWorkOrderCommand(workOrderCommand.parse(command));
      process.send?.({ id, result });
    } catch (error) { process.send?.({ id, error: error instanceof Error ? error.message : "Work order action unavailable." }); }
  }).catch(() => { /* a disconnected caller never authorizes another send */ });
});
async function stop() {
  if (stopping) return;
  stopping = true;
  // Let any accepted action finish its durable record before releasing the lifetime leases.
  await queue;
  await lifecycle.close();
  await instanceRelease();
  process.exit(0);
}
process.once("disconnect", () => void stop());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());
process.send({ ready: true });
