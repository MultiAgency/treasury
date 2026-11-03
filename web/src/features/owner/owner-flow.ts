import { answered, failureMessage, PlatformError, type agent, type Intent, type OwnerAction, type Setup, type Transaction } from "../../platform.ts";
import { observeOwnerAction } from "./owner-observation.ts";

export type Signer = "wallet" | "dao";
export type Step = "preparing" | "signing" | "filing" | "voting" | "settling";
/** Who signs this agent's owner actions: the linked DAO when its owner account owns the agent. */
export const ownerSigner = (setup: Setup): Signer =>
  setup.dao && setup.owner?.type === "near" && setup.owner.account_id === setup.dao.owner.account_id ? "dao" : "wallet";

/** The wallet steps an owner action takes, outside this module so the flow itself is plain code. */
export type Wallets = {
  signIntent(intent: Intent): Promise<Record<string, unknown>>;
  ownerWallet(): Promise<{ type: "near"; account_id: string; public_key: string }>;
  /** Whether the signed-in member's own wallet is connected, to file a proposal from it. */
  memberConnected(): Promise<boolean>;
  sendAsMember(transaction: Transaction): Promise<unknown>;
  /** Trezu connected as the DAO, or a throw. */
  ensureDao(daoId: string): Promise<void>;
  sendAsDao(transaction: Transaction): Promise<unknown>;
};

/** What the flow reports as it goes. `unknown` is the message for a submission whose outcome is unknown. */
export type Progress = {
  step(step: Step, deadline?: string): void;
  prepared(correlationId: string, digest: string | null): void;
  unknown(message: string): void;
};

/**
 * How a run ended. `unknown` is set when a submission's outcome was unknown and no status read has settled it since:
 * nothing may be signed or submitted again while it is.
 */
export type Ended = { ok: true } | { ok: false; error: unknown; unknown?: string };

/**
 * One owner action end to end. The owner's wallet signs the API's payload directly; a DAO files one proposal through
 * Trezu or the member's own wallet, asking its MPC key to sign, and the server submits the signature once the vote
 * passes, inside the API's signing window. A submission whose outcome is unknown is followed by its `correlationId`:
 * never signed or submitted again.
 */
export async function runOwnerAction({ api, wallets, setup, access, action, signer, signal, progress, intervalMs }: {
  api: ReturnType<typeof agent>; wallets: Wallets; setup: Setup; access: { canPropose: boolean; canVote: boolean } | null;
  action: OwnerAction; signer: Signer; signal: AbortSignal; progress: Progress; intervalMs?: number;
}): Promise<Ended> {
  let unknown: string | undefined;

  /** Whether an owner action ended the way it was meant to: a rejected payment is a reject vote's success. */
  async function ended(id: string, status?: string, failureCode?: string | null) {
    if (action.type === "approval_vote") {
      const record = (await api.read("owner/actions", undefined)).find(a => a.correlationId === id);
      if (record?.ownerSucceeded) return;
      throw new Error("Owner approval outcome could not be confirmed. Review the existing owner action before signing again.");
    }
    if (status === "SUCCESS") return;
    if (!status) throw new Error("The owner action’s outcome isn’t confirmed. Check its record before signing again.");
    throw new Error(failureCode ?? `Ended ${status.toLowerCase()}`);
  }
  async function follow(id: string) {
    const state = await observeOwnerAction(signal => api.read("owner/status", { correlationId: id }, { signal }), signal,
      state => { if (state.stage === "submitting") progress.step("settling"); }, intervalMs);
    // A status read that ends in one of these settles the outcome; an unknown stage doesn't.
    if (state.stage === "submitted" || state.stage === "expired" || state.stage === "failed") unknown = undefined;
    if (state.stage === "submitted") return ended(id, state.status, state.failureCode);
    if (state.stage === "expired") throw new Error("The signing window closed. Review the existing owner action.");
    if (state.stage === "failed") throw new Error(state.error ?? "Owner action failed");
    throw new Error("Owner action needs review. Follow its existing record before signing again.");
  }

  async function viaDao() {
    if (!setup.dao) throw new Error("Link the DAO as the treasury first");
    // A member who may file proposals files it from their own connected wallet, with a description saying what it
    // signs; otherwise Trezu files it, as a generic "sign on v1.signer". Either is ready before anything is prepared.
    const ownWallet = Boolean(access?.canPropose) && await wallets.memberConnected();
    if (!ownWallet) await wallets.ensureDao(setup.dao.id);
    const prepared = answered(await api.act("owner/prepare", { action, signer: "dao" }));
    if (!prepared.dao) throw new Error("The server did not prepare a DAO signature");
    progress.prepared(prepared.correlationId, prepared.digest);
    signal.throwIfAborted();
    progress.step("filing");
    // A member who may also vote files and casts their vote together; the DAO threshold still applies.
    const filing = access?.canVote && prepared.dao.proposalAndVote ? prepared.dao.proposalAndVote : prepared.dao.proposal;
    if (ownWallet && filing) {
      const outcome = (await wallets.sendAsMember(filing)) as { status?: { Failure?: unknown } } | undefined;
      // Reverted as one, so nothing was filed: most likely another proposal took the id the vote named.
      if (outcome?.status?.Failure) throw new Error(`The transaction failed, so nothing was filed. Try again. ${JSON.stringify(outcome.status.Failure)}`);
    } else {
      // The member's own filing needs the DAO's policy, which the server couldn't read: Trezu files it instead.
      if (ownWallet) await wallets.ensureDao(setup.dao.id);
      await wallets.sendAsDao(prepared.dao.transaction);
    }
    progress.step("voting", prepared.expiresAt);
    // The server watches for the DAO's signature and submits it; follow it to the end.
    await follow(prepared.correlationId);
  }

  async function viaWallet() {
    const prepared = answered(await api.act("owner/prepare", {
      action: action.type === "agent_create" ? { ...action, owner: await wallets.ownerWallet() } : action,
      signer: "wallet",
    }));
    if (!prepared.intent) throw new Error("The server did not prepare a wallet signature");
    progress.prepared(prepared.correlationId, prepared.digest);
    signal.throwIfAborted();
    progress.step("signing");
    const signedData = await wallets.signIntent(prepared.intent);
    progress.step("settling");
    const submitted = await api.act("owner/submit", { correlationId: prepared.correlationId, signedData });
    if (submitted.ok) {
      if (["SUCCESS", "FAILED", "REFUNDED"].includes(submitted.value.status))
        return ended(prepared.correlationId, submitted.value.status, submitted.value.failureCode);
    } else if (submitted.kind === "unknown") {
      unknown = failureMessage(submitted);
      progress.unknown(unknown);
    } else {
      // A refusal may still have been recorded as submitted: follow it then. If that can't be read, the refusal stands.
      const state = await api.read("owner/status", { correlationId: prepared.correlationId }).catch(() => undefined);
      if (state?.stage !== "submitting" && state?.stage !== "submitted") throw new PlatformError(submitted);
    }
    // An accepted or ambiguous submission is followed by ID, never signed or sent again.
    await follow(prepared.correlationId);
  }

  try {
    progress.step("preparing");
    await (signer === "dao" ? viaDao() : viaWallet());
    return { ok: true };
  } catch (error) {
    return { ok: false, error, ...(unknown && { unknown }) };
  }
}
