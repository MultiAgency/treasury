// The emergency stop as the frame shows it (#133): whether the agent is frozen, whether a freeze or unfreeze is awaiting
// its outcome, and what the owner may do about it. Pure, so it's tested without a browser.
// With its extensions: test/freeze-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.
import { awaiting, holdsEach, type OwnerActionRecord } from "../../apps/server/src/owner-action.ts";

type Action = Pick<OwnerActionRecord, "type" | "stage" | "phase" | "signer" | "expiresAt" | "correlationId">;

/**
 * What a freeze or unfreeze waits on, if anything, as `awaiting` decides it (the server holds by the same rule).
 * `owner/actions` holds both kinds: the platform builds `owner/pending` from the same records.
 */
export function waitingStop(input: { actions: readonly Action[]; now: number }) { return waitingOn("agent_freeze", input); }

export type Waiting = { correlationId: string; type: string; why: "submitted" | "vote"; expiresAt: string };
/** What an owner action of `kind` waits on, if anything: an earlier one that holds it (`holdsEach`) awaiting its outcome, as the server holds. */
export function waitingOn(kind: string, { actions, now }: { actions: readonly Action[]; now: number }): Waiting | undefined {
  for (const action of actions) {
    const why = holdsEach(kind, action.type) ? awaiting(action, now) : undefined;
    if (why) return { correlationId: action.correlationId, type: action.type, why, expiresAt: action.expiresAt };
  }
  return undefined;
}

export type StopControls =
  /** The agent isn't connected, so its state can't be read and nothing can be prepared. */
  | { kind: "not-connected" }
  /** A wallet owner whose connection predates owner actions by default. */
  | { kind: "needs-owner-scope" }
  /** A DAO member who may not file proposals. */
  | { kind: "needs-member" }
  | { kind: "ready"; action: "freeze" | "unfreeze"; label: string };

/**
 * What the frame offers: Freeze while the agent runs, Unfreeze while it is frozen; a DAO's member proposes ("Propose to
 * freeze"). A control that can't work says why instead of disappearing: an emergency stop is never hidden.
 */
export function stopControls({ connected, ownerScope, signer, canPropose, frozen }: { connected: boolean; ownerScope: boolean; signer: "wallet" | "dao"; canPropose: boolean; frozen: boolean | undefined }): StopControls {
  if (!connected) return { kind: "not-connected" };
  if (signer === "wallet" && !ownerScope) return { kind: "needs-owner-scope" };
  if (signer === "dao" && !canPropose) return { kind: "needs-member" };
  // Unknown (the overview wasn't read): the stop is still offered, since freezing an already frozen agent is refused harmlessly.
  const action = frozen === true ? "unfreeze" : "freeze";
  const verb = action === "freeze" ? "Freeze" : "Unfreeze";
  return { kind: "ready", action, label: signer === "dao" ? `Propose to ${action}` : verb };
}
