/**
 * What a refusal code means, in a few plain words: the provider's codes and this server's own
 * (src/authorize.ts). The code itself stays available beside it, since it is the evidence.
 */
const REFUSALS: Record<string, string> = {
  // The provider's.
  policy_denied: "outside the policy",
  policy_destination_denied: "recipient not allowed",
  spend_budget_exceeded: "over the USD budget",
  spend_price_unavailable: "no price to value it",
  wallet_busy: "wallet busy with another operation",
  // This server's, before anything is sent.
  insufficient_balance: "not enough funds",
  asset_out_not_allowed: "buys an asset the policy doesn't list",
  transfer_not_allowed: "not a confidential USDC transfer",
  duplicate_held_payout: "the same payout is already waiting",
  grant_missing: "no live grant",
  grant_purpose_denied: "the grant isn't for this",
  policy_not_in_force: "the policy isn't in force",
  reviewed_policy_changed: "the policy changed since review; refresh and review the payment again",
  payee_not_agreed: "payee not agreed",
  per_transaction_exceeded: "over the per-payment cap",
  owner_approval_required: "the policy must hold payments for approval",
  plan_expired: "the plan expired",
  plan_agent_changed: "the plan was for another agent",
  plan_policy_changed: "the policy changed since the plan",
  strategy_changed: "the strategy changed since the plan",
  swap_cost_exceeded: "the swap costs more than the strategy allows",
};

export const refusalText = (code: string) => REFUSALS[code] ?? code.replaceAll("_", " ");

/**
 * The provider's longer messages the autopilot passes on, in a few plain words. Matched on stable
 * phrases; anything else is shown as it came.
 */
const MESSAGES: [RegExp, string][] = [
  [/shared USD budget has too little left/i, "this swap was refused because the USD budget has too little left; earlier operations may have completed"],
  [/Live execution gate closed: observe mode/i, "execution was switched off (observe mode); this operation was not submitted; earlier operations may have completed"],
];

export const plainMessage = (text: string) => {
  for (const [pattern, plain] of MESSAGES) if (pattern.test(text)) return text.replace(/:\s.*$/s, `: ${plain}`);
  return text;
};
