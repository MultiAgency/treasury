# Agent Connect audit and delivery plan

Canonical local catalog mapping and delivery audit for ideas 1, 2 and 3. See [repository scope](scope.md) for destination responsibilities and [Treasury evidence](treasury.md) for idea 2.

Agentic Treasury covers three catalog briefs through two areas: Payables holds briefs 01 and 03;
Portfolio, the product label for Treasury, holds brief 02. Each brief needs its own demonstration
and evidence. An agreement in the shared payout agent does not satisfy the isolated-agent lifecycle
in brief 03.

**Verdict: RESHAPE the original briefs.** Keep all three product goals, replace unsupported guarantees,
and implement the missing work-order and payee-settlement workflows. The existing requirement
stages remain in the [canonical inventory](../evidence/inventory.ts), rendered in
[Payables](facilitator.md) and [Treasury](treasury.md). This plan does not promote their evidence stages.

The product calls the new concept a **Work order**: agreed work for one payee, a fixed USDC amount
and a deadline, linked to one dedicated agent and one immutable invoice identity. An **Agreement**
records the terms; an **Invoice** requests payment against them. Keep the catalog title
“Invoicing & Purchase-Order Management” when identifying brief 03. The first work-order flow retains
owner approval for each payout; payee conversion and forwarding remain a separate delivery step.

## Scope and the four audit gates

| Brief | Area | Essential Agent API capability | Demonstration and takeaway | Integration |
|---|---|---|---|---|
| 01 SputnikDAO Confidential Treasury Facilitator | Payables | Owner approval, confidential transfers and policy destinations | An outside requester files an invoice; the payout waits for the DAO. A payment to an unagreed payee is refused. The executor cannot authorize its own payout. | Existing payout agent, invoice intake, DAO owner intents and approval flow |
| 02 Agentic Treasury Management | Portfolio | Owner-signed spending caps and USD budget, revocable grant, confidential balances | A scheduled rebalance executes quoted legs; a subsequent over-budget operation is refused. The owner delegates execution within a spending policy. | Existing treasury agent, strategy, plans and autopilot |
| 03 Invoicing & Purchase-Order Management | Payables | Separate agent per order, one payee destination, amount caps and an expiring grant; separate payee settlement policy | One funded order pays its payee without access to the main treasury's grant. The payee converts receipts and forwards proceeds. Each executor has separately authorized access. | Planned order lifecycle and payee workflow in the existing backend |

These mechanisms make the briefs relevant to Agent Connect. The demonstration column supplies the
visible restriction and the takeaway. The integration column keeps one application artifact: the
existing TypeScript server and workspace. Brief 03 remains a design to implement and verify; the
original promises of exact-once payment, settlement by a deadline and hidden Sputnik membership
do not pass the audit as stated.

## Corrections to the original briefs

