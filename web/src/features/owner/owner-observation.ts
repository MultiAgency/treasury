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

/** How long past a confirm page's window it may still be signed, by this page's clock: the platform's clock isn't this page's. */
export const CONFIRM_GRACE_MS = 10 * 60_000;

/**
 * The first record of `types` whose outcome isn't known yet: a submission attempted (`submitted`), a DAO proposal filed
 * and awaiting its vote (`prepared` with signer `dao`), or a wallet policy update prepared and inside its signing window
 * with `CONFIRM_GRACE_MS` added: the platform's confirm page can sign that one. While one exists, no other is signed or proposed. Any other wallet
 * action only prepared was never signed, so it doesn't block; a window that can't be read is taken as still open.
 */
export function awaitingOutcome<T extends { type: string; stage: string; signer: string; expiresAt: string }>(
  records: readonly T[], types: readonly string[], now = Date.now(),
) {
  return records.find(a => types.includes(a.type) && (a.stage === "submitted" || (a.stage === "prepared"
    && (a.signer === "dao" || (a.type === "policy_update" && !(Date.parse(a.expiresAt) + CONFIRM_GRACE_MS <= now))))));
}

/**
 * The action types an awaited `type` holds back: freeze and unfreeze each other, since the agent ends in whichever state
 * lands last; any other type only itself. The platform holds back neither for a wallet owner, so this is the guard.
 */
export const heldTogether = <T extends string>(type: T): readonly (T | "agent_freeze" | "agent_unfreeze")[] =>
  type === "agent_freeze" || type === "agent_unfreeze" ? ["agent_freeze", "agent_unfreeze"] : [type];

/** What an earlier action of a type is called in the note that holds back another. */
const EARLIER: Record<string, string> = {
  agent_freeze: "freeze", agent_unfreeze: "unfreeze", policy_update: "policy update", grant_issue: "grant", grant_revoke: "revocation",
  approval_vote: "approval vote",
};

/** Why another action isn't signed or proposed while `record`'s outcome isn't known. */
export function pendingNote(record: { type: string; stage: string; signer: string }, dao?: string) {
  const earlier = `An earlier ${EARLIER[record.type] ?? record.type.replace(/_/g, " ")}`;
  return record.stage === "submitted" ? `${earlier} was submitted and its outcome is still being checked. Do not sign again.`
    : record.signer === "dao" ? `${earlier} was proposed to ${dao ?? "the DAO"} and awaits its vote. Do not propose again.`
      : `${earlier} can still be signed on the platform’s confirm page until its signing window closes. Do not sign another.`;
}
