import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AGENT } from "../app/location";
import { useViewer } from "../app/viewer";
import type { OwnerFailure } from "@multiagency/sdk";
import { failureKind, scope } from "../platform";
import { errorMessage } from "./ui";

/**
 * One action at a time with its outcome: `attempt` runs it, shows its message or its error, and refreshes this agent's reads.
 * After an outcome that is unknown, `unknown` stays set: that control isn't offered again from this page.
 */
export function useAttempt() {
  const queryClient = useQueryClient();
  const account = useViewer()?.account ?? null;
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
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
      if (failureKind(e) === "unknown") setUnknown(true);
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: [scope(AGENT!, account)] });
    }
  }
  return { message, error, busy, unknown, attempt };
}

/**
 * One stream at a time, sent once by `start`, with its events as they arrive. `settle` decides its outcome from the events
 * and how the stream ended, and `run` answers it; a throw before any event is its error. Either way this agent's reads are
 * refreshed, and nothing is sent again.
 */
export function useRun<I, E, O>(start: (input: I, onEvent: (event: E) => void) => Promise<OwnerFailure | undefined>,
  settle: (ended: OwnerFailure | undefined, events: E[], input: I) => O) {
  const queryClient = useQueryClient();
  const account = useViewer()?.account ?? null;
  const [events, setEvents] = useState<E[]>([]);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState<I>();
  const [outcome, setOutcome] = useState<O>();
  const [error, setError] = useState<string>();
  async function run(next: I): Promise<O | undefined> {
    const seen: E[] = [];
    let settled: O | undefined;
    setInput(next);
    setEvents([]);
    setOutcome(undefined);
    setError(undefined);
    setRunning(true);
    try {
      const ended = await start(next, event => { seen.push(event); setEvents([...seen]); });
      settled = settle(ended, seen, next);
      setOutcome(settled);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
      await queryClient.invalidateQueries({ queryKey: [scope(AGENT!, account)] });
    }
    return settled;
  }
  return { events, running, input, outcome, error, run };
}
