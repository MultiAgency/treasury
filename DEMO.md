# Agentic Treasury Management — 60-second demo

One story: the owner chooses the assets and limits; the agent quotes a rebalance, acts within its
current authorization, and records the outcomes and remaining budget. Use the Treasury overview,
not the inherited Payables workspace. This is a walkthrough for the current source; it is not a
record that this cleanup has been deployed.

The reference owner is `agentic.sputnik-dao.near`; the intended focused destination is
`https://treasury.multiagency.ai`. Historical DAO records used `https://proto.multiagency.ai/a/treasury/`.
That history does not establish the current host/service assignment. Confirm the displayed owner
and retained records before presenting; the separate wallet installation is not the DAO reference.
Proto remains the umbrella showcase for all three ideas and must not redirect to Treasury.
The [release review](docs/treasury-rollout.md) leaves live topology decisions to the owner.

Creation is a separate journey: on a registration-enabled Treasury host, sign in, choose wallet
or DAO ownership, and continue into an isolated workspace. Registration signs nothing. Explicitly
authorize agent creation and policy, save and authorize the strategy, fund the agent, then enable
scheduling. A DAO uses its owner proposal/approval flow. Current offline creation fixtures stop
before real signing; historical reference evidence does not certify another owner's agent.

## Prepare before presenting

- Use an owner-authorized, low-value treasury. Verify its policy, monthly asset caps, USD budget,
  live strategy-bound grant and executor. Resolve unknown outcomes before any new send.
- Set targets and limits, authorize the saved strategy and leave the schedule in its intended state.
  Configuration, owner authorization and schedule enablement are separate decisions.
- Fund sufficiently for a meaningful imbalance and check budget headroom. Rehearse quote-only
  preview without executing. Prices and limits can produce fewer swaps or no swaps.
- Have a previously recorded run available for a read-only fallback. Never create extra swaps or
  change a policy just to make the presentation look active.

## The minute

| Time | Show | Explain |
|---|---|---|
| 0–10s | Allocation, signed monthly caps and the USD budget windows | “The owner chooses assets, targets, monthly caps and a shared USD budget.” |
| 10–25s | Rebalance preview | “The agent reads balances and quotes every planned route. Here are estimated and minimum received amounts and the cost limits.” |
| 25–40s | Review and explicitly confirm, if authorized for this demonstration | “This executes the exact saved plan. Each send is checked again; unknown outcomes block further sends.” |
| 40–50s | Follow the outcome on the same overview: that plan’s operations and budget observations | “These records show what the provider reported. Compare budget headroom before and after; a finished run alone does not establish settlement.” |
| 50–60s | Confidential balances and Sweep | “Managed public balances can be shielded. The resting book is held confidentially; this is not proof against every form of tracing.” |

With the current USDC/wNEAR/ETH strategy, show at most two swap legs. The catalog's three-swap
example is not a requirement to manufacture a third leg. Provider settlement may take longer
than a minute; if it does, leave the outcome visible or use the read-only recorded fallback.

The overview follows only the exact plan confirmed in this session. It keeps the last successful
budget observation before confirmation beside newer provider observations, and refreshes those
reads when execution results arrive. The selected outcome reads every five seconds for ten minutes
while the page is visible; normal dashboard refreshes continue afterward. Missing reads stay
unavailable. A policy change prevents comparison across policies. Budget changes may include other
activity, so the difference is not attributed to this plan or presented as proof of atomic charging.
Reload clears the local plan selection and submits nothing; retained outcomes remain in Activity.
This presentation is offline-tested, not a new hosted or mainnet observation.

To demonstrate scheduled execution, show the saved targets, matching authorization and schedule,
then open an actual recorded scheduled run. A manual execution does not prove scheduling worked.

## Show refusal evidence without another money action

Open **Review recorded refusals** under Signed limits to inspect existing refusal codes without leaving the overview. Activity retains the full operation history. Distinguish
an asset-cap refusal from a USD-budget refusal: the historical budget observations use
`spend_budget_exceeded`. Do not claim that every cap refusal uses the catalog's hyphenated code,
or that provider-enforced limits are a local pre-provider guarantee.

## What is verified

The generated table below summarizes historical Treasury evidence. Full dates and deployment
context remain in [the mainnet log](docs/mainnet-log.md); newer builds and other registered
agents are not certified by these observations. Concurrent-budget evidence is one trial, not
proof of atomic accounting. Exact unshielding remains unimplemented.

<!-- BEGIN GENERATED: verification -->
<!-- Generated from evidence/inventory.ts. Run pnpm evidence:write; do not edit here. -->

These are catalog targets, not established guarantees. Evidence stages describe the supporting observations or tests; known limitations still apply.

