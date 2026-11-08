/**
 * What a wallet reports for a transaction it sent, read from near-connect's `FinalExecutionOutcome` (0.14.1), whose
 * `status` is `FinalExecutionStatus | "NotStarted" | "Started" | "Failure"`. Only a success status proves it executed;
 * a failure reverted it as one receipt; anything else, or no outcome at all, may or may not have gone out.
 */
export type TransactionOutcome = { kind: "succeeded" } | { kind: "failed"; failure: unknown } | { kind: "unknown" };

export function transactionOutcome(outcome: unknown): TransactionOutcome {
  const status = typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
  if (status === "Failure") return { kind: "failed", failure: status };
  if (typeof status !== "object" || status === null) return { kind: "unknown" };
  if ("Failure" in status && (status as { Failure?: unknown }).Failure !== undefined) return { kind: "failed", failure: (status as { Failure: unknown }).Failure };
  if (typeof (status as { SuccessValue?: unknown }).SuccessValue === "string" || typeof (status as { SuccessReceiptId?: unknown }).SuccessReceiptId === "string")
    return { kind: "succeeded" };
  return { kind: "unknown" };
}

/** The request a wallet signs: the connected account is the signer, whatever the prepared transaction carries. */
export const asSigner = <T extends object>(signerId: string, transaction: T) => ({ ...transaction, signerId });
