// An owner action's lifecycle (a grant, a freeze, a revocation, a policy edit, an agent's creation), as the platform
// records it: the one statement of it, which the server's routes and the pages both decide by, so they hold alike.
// Pure, and with its extensions: the pages' tests load it under Node, which resolves only explicit `.ts` paths.
import type { z } from "zod";
import type { ownerActionsRead, ownerActionStatus } from "./contract.ts";

/**
 * An action as `owner/actions` records it, and a status as `owner/status` answers it. The SDK's phase names their shared
 * lifecycle; the older stage names remain accepted for platforms that don't send a phase.
 */
export type OwnerActionRecord = z.output<typeof ownerActionsRead>[number];
export type OwnerStatus = z.output<typeof ownerActionStatus>;
export type OwnerPhase = NonNullable<OwnerStatus["phase"]>;
export type OwnerOutcome = "succeeded" | "failed" | "expired" | "unconfirmed";

/** The durable action record's phase, with the SDK's phase taking priority over its older stage. */
export function actionPhase(action: Pick<OwnerActionRecord, "stage" | "phase">): OwnerPhase {
  if (action.phase !== undefined) return action.phase;
  return action.stage === "prepared" ? "open" : action.stage;
}

/** The status read's phase; an unknown record has no established phase. */
export function statusPhase(status: OwnerStatus | undefined): OwnerPhase | undefined {
  if (status?.phase !== undefined) return status.phase;
  switch (status?.stage) {
    case "voting": return "open";
    case "submitting": return "submitted";
    case "submitted":
    case "failed": return "settled";
    case "expired": return "expired";
    default: return undefined;
  }
}

/**
 * Whether `action` is still awaiting its outcome, and why, at `now`: the `submitted` phase whose outcome isn't recorded
 * yet, or a DAO's `open` phase whose voting deadline hasn't passed, which a second filing would duplicate. A wallet owner's open
 * intent awaits nothing: it was never signed, so it can be prepared again (a reload mid-signature must not delay an
 * emergency stop), and the old one expires.
 */
export function awaiting(action: Pick<OwnerActionRecord, "stage" | "phase" | "signer" | "expiresAt">, now: number): "submitted" | "vote" | undefined {
  const phase = actionPhase(action);
  if (phase === "submitted") return "submitted";
  if (phase === "open" && action.signer === "dao" && Date.parse(action.expiresAt) > now) return "vote";
  return undefined;
}

/** Which owner actions hold each other while one awaits its outcome: a freeze and an unfreeze do, the rest only their own kind. */
const STOPS = new Set(["agent_freeze", "agent_unfreeze"]);
export const isStop = (type: string) => STOPS.has(type);
export const holdsEach = (type: string, other: string) => isStop(type) ? isStop(other) : other === type;

/**
 * Whether following an action may stop: its signing window expired before submission, or the platform recorded a
 * settlement. A settled phase alone doesn't establish success; the provider's status decides its outcome below.
 */
export function isFinal(status: OwnerStatus | undefined): boolean {
  const phase = statusPhase(status);
  return phase === "expired" || phase === "settled";
}

/** A terminal outcome proven by the status read; an unfamiliar or missing terminal status never establishes success. */
export function outcomeOf(status: OwnerStatus | undefined): OwnerOutcome | undefined {
  const phase = statusPhase(status);
  if (phase === "expired") return "expired";
  if (phase !== "settled" || !status) return undefined;
  if (status.phase === undefined && status.stage === "failed") return "failed";
  if (status.status === "SUCCESS") return "succeeded";
  if (status.status === "FAILED" || status.status === "REFUNDED") return "failed";
  if (status.status === "EXPIRED" && status.failureCode === "signing_window_closed") return "expired";
  return "unconfirmed";
}

/** The words for every lifecycle phase, an unknown record, and terminal outcomes that aren't proven success. */
export type PhaseWords = Record<OwnerPhase | "unknown" | "failed" | "unconfirmed", string>;

/** The action's current phase or terminal outcome in the words for that kind of action. */
export function statusText(status: OwnerStatus | undefined, words: PhaseWords): string {
  if (!status) return "Reading its status…";
  const phase = statusPhase(status);
  if (phase === "settled") {
    const outcome = outcomeOf(status)!;
    return outcome === "succeeded" ? words.settled : words[outcome];
  }
  return phase === undefined ? words.unknown : words[phase];
}
