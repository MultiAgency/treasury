/** Persisted synthetic data shapes. These types do not validate untrusted HTTP or database input. */
export type SyntheticPolicy = {
 frozen?: boolean;
 actions?: string[];
 owner_approval?: boolean;
 assets?: 'any' | string[];
 timelock_ms?: number;
 max_actions_per_hour?: number | null;
 limits?: Partial<Record<'per_transaction' | 'hourly' | 'daily' | 'monthly', Record<string, string>>>;
 budget?: Partial<Record<'daily_usd' | 'weekly_usd' | 'monthly_usd', string | null>>;
};
export type PolicyState = {frozen?: boolean; policy?: SyntheticPolicy};
export type Owner = {type: 'near'; account_id: string; public_key: string};
export type Grant = {
 grant_id: string; agent_id: string; wallet_id: string; label: string; issued_at: string;
 credential: string; expires_at: string; revoked_at: string | null; revoked_reason: string | null;
 owner_epoch: number; owner_message: Record<string, unknown>;
};
export type Agent = {
 id: string; owner: Owner; policy: SyntheticPolicy; frozen: boolean;
 balances: Record<string, string>; grants: Grant[];
 wallet: {wallet_id: string; near_account_id: string};
};
export type FundingTerms = {agent: string; asset: string; amount: string; requestId: string};
export type Funding = FundingTerms & {terms: FundingTerms; at: string};
export type SwapTerms = {agent: string; from: string; to: string; amount: string; output: string; minAmountOut?: string};
export type SwapResult = Omit<SwapTerms, 'minAmountOut'> & {id: string; status: 'SUCCESS'; at: string};
export type SwapOperation = {id: string; terms: string; status: string; result: string | null};
type IntentBase = {
 status: 'PENDING_SIGNATURE' | 'SUCCESS'; expiresAt: number; owner: Owner;
 payload: {message: string; recipient: string; nonce: string}; result?: {agent_id: string};
};
export type Intent = IntentBase & (
 {type: 'agent_create'; request: {policy: SyntheticPolicy; agent_id?: never}} |
 {type: 'grant_issue'; request: {agent_id: string; label?: string; credential: string; expires_at: string}} |
 {type: 'agent_freeze' | 'agent_unfreeze'; request: {agent_id: string}}
);
export type Records = {agent: Agent; intent: Intent; funding: Funding; recovery: Record<string, unknown>};
