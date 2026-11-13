import { spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import type { TestContext } from "node:test";

/** A timeout or cancellation must reject the wait itself, not just cancel the enclosing test. */
export function deadline<T>(pending: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (done: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      done();
    };
    const aborted = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${ms} ms`))), ms);
    signal?.addEventListener("abort", aborted, { once: true });
    pending.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal?.aborted) aborted();
  });
}

/** Own a worker for the whole test, including cancellation while an awaited promise never settles. */
export function testChild(t: TestContext, args: string[], options: SpawnOptions, {
  messageMs = 35_000, exitMs = 10_000, cleanupMs = 5_000,
} = {}) {
  t.signal.throwIfAborted();
  const child = spawn(process.execPath, args, options);
  let stderr = "", ended = false;
  child.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-8_192); });
  const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
    child.once("error", error => { ended = true; resolve({ code: null, signal: null, error }); });
    child.once("exit", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  const kill = () => { if (!ended) child.kill("SIGKILL"); };
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    kill();
    try { await deadline(outcome, cleanupMs, "Worker cleanup"); }
    finally {
      t.signal.removeEventListener("abort", kill);
      if (child.connected) child.disconnect();
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      child.unref();
    }
  })();
  t.after(stop);
  t.signal.addEventListener("abort", kill, { once: true });
  return {
    child, stop,
    async next<T = unknown>(): Promise<T> {
      t.signal.throwIfAborted();
      const listening = new AbortController();
      try {
        return await deadline(Promise.race([
          once(child, "message", { signal: listening.signal }).then(([message]) => message as T),
          outcome.then(result => { throw result.error ?? new Error(`Worker exited before evidence (${result.code ?? result.signal}): ${stderr}`); }),
        ]), messageMs, "Worker evidence", t.signal);
      } catch (error) { kill(); throw error; }
      finally { listening.abort(); }
    },
    async exit(): Promise<[number | null, NodeJS.Signals | null]> {
      try {
        const result = await deadline(outcome, exitMs, "Worker exit", t.signal);
        if (result.error) throw result.error;
        return [result.code, result.signal];
      } catch (error) { kill(); throw error; }
    },
  };
}

/** Register disposal before startup; even a resource returned after cancellation is disposed. */
export async function testResource<T>(t: TestContext, create: () => Promise<T>, dispose: (resource: T) => Promise<void>) {
  t.signal.throwIfAborted();
  let resource: T, ready = false, closed = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    closed = true;
    if (!ready) return Promise.resolve();
    return stopping ??= deadline(Promise.resolve().then(() => dispose(resource)), 10_000, "Resource cleanup");
  };
  t.after(stop);
  const starting = Promise.resolve().then(create).then(async value => {
    resource = value; ready = true;
    if (closed || t.signal.aborted) {
      await stop();
      throw t.signal.reason ?? new Error("Test ended before resource startup");
    }
    return value;
  });
  try { return { resource: await deadline(starting, 120_000, "Resource startup", t.signal), stop }; }
  catch (error) { await stop(); throw error; }
}
