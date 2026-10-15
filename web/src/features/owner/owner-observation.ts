/** Observes an existing intent only. It never prepares, signs, or submits one. */
export type OwnerObservation = { stage: string; status?: string; failureCode?: string | null; error?: string };
export async function observeOwnerAction<T extends OwnerObservation>(
  read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  onObservation: (state: T) => void = () => {}, intervalMs = 5_000,
): Promise<T> {
  while (true) {
    signal.throwIfAborted();
    const state = await read(signal);
    signal.throwIfAborted();
    onObservation(state);
    if (!["voting", "submitting"].includes(state.stage)) return state;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, intervalMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export function ownerActionState<T extends { stage: string; ownerSucceeded?: boolean }>(records: T[]) {
  return {
    records,
    recovering: records.find(a => a.stage === "prepared" || a.stage === "submitted"),
    succeeded: records.find(a => a.ownerSucceeded),
  };
}
