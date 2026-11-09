// An owner action's lifecycle (a grant, a freeze, a revocation, a policy edit, an agent's creation), as the platform
// records it: the one statement of it, which the server's routes and the pages both decide by, so they hold alike.
// Pure, and with its extensions: the pages' tests load it under Node, which resolves only explicit `.ts` paths.
import type { z } from "zod";
import type { ownerActionsRead, ownerActionStatus } from "./contract.ts";

/**
 * An action as `owner/actions` records it. `prepared` → `submitted` → `settled` once signed (a wallet's intent or the
 * confirm page) or voted through (a DAO); `prepared` → `expired` when neither happened in time.
 */
export type OwnerActionRecord = z.output<typeof ownerActionsRead>[number];

/**
 * Whether `action` is still awaiting its outcome, and why, at `now`: one `submitted` whose outcome isn't recorded yet, or
 * a DAO's `prepared` one whose vote is still open, which a second filing would duplicate. A wallet owner's `prepared`
 * intent awaits nothing: it was never signed, so it can be prepared again (a reload mid-signature must not delay an
 * emergency stop), and the old one expires.
 */
export function awaiting(action: Pick<OwnerActionRecord, "stage" | "signer" | "expiresAt">, now: number): "submitted" | "vote" | undefined {
  if (action.stage === "submitted") return "submitted";
  if (action.stage === "prepared" && action.signer === "dao" && Date.parse(action.expiresAt) > now) return "vote";
  return undefined;
}

/** Which owner actions hold each other while one awaits its outcome: a freeze and an unfreeze do, the rest only their own kind. */
const STOPS = new Set(["agent_freeze", "agent_unfreeze"]);
export const isStop = (type: string) => STOPS.has(type);
export const holdsEach = (type: string, other: string) => isStop(type) ? isStop(other) : other === type;

/**
 * Where one action stands as `owner/status` answers it, followed by its correlation ID: `voting` (awaiting the signature
 * or the DAO's vote) → `submitting` → `submitted`; or `expired`, or `failed`. `unknown` is not final: it is read again,
 * and nothing is sent again meanwhile.
 */
export type OwnerStage = z.output<typeof ownerActionStatus>["stage"];
const FINAL: ReadonlySet<string> = new Set<OwnerStage>(["submitted", "expired", "failed"]);
/** Whether `stage` is final: following it stops, and only `submitted` took effect. */
export const isFinal = (stage: string | undefined): stage is "submitted" | "expired" | "failed" => stage !== undefined && FINAL.has(stage);

/** What has happened to one kind of action at each stage, in the owner's words: every stage has its words. */
export type StageWords = Record<OwnerStage, string>;
