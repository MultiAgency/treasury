import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { ENV_FILE, saveEnv } from "../../src/env.js";

// Pause after reading a snapshot, so the parent can attempt a competing update.
if (process.argv[3] === "pause") {
  const read = fs.readFileSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const result = Reflect.apply(read, fs, [path, ...args]);
    if (String(path) === ENV_FILE || String(path) === fs.realpathSync(ENV_FILE)) {
      fs.writeFileSync("writer-ready", "ready");
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync("writer-release")) {
        if (Date.now() > deadline) throw new Error("Fixture release timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return result;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
}
saveEnv(JSON.parse(process.argv[2]!));