| Target | Evidence stage | Supporting evidence |
|---|---|---|
| Rebalances to target allocations on a schedule | Observed on mainnet | The autopilot executed a rebalance alone, its plan bound to the strategy digest, 2026-10-12 16:17Z (test/autopilot.test.ts, test/rebalance.test.ts) |
| Can't exceed per-asset limits | Observed on mainnet | The policy caps every asset per transaction, hour, day and month. On the treasury agent, a transfer over its hourly cap was refused with policy_denied (policy revision 8, 2026-10-11); a swap over the monthly cap was refused on an isolated test agent, 2026-10-13 |
| Quotes every route before executing | Observed on mainnet | Two quoted legs executed on the treasury agent, 2026-10-12 20:36Z (test/rebalance.test.ts, test/plans.test.ts) |
| Shows budget headroom ticking down with each dispatch | Observed on mainnet | On the treasury agent, a Run now swap took the daily budget left down by its value, shown as before and after under Automations' Latest run, 2026-10-14 00:50Z. The Overview and each run show the window with least left (test/budget-window.test.ts) |
| An over-budget operation is refused; earlier operations in its run may complete | Observed on mainnet | Refused with spend_budget_exceeded, nothing moved, on the treasury agent, 2026-10-12 13:57Z and 14:06Z |
| Can't spend more than the USD budget, even with simultaneous requests | Observed on mainnet, on another agent | Five simultaneous swaps on an isolated test agent: one settled, the rest refused, no overshoot, 2026-10-13 (one trial) |
| Sweeps idle stables into the confidential balance | Observed on mainnet | A small USDC deposit to a public deposit address landed in the treasury agent's public balance; the dashboard's Sweep (the same sweep the autopilot runs each tick) shielded it, and nothing was left public, 2026-10-14 00:33Z to 00:39Z (test/autopilot.test.ts) |
| Keeps managed resting balances confidential | Observed on mainnet | No public NEAR Intents balance on chain and all three assets confidential, read-only check, 2026-10-13T23:03Z. Kept so by our deposits' and swaps' requests: the policy allows public swaps and unshield (docs/enforcement.md). Funds still can't leave: the destination list is empty |
| Unshields exactly what a public payout needs | Not yet | Not implemented: exact public-payout unshielding is outside the current rebalance and sweep flow. No live payout choreography has been demonstrated. |

<!-- END GENERATED: verification -->

## Claims to keep precise

Say “scheduled rebalancing with application checks and provider-enforced limits.” The brief's
“can never exceed” envelope is the target, not an established custody guarantee. Output-asset
checks are local, cumulative counters and atomic USD charging remain provider trust boundaries,
and spending limits do not bound market exposure. Shield/unshield budget treatment needs
provider evidence; this demo must not infer it from the absence of a swap.

Exact unshielding for a public payout is not part of the implemented walkthrough. No invoices,
payee agreements, campaign payouts or unrelated roadmap briefs belong in this demo.

## Presenter fallback

Before presenting, open **View treasury runs**, select a retained run and check that its
**Run details** include the observations you intend to show. Keep its scoped URL available
privately. A recorded run is historical evidence, not a replay or a new execution.

| If the live flow shows… | Continue with… |
|---|---|
| No swaps in the preview | Explain that the current balances and limits produced no executable legs. Open the selected retained run to illustrate an earlier rebalance. |
| A refusal | Keep the refusal visible. **Review recorded refusals** shows existing codes without submitting a probe. Earlier operations in a run may have completed. |
| An interrupted response or unresolved operation | Leave the exact plan outcome visible and open **View activity** for its recorded status. Do not confirm the plan again. |
| Slow settlement | Show the observed status and budget timestamps, then the selected retained run. Identify the transition to historical evidence aloud. |
| Failed balance, budget or history reads | State that the observation is unavailable. Use retained evidence only if it can be read; do not describe cached values as current. |
| No public balances in Sweep preview | Explain that no managed public balance was found. Show **Balances and funding** to distinguish public and confidential balances. |

Sweep requires its own **Preview** and explicit **Shield** confirmation. It shields all reported
public USDC, wNEAR and ETH balances; there is no idle-surplus reserve. For a read-only rehearsal,
stop at the previews and dismiss confirmation dialogs. Keep Steward outside this minute.

## Optional experiment: Steward

For a conversational planning demo, open `/a/<agent-name>/steward` directly, or `/steward` on a
standalone server. Steward is intentionally absent from navigation and separate from the core
60-second walkthrough. Configure `NEARAI_API_KEY` on the backend. Opening the page proposes and
executes nothing; **Propose** prepares a plan, then **Execute plan** requires explicit confirmation
and the existing policy, grant and saved-plan checks. This restored route is locally tested; this
change has not been deployed or used for a new mainnet observation.
