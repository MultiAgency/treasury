import { failureKind } from "../../platform.ts";

/**
 * Observes an existing intent only. It never prepares, signs, or submits one. A status read whose answer was lost is
 * read again at the next interval: it says nothing about the action, so it neither ends the observation nor offers it again.
 * It reads on while `pending` says the state isn't final: by default, while a DAO votes or a submission settles.
 */
export type OwnerObservation = { stage: string; status?: string; failureCode?: string | null; error?: string };
export async function observeOwnerAction<T extends OwnerObservation>(
  read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  onObservation: (state: T) => void = () => {}, intervalMs = 5_000,
  pending: (state: T) => boolean = state => state.stage === "voting" || state.stage === "submitting",
): Promise<T> {
  while (true) {
    signal.throwIfAborted();
    const state = await read(signal).catch((error: unknown) => {
      if (failureKind(error) === "unavailable") return undefined;
      throw error;
    });
    signal.throwIfAborted();
    if (state) {
      onObservation(state);
      if (!pending(state)) return state;
    }
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

/**
 * The first record of `types` whose outcome isn't known yet: a submission attempted (`submitted`), or a DAO proposal
 * filed and awaiting its vote (`prepared` with signer `dao`). While one exists, no other is signed or proposed. A wallet
 * action only prepared was never signed, so it doesn't block.
 */
export function awaitingOutcome<T extends { type: string; stage: string; signer: string }>(records: readonly T[], types: readonly string[]) {
  return records.find(a => types.includes(a.type) && (a.stage === "submitted" || (a.stage === "prepared" && a.signer === "dao")));
}
