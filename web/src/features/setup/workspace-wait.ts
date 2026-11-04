import type { Gateway } from "../../platform.ts";

/**
 * The access wait (the prototype's A7 `access-wait`): a hosted agent stays closed until its server first answers, so the
 * new workspace opens only once the session's own discovery grants access to it. Opening it earlier showed "Access
 * unavailable". The wait reads discovery only; it never reserves again.
 */
export const ACCESS_WAIT_GUARD = "Another account signed in before the new workspace opened.";
export const SIGNED_OUT_WAIT = "You were signed out before the new workspace opened. Sign in again to open it.";
export const ACCESS_WAIT_TIMEOUT = "The new workspace hasn’t opened yet: this account has no access to it so far. It may still be starting. Nothing was signed and no agent was created.";

export type WorkspaceState = "open" | "waiting" | "signed-out" | "switched";

/** What discovery says about the workspace `name` reserved by `account`: open it only for that account, once it has access. */
export function workspaceState(found: Pick<Gateway, "viewer">, account: string, name: string): WorkspaceState {
  if (!found.viewer) return "signed-out";
  if (found.viewer.account !== account) return "switched";
  return found.viewer.access[name] ? "open" : "waiting";
}

export type WaitEnd = { state: "open" | "signed-out" | "switched" } | { state: "timeout"; lastError?: string };

/**
 * Reads discovery every `intervalMs` until the workspace opens for `account`, another account or none is signed in, or
 * `timeoutMs` passes. A failed read is read again within the budget: it decides nothing.
 */
export async function waitForWorkspace({ me, account, name, signal, timeoutMs = 45_000, intervalMs = 1_000, now = Date.now,
  sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms)) }: {
  me: () => Promise<Pick<Gateway, "viewer">>; account: string; name: string; signal: AbortSignal;
  timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<WaitEnd> {
  const deadline = now() + timeoutMs;
  let lastError: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    try {
      const state = workspaceState(await me(), account, name);
      lastError = undefined;
      if (state !== "waiting") return { state };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    signal.throwIfAborted();
    if (now() >= deadline) return { state: "timeout", ...(lastError && { lastError }) };
    await sleep(intervalMs);
  }
}
