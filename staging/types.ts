import type { OwnerAction, OwnerInputs, OwnerOutput } from '@multiagency/sdk';

/** Reuse the pinned public platform contract; do not duplicate provider-facing fields. */
export type SyntheticPolicy = NonNullable<OwnerOutput<'overview'>['policy']['policy']>;
export type Owner = Extract<NonNullable<OwnerOutput<'setup'>['owner']>, {type: 'near'}>;
// Public grant observations omit the provider-side credential commitment.
export type Grant = OwnerOutput<'overview'>['grants'][number] & {credential: string};
type Nep413 = Extract<NonNullable<OwnerOutput<'owner/prepare'>['intent']>, {standard: 'nep413'}>;
type SwapLeg = Exclude<OwnerInputs['proposals/create']['legs'], 'strategy'>[number];
type SyntheticIntentType = Extract<OwnerAction['type'], 'agent_create' | 'grant_issue' | 'agent_freeze' | 'agent_unfreeze'>;
export type PolicyState = {frozen?: SyntheticPolicy['frozen']; policy?: SyntheticPolicy};

/** SQLite record envelopes, balances, fixed-price outputs and local lifecycle are synthetic storage details.
 * Types do not validate untrusted HTTP input or existing JSON rows.
 */
export type Agent = {
 id: string; owner: Owner; policy: SyntheticPolicy; frozen: boolean;
 balances: Record<string, string>; grants: Grant[];
 wallet: {wallet_id: string; near_account_id: string};
};
export type FundingTerms = {agent: string; asset: string; amount: string; requestId: string};
export type Funding = FundingTerms & {terms: FundingTerms; at: string};
export type SwapTerms = SwapLeg & {agent: string; output: string};
export type SwapResult = Omit<SwapTerms, 'minAmountOut'> & {id: string; status: 'SUCCESS'; at: string};
export type SwapOperation = {id: string; terms: string; status: string; result: string | null};
type IntentBase = {
 status: 'PENDING_SIGNATURE' | 'SUCCESS'; expiresAt: number; owner: Owner;
 payload: Nep413['payload']; result?: {agent_id: string};
};
export type Intent = IntentBase & {type: SyntheticIntentType} & (
 {type: 'agent_create'; request: {policy: SyntheticPolicy; agent_id?: never}} |
 {type: 'grant_issue'; request: {agent_id: string; label?: string; credential: string; expires_at: string}} |
 {type: 'agent_freeze' | 'agent_unfreeze'; request: {agent_id: string}}
);
export type Records = {agent: Agent; intent: Intent; funding: Funding; recovery: Record<string, unknown>};
