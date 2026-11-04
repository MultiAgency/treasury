import { execFile } from "node:child_process";

/** How long a notifier may run before it's killed. */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** Hands one proposal to the builder's channel. Never throws: a failure is reported, and the loop goes on. */
export type Notify = (payload: unknown) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * Runs `command` with `args` once per proposal: without a shell, so nothing in a proposal is read as shell syntax, and
 * with the proposal as JSON on stdin only. Its environment is built here, `PATH` only by default: the server runs with
 * `.env` loaded, so passing ours on would hand the notifier its settings and secrets (`FASTNEAR_API_KEY`), and the
 * credential file's path. Its stdout is discarded; its stderr's end is reported when it fails.
 */
export function notifier([command, ...args]: [string, ...string[]], { timeoutMs = NOTIFY_TIMEOUT_MS, env = { PATH: process.env.PATH ?? "" } } = {}): Notify {
  return payload => new Promise(resolve => {
    const child = execFile(command, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", shell: false, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true });
      const why = error.killed ? `timed out after ${timeoutMs / 1000}s`
        : typeof error.code === "number" ? `exited with ${error.code}`
        : error.signal ? `ended by ${error.signal}`
        : error.message;
      resolve({ ok: false, error: stderr.trim() ? `${why}: ${stderr.trim().slice(-500)}` : why });
    });
    // A notifier that exits without reading stdin closes the pipe; its exit decides the result.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}
