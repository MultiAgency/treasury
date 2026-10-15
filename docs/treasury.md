# Agentic Treasury Management

The owner delegates target-allocation rebalancing under signed allowed assets, per-asset monthly
caps and a cross-asset USD budget. The current agent reads balances, quotes routes, prepares an
expiring plan bound to the policy and strategy, and executes through the single journaled send site.
The schedule uses the same dispatch path. Managed public balances can be shielded into confidential
balances. USDC, wNEAR and ETH are the current managed assets.

## Product target and evidence

The target is a treasury agent that cannot exceed its signed spending envelope. Mainnet observations
and offline tests support parts of that target; they do not establish the complete guarantee.
The requirement inventory below separates behavior, safety targets and supporting evidence.
Observed refusals do not prove all concurrent executions are bounded. See [enforcement](enforcement.md).

<!-- BEGIN GENERATED: requirements -->
<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->

## 02 Agentic Treasury Management

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Type | Requirement | Control or limitation | Evidence stage | Evidence |
|---|---|---|---|---|
| Capability target | Rebalances to target allocations on a schedule | — | Observed on mainnet | The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (test/autopilot.test.ts, test/rebalance.test.ts) |
| Safety target | Can't exceed per-asset limits | The signed policy | Observed on mainnet | The policy caps every asset per transaction, hour, day and month. On the treasury agent, a transfer over its hourly cap was refused with policy_denied (policy revision 8, 2026-10-11); a swap over the monthly cap was refused on an isolated test agent, 2026-10-13 |
| Capability target | Quotes every route before executing | — | Observed on mainnet | Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (test/rebalance.test.ts, test/plans.test.ts) |
| Capability target | Shows budget headroom ticking down with each dispatch | — | Observed on mainnet | On the treasury agent, a Run now swap took the daily budget left down by its value, shown as before and after under Automations' Latest run, 2026-10-14 00:50Z. The Overview and each run show the window with least left (test/budget-window.test.ts) |
| Safety target | An over-budget operation is refused; earlier operations in its run may complete | The signed policy | Observed on mainnet | Refused with spend_budget_exceeded, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z |
| Safety target | Can't spend more than the USD budget, even with simultaneous requests | The signed policy | Observed on mainnet, on another agent | Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial) |
| Capability target | Sweeps idle stables into the confidential balance | — | Observed on mainnet | A small USDC deposit to a public deposit address landed in the treasury agent's public balance; the dashboard's Sweep (the same sweep the autopilot runs each tick) shielded it, and nothing was left public, 2026-10-14 00:33Z to 00:39Z (test/autopilot.test.ts) |
| Safety target | Keeps managed resting balances confidential | Our server | Observed on mainnet | No public NEAR Intents balance on chain and all three assets confidential, read-only check, 2026-10-13T23:03Z. Kept so by our deposits' and swaps' requests: the policy allows public swaps and unshield (docs/enforcement.md). Funds still can't leave: the destination list is empty |
| Capability target | Unshields exactly what a public payout needs | — | Not yet | Not implemented: exact public-payout unshielding is outside the current rebalance and sweep flow. No live payout choreography has been demonstrated. |

### Known limitations

- Whether simultaneous requests can exceed asset limits or the USD budget remains unverified.
- This server checks which assets can be bought; the provider does not.
- This server requests confidential swaps, but the policy also permits public swaps and moving funds back to a public balance. A confidential balance does not establish protection against every form of tracing.
- The agent has not yet run unattended for days.
- Exact unshielding for a public payout is not implemented. The current sweep shields managed USDC, wNEAR and ETH; it does not calculate an idle-surplus reserve.

<!-- END GENERATED: requirements -->

## Flow

1. **Review the book and policy.** Allocations, monthly caps and the USD budget are visible on the
   overview. The budget figure uses the configured window with least headroom and names that period.
2. **Set targets and schedule.** Save the strategy with scheduling off, authorize the exact saved
   strategy with its digest-bound grant, then explicitly enable the schedule. Each is a separate decision.
3. **Preview a rebalance.** Review every route's estimated and minimum output and cost. An empty plan
   is valid. Quotes and previews submit no swaps.
4. **Follow the outcome.** Explicitly execute a reviewed plan or inspect a recorded scheduled run.
   The overview follows the exact manually confirmed plan without leaving the screen. Budget
   readings are labelled before-confirmation and latest observations, not charges attributed to the
   plan. Read failures and policy changes remain explicit. Each operation retains its mandate digest;
   a run end does not establish operation settlement.
5. **Shield resting balances.** Sweep covers managed public USDC, wNEAR and ETH. It does not compute
   an idle-surplus threshold or an exact amount to unshield for a public payout.

The signed-limits view shows configured USD windows beside monthly asset caps and loads recorded
refusals on request. These presentation changes are checked by `test/browser/treasury-demo.cjs`
with an offline streaming fixture, including budget refresh before stream end, unknown outcomes,
refusals and failed reads. They are not deployed or mainnet-observed.

## Implementation and verification

- `src/treasury.ts`, `src/plans.ts` and `src/autopilot.ts`: planning, quotes, execution and scheduling.
- `src/agent.ts`, `src/authorize.ts`, `src/ops.ts`, `src/lock.ts` and `src/reconcile.ts`: the one send
  site, authorization, write-ahead journal, single-host money lock and unknown-outcome recovery.
- `src/mandate.ts`, `src/strategy.ts` and owner intents: policy/strategy binding and durable owner actions.
- `web/src/features/portfolio/treasury-desk.tsx`: the primary Treasury screen.
- `test/rebalance.test.ts`, `test/plans.test.ts`, `test/autopilot.test.ts`,
  `test/planning-valuation.test.ts` and `test/strategy-controls.test.ts`: offline behavior checks.
- `test/agui.test.ts`, `test/journal-history.test.ts` and `test/run-log-export.test.ts`: derived,
  private run recordings and access controls. Recordings never authorize a send or replay funds.

The [60-second demo](../DEMO.md), [operations guide](operations.md) and
[run-recording documentation](live-run.md) cover presentation, preservation and detailed evidence.
Historical roadmap briefs and the earlier full implementation narrative are retained in
[legacy Treasury documentation](legacy/treasury.md); they are outside this product's scope.