Provider documentation below is pinned to skills commit
[`8e03b0e`](https://github.com/NEAR-Intents-Agent-API/skills/tree/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1).
It describes intended API behavior, not an independently established deployed provider version.
The [enforcement assessment](enforcement.md) retains the implementation observations and open cases.

| Original assumption | Correct scope |
|---|---|
| A grant carries its own actions, recipients and budget | Grants identify actors and expire; all grants of an agent share its policy. Put payee restrictions in the order agent's policy. |
| A grant label enforces strategy or purpose upstream | This server interprets the label and strategy digest. The provider does not enforce those application meanings. |
| Sputnik members remain secret | Sputnik roles are public. Intake avoids direct member contact; it cannot hide the roster. |
| The API policy takes a custom council list and quorum | The current policy exposes `owner_approval`. This project's DAO vote authorizes the DAO-derived owner signature; its quorum belongs to DAO governance. |
| Asset caps form an exposure envelope | Caps restrict spending, not holdings, market losses or allocation quality. The provider's asset list restricts inputs; output-asset checks stay local. |
| Confidentiality makes the treasury or payee graph untraceable | Confidential transfers reduce public disclosure. Providers can see mappings, and timing or other public records can reveal relationships. |
| A destination list conflicts with shield/unshield | Do not carry forward the pasted `policy_confidential_whitelist_conflict` claim. The enforcement assessment records a successful shield under a non-empty destination list; other cases retain their evidence limits. |
| USD budget is set with `budget_set` | It is part of the complete policy, changed through `policy_update` with `expected_revision`. |
| An expired grant means the order account expired or all payments stopped | The grant loses authority for new work; the account persists and committed work can finish. Residual funds and unresolved operations need explicit handling. |
| Idempotency makes an invoice impossible to pay twice | It identifies retries of one request. A different key is new work; order completion and immutable payment identity remain application responsibilities. |

The policy and grant corrections follow the pinned [policy reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/policy.md),
[grant reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/grants.md)
and [status and recovery reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/status-and-recovery.md).
The original camelCase requests and nested `capabilities`, `rules` and `approval` policies must be
replaced with the installed SDK's request types. A 90-day grant can be a product choice, but the
documented maximum is 365 days.

## What each brief must cover

### 01 Confidential Treasury Facilitator

Keep external invoice intake, confidential payouts and owner approval. Preserve the distinction
between becoming an agreed payee and approving a particular held payout. A new payee's request
creates no payment authority; a policy update needs the owner, followed by the individual payout's
approval. The current gaps include completing and observing that acceptance flow on this area.

Contractor invoices, bounty awards and one-time grants can use this flow. Do not claim anonymous
winner identity or winner validation: those are separate requirements. An excessive payment must
be attributed to the actual refusing layer. The stronger claim that a cap remains effective after
approval needs deployed evidence; a normal cap refusal does not establish it.

Agreement ceilings and deadlines remain visible review context in this existing flow. Voters can
approve terms that differ; the current application does not automatically reject every breach.

### 02 Agentic Treasury Management

Keep target allocations, quote-before-execution, strategy-bound plans, scheduled execution,
output-asset checks, cost limits and the local auto-execute ceiling. These make Portfolio follow
the owner's strategy; they do not establish protection against an executor that bypasses its code.

Demonstrate per-asset refusals separately from the cross-asset USD-budget refusal. Do not describe
one concurrency trial as proof of atomic enforcement across grants, hosts and crashes. Preserve
the open cases in the enforcement assessment.

Keep shielding managed idle balances. Current payouts use confidential transfers and need no
public reserve. Unshielding exactly enough for a public payout is an explicit deferred variant,
not covered by the confidential payout flow. The treasury policy enables confidential operations
but does not require every treasury operation to remain confidential.

### 03 Invoicing and Purchase-Order Management

This brief has two missing workflows. Both are needed for full coverage.

**Buyer:** create an agent for one order, obtain the owner's signed policy and grant, confirm
funding, submit the immutable payment, observe its outcome, then retire authority and account for
residual funds. Use one payee, one settlement asset and one payment for the first implementation;
partial invoices and amendments need separate designs. The executor holds only that order's grant.
Funding is an explicit owner action or a separately authorized treasury operation.

**Payee:** use a separately owned agent to observe receipts, quote conversion into USDC, execute
approved conversions and forward available proceeds to its agreed treasury on a schedule. Record
which observations and operations a settlement run covers. A conversion that settles while forwarding
is unresolved must not trigger another conversion or a replacement forwarding operation.

The payee's policy can allow spending supported receipt assets, swaps and transfers to one
treasury destination. The request selects confidential execution; the destination entry restricts
the transfer's confidential form. Conversion to USDC and when to run remain application decisions.
Quotes, route minimums and recipients must be checked against the provider's
[execution reference](https://github.com/NEAR-Intents-Agent-API/skills/blob/8e03b0ea8e8f24f66923346f82c7afa56c40c6d1/near-intents-agent-api/references/executions.md).

For the buyer's order, distinguish these boundaries:

- A single `destinations` entry restricts the payee; a grant's label does not.
- A per-operation cap rejects an excessive amount, not every altered amount. Exact amount matching
  is local, or subject to the owner's review if approval is required.
- Funding the order limits its available balance at that time. Deposits remain possible; funding
  alone does not establish a lifetime spending cap after replenishment.
- Grant expiry is an authority deadline for new work, not a guaranteed settlement deadline. Other
  live grants share the policy and must be accounted for. Held or queued operations require explicit
  release and expiry analysis before claiming a hard deadline.
- Reuse the original operation identity for recovery. A terminal label alone, including provider
  `FAILED`, is insufficient evidence that a replacement payment is safe.
- Closing an order requires its recorded outcome and residual-fund disposition. Expiry alone must
  not hide unresolved work. Do not automatically delete, archive or loosen destinations to recover funds.

### Typed policy shape for the planned buyer flow

This pure example constructs a transfer-only policy and a grant request; it sends nothing. It
typechecks against the installed `@near-intents-agent-api/sdk` 0.4.1; this is not provider validation.
The caller supplies a provider token ID, verified payee account, reviewed atomic cap, agent ID,
expiry and commitment. `requireApproval` chooses whether each payout requires owner approval;
autonomous order settlement still relies on local exact-invoice checks. Its default is approval.

```ts
import type { GenerateIntentRequest, Policy } from "@near-intents-agent-api/sdk";

export function orderPolicy(
  assetId: string,
  payeeAccount: string,
  maximumAtomic: string,
  requireApproval = true,
): Policy {
  return {
    frozen: false,
    actions: ["transfer"],
    confidential: true,
    owner_approval: requireApproval,
    assets: [assetId],
    limits: { per_transaction: { [assetId]: maximumAtomic } },
    max_actions_per_hour: 1,
    destinations: {
      mode: "only",
      list: [{ action: "transfer", address: payeeAccount, confidential: true }],
    },
    budget: { daily_usd: null, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

export function orderGrant(
  agentId: string,
  label: string,
  commitment: string,
  expiresAt: string,
): GenerateIntentRequest {
  return { type: "grant_issue", agent_id: agentId, label,
    credential: commitment, expires_at: expiresAt };
}
```

The hourly rate cap is not a once-per-order restriction. This policy does not express exact invoice
matching, lifetime total spend or a settlement deadline. Validation, owner preview, signing and
settlement remain in the existing owner-intent lifecycle. Agent intelligence may propose the order
or parse an invoice; it does not receive credentials or expand its own authority.

## Demonstration scripts

These are edited 60-second walkthroughs, not promises about approval or settlement latency. Show
actual elapsed time and distinguish historical evidence, offline fixtures and newly observed results.
Use the existing signed-in workspace; public pages remain static and read no private records.

| Brief | 0:00 | 0:15 | 0:30 | 0:45 |
|---|---|---|---|---|
| 01 | Requester files an invoice | Show held payout and owner review | DAO approval and observed payment outcome | Show an unagreed-payee refusal and the separate agreement path |
| 02 | Show strategy, policy limits and budget headroom | Scheduled run quotes its plan | Observe completed legs and budget change | Show provider budget refusal; include the shield observation in supporting evidence |
| 03 buyer | Show order and isolated agent policy | Owner authorizes and funds the order | Payee payment and recorded outcome | Show authority retirement and an expired-grant refusal on separately prepared evidence |
| 03 payee | Show received assets and agreed treasury | Quote USDC conversion | Observe conversion outcome | Forward proceeds and show the separate forwarding outcome |

Supporting negative cases for brief 03: wrong payee, excessive amount, locally altered invoice,
expired grant, same-request recovery, replenishment, and an interrupted payee run. Each result
must name the enforcing layer. A disabled button or local refusal cannot establish provider enforcement.
No live run is authorized by this plan; mainnet tests and hosted money actions remain the owner's.

## Delivery sequence and acceptance

1. **Preserve the existing flows.** Keep Portfolio's strategy and output checks, Payables' owner
   approvals, the single dispatch site and unresolved-operation blocking. Finish brief 01's new-payee
   acceptance evidence and brief 02's unattended-run evidence through separately authorized runs.
2. **Specify and test the order lifecycle offline.** Bind order, agent, policy digest, immutable
   invoice and operation identity. Reproduce wrong-payee, altered-amount, expiry, concurrency,
   lost-response and restart cases before implementing their behavior. Distinguish local tests from
   provider enforcement tests; retain real SQLite and child processes for crash/concurrency coverage.
3. **Integrate isolated order agents.** The backend retains the partner key; each owner signs policy
   and grant intents; each executor receives only its agent's grant. Keep one executor per agent,
   with approve-only instances elsewhere. Current instance configuration must be extended deliberately
   for multiple order agents; never switch agent environment variables inside an active executor.
4. **Add payee settlement.** Separate receipt discovery, conversion and forwarding identities;
   preserve partial progress and refuse new sends while an operation is unresolved. Avoid assuming a
   multi-agent or multi-leg run is atomic. Use the existing dispatch path for every money action.
5. **Review state preservation before rollout.** Preserve all existing state directories listed in
   [operations](operations.md). New order/settlement state needs a documented format, compatibility
   tests and preservation instructions. Any conversion requires a stopped-executor migration.
6. **Verify and record evidence.** Run offline typechecking and tests, then applicable browser checks.
   User-run mainnet checks use dedicated accounts and small amounts. Put private release details in
   the private record; record public dated observations in the mainnet log, update the inventory and
   regenerate its tables. Keep brief 03 planned until its own requirements have supporting evidence.

Money-path implementation requires checking with the owner for an unattended run or freeze, as
required by [the repository guide](../AGENTS.md). This documentation does not add authorization
rules or change deployment configuration.

### Local implementation status

The `work-order-*` modules are a partial integration. Offline tests cover immutable terms,
distinct invoice identities, corrupt-record refusals, subprocess startup, separation from the
parent's grant and owner key, fixed owner policy/grant requests and dispatch binding.
`rpc/work-orders.ts` is composed into the router and classified by gateway permissions;
`invoice-http.ts` exposes a private bridge and payee-scoped order APIs. No work-order frontend
is connected. Full creation/funding/payment/restart/retirement acceptance and payee settlement
remain outstanding; these modules are not established as ready for hosted or mainnet use.

Work-order state is additive: `.work-orders/<parent-agent>/<order-id>.json` records immutable terms;
the accompanying instance `.env` and `.initialized` marker must be preserved together. Also preserve
the instance's `.owner-intents/` records and all agent state described in [operations](operations.md).
A missing initialized settings file refuses recovery rather than creating a replacement agent.
Existing agents do not require record conversion. This is single-host process coordination, not
distributed fencing; full restart, payment and browser acceptance remain outstanding.

## Reply to the proposers

Here's a synopsis of the ideas, with the run-through audit above.

The original ideas:

- SputnikDAO Confidential Treasury Facilitator
- Agentic Treasury Management
- Invoicing & Purchase-Order Management

Some adjustments to highlight Agent Connect's capabilities:

- Owner approval makes Payables a confidential intake and payment workflow; Sputnik membership remains public.
- Spending policies and USD budgets bound Portfolio operations; strategy and output-asset checks remain application responsibilities.
- Destination policies belong on an isolated agent for each order, with amount caps and a dedicated expiring grant.
- Grant expiry and idempotency support order control, but exact payment, settlement deadlines and paying once need narrower claims and further verification.
- A separate payee policy completes the third idea by authorizing receipt conversion and forwarding to an agreed treasury.
