import { useEffect, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { errorMessage } from "./provider-message";
import { refreshQueries } from "./query-refresh";

/** Seconds until `iso`, ticking while `iso` is set. */
export function useCountdown(iso?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return iso ? Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000)) : null;
}

/**
 * One action at a time with its outcome: `attempt` runs it, shows its message or its error, and
 * refreshes affected reads on success or failure. Money actions default to refreshing every read.
 */
export function useAttempt(refreshKeys?: readonly QueryKey[]) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Runs `work`; a string it returns is shown as its outcome. */
  async function attempt(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const outcome = await work();
      setMessage(typeof outcome === "string" && outcome ? outcome : undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refreshQueries(queryClient, refreshKeys);
    }
  }
  return { message, error, busy, attempt };
}

/**
 * Follows one strategy stream into React state. Every run refreshes the book and the
 * activity log when it ends, whether it executed, stopped or failed. Plan previews may select narrower refreshes.
 */
export function useRun<I, E>(start: (input: I) => Promise<AsyncIterable<E>>, refreshKeys?: readonly QueryKey[]) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<E[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [input, setInput] = useState<I>();
  const [error, setError] = useState<string>();

  async function run(next: I) {
    setInput(next);
    setEvents([]);
    setError(undefined);
    setState("running");
    try {
      for await (const event of await start(next)) setEvents((all) => [...all, event]);
      setState("done");
    } catch (e) {
      setError(errorMessage(e));
      setState("error");
    } finally {
      await refreshQueries(queryClient, refreshKeys);
    }
  }

  return { events, state, input, error, run };
}
