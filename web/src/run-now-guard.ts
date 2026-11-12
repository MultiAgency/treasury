import { useSyncExternalStore } from "react";
import type { Result } from "./server-api.ts";

type Reply = Result<{ summary: string }>;
export type RunNowHold = "pending" | "unknown";

/**
 * Tick has no caller request id or returned run id. Neither a later schedule read nor a nearby recorded run proves
 * which attempt answered, so an unknown reply holds Run now for this loaded app. The store survives route changes;
 * a reload or another tab starts a separate store. Only the matching attempt's definite reply releases its hold.
 */
export function createRunNowGuard() {
  const attempts = new Map<string, { phase: RunNowHold }>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const hold = (agent: string) => attempts.get(agent)?.phase;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  /** Claim synchronously before calling the server, including while a previous component is still awaiting its reply. */
  const run = async (agent: string, send: () => Promise<Reply>): Promise<Reply | undefined> => {
    if (attempts.has(agent)) return undefined;
    const attempt = { phase: "pending" as RunNowHold };
    attempts.set(agent, attempt);
    changed();
    let answer: Reply;
    try { answer = await send(); }
    catch { answer = { ok: false, kind: "lost" }; }

    if (attempts.get(agent) === attempt) {
      // These are parsed replies, not HTTP/message guesses. `unavailable` can mean a mutation's reply was lost.
      if (answer.ok || answer.kind === "refused" || answer.kind === "not_owner" || answer.kind === "not_signed_in")
        attempts.delete(agent);
      else attempt.phase = "unknown";
      changed();
    }
    return answer;
  };

  return { hold, subscribe, run };
}

const guard = createRunNowGuard();
export const runNowOnce = guard.run;
export const useRunNowHold = (agent: string) => useSyncExternalStore(guard.subscribe, () => guard.hold(agent));
