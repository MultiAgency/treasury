import { AgentApiError } from "@near-intents-agent-api/sdk";

export type RefusalDetails = { availableAt?: string; budgetRemainingUsd?: string };
/** Supplementary facts only: no retry flags, raw provider metadata, or authorization decisions. */
export function refusalDetails(error: unknown): RefusalDetails {
  if (!(error instanceof AgentApiError)) return {};
  const meta = error.errors[0]?.meta as Record<string, unknown> | undefined;
  const at = error.availableAt;
  const budget = meta?.budget_remaining_usd;
  return {
    ...(typeof at === "string" && at.length <= 40 && Number.isFinite(Date.parse(at)) ? { availableAt: at } : {}),
    ...(error.code === "spend_budget_exceeded" && typeof budget === "string" && /^\d{1,12}(\.\d{1,18})?$/.test(budget) ? { budgetRemainingUsd: budget } : {}),
  };
}

/** Provider-reported evidence, not independently verified settlement. No inferred asset or explorer URL. */
export function paymentEvidence(input: unknown) {
  const d = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const text = (key: string) => typeof d[key] === "string" && d[key].length > 0 && d[key].length <= 256 && !/[\x00-\x1f\x7f]/.test(d[key]) ? d[key] as string : null;
  const amount = text("refunded_amount");
  return { txHash: text("tx_hash"), destinationTxHash: text("destination_tx_hash"), refundTxHash: text("refund_tx_hash"),
    refundTo: text("refund_to"), refundedAmount: amount && /^\d{1,78}$/.test(amount) ? amount : null };
}
