// Child process for lock.test.ts, run in a temporary directory:
//   hold          take the money lock and keep it until killed
//   try           try to take it; print acquired / busy / unresolved
//   crash-after-log  take it, log a request as dispatch does before sending, then die mid-operation
import { acquireMoneyLock, MoneyLockBusy, UnresolvedOperations } from "../../src/lock.js";
import { record } from "../../src/ops.js";

const mode = process.argv[2];
try {
  const lock = await acquireMoneyLock();
  if (mode === "hold") {
    console.log(`held ${process.pid}`);
    setInterval(() => {}, 1000);
  } else if (mode === "crash-after-log") {
    record({ at: new Date().toISOString(), idempotencyKey: "swap:crashed", kind: "rebalance", method: "swap", request: { origin_asset: "a", destination_asset: "b", amount: "1" } });
    process.kill(process.pid, "SIGKILL");
  } else {
    console.log("acquired");
    await lock.release();
  }
} catch (error) {
  console.log(error instanceof MoneyLockBusy ? "busy" : error instanceof UnresolvedOperations ? "unresolved" : `error ${error}`);
}
