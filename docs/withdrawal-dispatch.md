# Internal withdrawal submission and approval

Candidate source, 2026-10-16 UTC; not deployed. `dispatch` can submit a provider withdrawal through
the existing money lock, fresh policy/grant checks, mandate digest, durable request and submission
claim. A provider outcome is recorded under the original operation identity. Unknown submission or
settlement blocks replacement sends. No dashboard, invoice or scheduled withdrawal flow is added.

Existing submission-purpose authorization is unchanged: withdrawal uses Treasury authority; payout/invoice
grants do not gain withdrawal authority. The provider enforces withdrawal action, destination, caps,
budget and approval requirements. Internal submission support does not establish exact recipient
receipt or binding of the final artifact. A separate approval branch now supports recorded
confidential USDC withdrawals to NEAR only, checked against the provider hash and current policy.
It requires the original durable held journal record and refuses memo, wrapped delivery, cross-chain
routes and output terms outside the observed shape. The transfer hash is never reused for withdrawals.
This approval branch is offline-tested and was used for one isolated mainnet withdrawal that settled
after verified owner approval on 2026-10-16 UTC. It is not deployed to a hosted executor. See the
[acceptance record](provider-acceptance.md#isolated-observations).

The isolated acceptance harness verifies owner approval is enabled in the exact reviewed policy,
checks the selected owner destination and source ceiling, and stops at the held outcome. It uses
`dispatch`; there is no second grant send site. Experimental harnesses and real captures are private.
The [provider acceptance record](provider-acceptance.md) separates source checks from mainnet results.

## State compatibility and preservation

The optional recorded `method` can now be `withdraw`. Journal readers, history projections and
run-record schemas accept that method alongside prior methods and legacy records without a method.
No existing state conversion or reconstruction is required. The compatibility regression retains old
and new records together. An older binary may refuse new withdrawal records; do not roll back its
readers across those records without a compatibility review.

Before any owner-performed rollout, stop the executor and preserve `.ops/`, `.invoices/`,
`.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/` and
any other configured workspace state. Keep one executor per agent. This source change does not
deploy, restart or migrate an executor.

## Offline verification

`test/money-safety.test.ts` checks write-ahead withdrawal terms and mandate binding, durable submission
claims, held outcomes, ambiguous-submission blocking, grant-purpose refusal and legacy/new journal
compatibility. `test/send-path.test.ts` retains the one send site. Existing reconciliation remains
status-only; this change adds no money-operation replay.

`test/withdrawal-approval.test.ts` checks the separate withdrawal hash, recorded-term matching,
unsupported delivery fields, missing durable evidence, current policy restrictions, journal changes
after review, policy changes before submission, one-time signature submission and poll-only recovery
after a lost approval response. The existing owner-intent flow performs the fresh approval check
immediately before signature submission. An approve-only instance needs access to the original journal
for this new route; provider-only withdrawal approval is refused. Transfer approval behavior remains
covered by its existing regressions.

`test/withdrawal-approval-restart.test.ts` runs real child processes against retained journal and
owner-intent state. A submitted withdrawal approval stays poll-only even when the API reports
`PENDING_SIGNATURE`, then reconciles the original withdrawal to settlement without another submission.

The canonical withdrawal hash covers declared source terms. `destination_asset` must equal USDC for
the supported NEAR route, but this local restriction does not place that field in the provider hash.
Output receipt, fees and final-artifact correspondence remain dependent on the provider. This branch
does not claim exact net delivery, quote binding or protection against a compromised coordinator.
