import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AGENT } from "../app/location";
import { useViewer } from "../app/viewer";
import { scope } from "../platform";
import { errorMessage } from "./ui";

/** One action at a time with its outcome: `attempt` runs it, shows its message or its error, and refreshes this agent's reads. */
export function useAttempt() {
  const queryClient = useQueryClient();
  const account = useViewer()?.account ?? null;
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
      await queryClient.invalidateQueries({ queryKey: [scope(AGENT!, account)] });
    }
  }
  return { message, error, busy, attempt };
}
