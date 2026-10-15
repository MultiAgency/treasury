import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";

/** One long-lived executor per agent on this host/user, even across working directories.
 * Remote hosts still require the documented single-host deployment; this is not fencing. */
export async function acquireExecutorLease(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid agent id");
  try {
    return await lockfile.lock(join(tmpdir(), `treasury-executor-${id}`), {
      realpath: false, retries: 0, stale: 10_000, update: 2_000,
      onCompromised: () => {
        console.error("Executor ownership lost; stopping. Reconcile in-flight operations before restarting.");
        process.exit(1);
      },
    });
  } catch (cause) {
    throw new Error("An executor for this agent is already running or cannot acquire ownership. Use its dashboard and invoice listener.", { cause });
  }
}
