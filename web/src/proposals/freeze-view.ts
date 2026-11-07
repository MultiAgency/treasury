// The emergency stop as the frame shows it (#133): whether the agent is frozen, whether a freeze or unfreeze is awaiting
// its outcome, and what the owner may do about it. Pure, so it's tested without a browser.
// With its extensions: test/freeze-view.test.ts loads this module under Node, which resolves only explicit `.ts` paths.

type Action = { type: string; stage: "settled" | "submitted" | "expired" | "prepared"; signer: "dao" | "wallet"; expiresAt: string; correlationId: string };

const STOPS = new Set(["agent_freeze", "agent_unfreeze"]);
export const isStop = (type: string) => STOPS.has(type);

/**
 * What a freeze or unfreeze waits on, if anything: one submitted whose outcome isn't recorded yet, a DAO's request still
 * waiting for its vote. `owner/actions` holds both: the platform builds `owner/pending` from the same records. A wallet owner's intent that was only
 * prepared isn't waited on: it was never signed, so it can be prepared again (the server holds the same way).
 */
export function waitingStop({ actions, now }: { actions: readonly Action[]; now: number }): { correlationId: string; type: string; why: "submitted" | "vote"; expiresAt: string } | undefined {
  const live = (expiresAt: string) => Date.parse(expiresAt) > now;
  for (const action of actions) {
    if (!isStop(action.type)) continue;
    if (action.stage === "submitted") return { correlationId: action.correlationId, type: action.type, why: "submitted", expiresAt: action.expiresAt };
    if (action.stage === "prepared" && action.signer === "dao" && live(action.expiresAt)) return { correlationId: action.correlationId, type: action.type, why: "vote", expiresAt: action.expiresAt };
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
