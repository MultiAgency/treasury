# Treasury provider verification

Reviewed 2026-10-16 UTC. This record covers independent documentation, source and isolated mainnet
checks. It does not assign a new product flow to Payables or change Treasury's focused rebalance and
sweep interface. No provider messages were sent and no hosted executor was deployed.

## Current result

One confidential USDC withdrawal from the isolated test agent to its owner on NEAR was quoted,
held for owner approval, verified, approved and settled. The destination transfer event, recipient
balance increase and provider output agreed. A separate held withdrawal was rejected and reported
never executed. Both operations and their owner actions are terminal locally.

These establish specific provider capabilities and observations. They do not establish exact-output
execution, an atomic unshield-and-payment operation, a reserve strategy, final-artifact binding or
provider-wide concurrency enforcement. Exact public-payout unshielding remains unimplemented.
The mainnet observations are in [the dated log](mainnet-log.md); internal candidate behavior and
state compatibility are in [withdrawal dispatch](withdrawal-dispatch.md).

## Source and contract evidence

| Source | Reviewed identity | What it supports |
|---|---|---|
| [Agent API execution reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/0277bc66b3df208240093d9d0fbc348929f1a392/near-intents-agent-api/references/executions.md) | skills@0277bc6 | Confidential withdrawal, dry previews, required action and destination permission, and destination confirmation evidence |
| [Owner-intent reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/0277bc66b3df208240093d9d0fbc348929f1a392/near-intents-agent-api/references/owner-intents.md) | same revision | Approval lifecycle and documented admission rechecks |
| [Recovery reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/0277bc66b3df208240093d9d0fbc348929f1a392/near-intents-agent-api/references/status-and-recovery.md) | same revision | Original-key identity and restrictions on recovery of uncertain work |
| [Policy engine](https://github.com/out-layer/shared-tee-helpers/blob/f75a74e/src/wallet_policy.rs#L143) | shared-tee-helpers@f75a74e | Canonical confidential-withdrawal hash fields and serialization |
| [Keystore](https://github.com/out-layer/outlayer/blob/b8c58c0/keystore-worker/src/api.rs#L5227) | outlayer@b8c58c0 | Approval verification and coordinator-trusted final signing artifact |
| [Public OpenAPI](https://api.demo.agentsonintents.com/openapi.json) | served version 1.0.0, retrieved 2026-10-16 UTC | Strict withdrawal request fields; no minimum-output, exact-output, quote-ID or deadline precondition |
| [Custody confidential reference](https://skills.outlayer.ai/agent-custody/references/confidential.md) | retrieved 2026-10-16 UTC; no source revision in body | Direct exit to an external recipient, distinct from unshielding to the same account's public balance; estimated output can reflect fees/storage |

The local integration skills in `proto/.agents/skills/near-agent-api/` and `outlayer/` were used to
locate primary references. Their dated notes are not current deployment guarantees. The public spec
adds `wrapped` relative to installed SDK 0.4.1. Its dry-response schema is under HTTP 202, while the
execution guide describes HTTP 200; the successful observed dry quote returned HTTP 200.

Retained content SHA-256 values:

- Public OpenAPI: `5448f294671ee97cefe6ce98f573c68a5bbe6e15b545fae44482ccce84112aa3`.
- Custody confidential reference: `8db465b28d07779bd40d33f673ca91cb5c64f6f2a775699c34e1fa7ae5553bf8`.
- Policy-engine source: `609fe27644b11f2281b3abee6a97a4b66d83e1146240bb580e06f8aa2494bfc3`.
- Keystore source: `fe5ef4030d610a7fdd93c35f887eb95fb9cf6bca17c9fce4c8aad259670311ef`.

These identify reviewed documents and source bytes, not deployed provider binaries.

## What the approval binds

The observed canonical operation contains `kind: confidential`, `flow: withdraw`, `to`, `token`,
`amount` and `chain`. Its request hash is SHA-256 of compact JSON with recursively sorted keys;
absent optional fields are omitted. An independent offline calculation reproduced the pinned source's
synthetic withdrawal vector. The same recipe reproduced both isolated approvals from provider-readable
terms. Changing recipient, source asset, source amount or chain changed the calculated hash.

The provider also returned `destination_asset`, equal to source USDC on this route. That field is
absent from the reproduced hash. The candidate verifier requires that observed shape but does not
claim output-asset binding, an exact recipient receipt or binding to the earlier quote.

In pinned source, the keystore recomputes the operation hash and verifies required owner approvals.
Confidential operations then use `BindMode::Trusted`: it checks the NEP-413 verifier and nonce,
but signs the coordinator-supplied message without reconstructing its payment terms. Approval binds
the declared operation; correspondence to the final artifact remains coordinator-trusted. The private
coordinator's conversion from Agent API input to those terms was not independently inspected.

## Isolated observations

All test policy changes and funded actions had explicit owner authorization. Tests used the existing
isolated agent, not a production Treasury or payout agent. Wallet-owner signatures needed no DAO
proposal. The provider code deployment is unidentified. A returned `provider_version: 1` does not
establish correspondence with the reviewed custody source.

1. **Dry refusals and quote, 2026-10-16 UTC.** The first confidential USDC withdrawal preview returned
   `409 policy_denied`, no quote or correlation ID. The applied policy lacked withdrawal permission
   and the destination. The owner authorized a narrow update adding withdrawal and one NEAR owner
   destination, preserving other fields. A retry still exceeded the configured monthly cap and was
   refused generically. A smaller request below configured caps returned a positive dry quote with
   estimated output, minimum output and time estimate. No grant token or live request was used for
   these previews. The generic error alone does not identify the rule responsible for a refusal.
2. **Held request and rejection, 2026-10-16 UTC.** The owner enabled approval while preserving the other
   policy fields. One capped withdrawal submitted through the journaled dispatch path returned
   `PENDING_APPROVAL`. Provider terms reproduced its hash. The owner later authorized rejection through
   the verified owner-intent flow. The vote succeeded, approval became `REJECTED`, and withdrawal became
   `FAILED` with `never_executed: true`. This does not independently verify refund or budget-release
   accounting.
3. **Approved settlement, 2026-10-16 17:11–17:12 UTC.** A fresh quote, source balance, recipient balance
   and budget observations preceded one new withdrawal under the same approval-enabled policy.
   The withdrawal-specific verifier checked its held journal, provider identities and hash, declared
   terms and current policy before approval submission. The operation reached `SUCCESS`, approval
   read `APPROVED`, and the source debit matched the request. Recipient balance increase, provider
   output and one successful NEP-141 USDC transfer event agreed; receipt matched the fresh quote
   estimate and met its minimum. Delivered output was below input, without an independent fee breakdown.

The FastNear destination-transaction response contained five snapshots of the same hash. Each hash
was checked and receipt IDs deduplicated before counting the single recipient credit. This avoids
mistaking repeated snapshots for multiple payments.

Reported spent USD increased equally across all three budget windows, already present while the
withdrawal was held, with no further increase at settlement. Policy digest and signed budget limits
were unchanged. Reset timestamps were not all identical. These observations do not establish the
price calculation, exclusive attribution of every change, or atomic accounting. Nominal USDC units
were not treated as an exact fiat charge.

## Candidate code and test state

Internal withdrawal submission uses the existing `dispatch` and money lock, write-ahead request,
mandate digest and durable submission claim. Unknown outcomes block replacements. It adds no dashboard,
invoice or scheduled withdrawal flow. The local approval branch supports recorded confidential USDC
withdrawals to NEAR only and is separate from transfer approval. Unsupported delivery terms, missing
journal evidence and changed policy or terms refuse. Submitted approval signatures remain poll-only
after interruption. Existing payout/invoice grants gain no withdrawal submission authority.

No test operation remains held or unresolved. The isolated agent retains owner approval enabled and
the reviewed withdrawal destination; no rollback, freeze or revocation was performed. All amounts,
recipients, operation IDs, transaction hashes, policy revisions and signatures stay in private evidence.
Source-level verification and one isolated success do not establish hosted deployment acceptance.

## Remaining Treasury gaps

| Gap | What this review establishes | What remains |
|---|---|---|
| Exact public-payout unshielding | A direct confidential withdrawal can exit to a public NEAR recipient on the tested route | Separate exact unshield choreography and a product payout flow are unimplemented; the observed route does not establish an exact-output guarantee |
| Idle-surplus reserve | Direct withdrawal did not require an intermediate public reserve in this test | A reserve needs an owner-defined purpose and strategy; current sweep shields all managed public balances |
| Concurrent asset caps and USD budgets | Existing sequential refusals and one concurrent trial remain recorded | Cross-grant, backend-instance, crash, window-edge and reservation accounting remain unverified |
| Final signing artifact | Declared approval terms reproduce the hash | Pinned source still trusts the coordinator's artifact; deployed correspondence is unknown |

Further investigation should use public source and independent evidence. Faults inside a private
provider component may remain unverified without provider access. Any additional funded case needs
separate owner authorization, an isolated agent and a stated loss ceiling. Do not infer a need to
expand product scope from a successful provider experiment.
