---
name: treasury
description: >-
  Interact with an owner's Agentic Treasury through scoped machine access to inspect balances and
  limits, prepare chosen swaps, execute authorized saved plans, and inspect operation outcomes.
  Use for Treasury operations, not general trading advice or wallet-key management.
---

# Treasury

Use Treasury as the executor for your owner's strategy. You choose actions; Treasury quotes routes,
saves exact plans, and runs its existing policy/grant, journal, lock and unresolved-operation checks.
Installing this skill grants no access. The interface is an offline-tested candidate, not yet deployed.
Only wallet-owned Treasuries support machine delegation; DAO delegation remains unavailable.

Proto owns authentication and consent. The owner grants, inspects and revokes access at
`/a/<name>/access` on the intended Proto host. Use that shared flow, never Treasury's experimental
gateway or a separate consent flow. Read, prepare, saved-plan execution and sweep scopes are independent.
Credentials have no separate spending budget. External plan execution is not limited by the scheduled
autopilot's per-run ceiling; the provider policy, grants and existing execution checks still apply.

## Setup

The owner supplies the intended Treasury HTTPS origin, workspace name and an expiring machine
credential through your runtime's secret store. Read these as `TREASURY_URL`, `TREASURY_NAME` and
`TREASURY_MACHINE_TOKEN`. Never request wallet private keys, seed phrases, provider API keys or grant
tokens. Do not put credentials in prompts, command arguments, skill files or logs. Do not create a
Treasury, sign owner actions, change grants or enable schedules as part of setup.

The included helper requires Node 24+ and its pinned client dependency:

```sh
npm install --prefix /path/to/treasury/scripts
node /path/to/treasury/scripts/treasury.mjs inspect
```

Resolve `/path/to/treasury` to this skill's directory. Commands below use that same helper. It reads
credentials from the environment and does not retry requests. Protect returned observations and plan
files as private Treasury data. A 401 requires renewed access; a 403 requires resolving authority or
ownership, not trying another credential or route.

## Choose and prepare actions

Read `inspect`, `strategy`, and `unresolved` before choosing actions. Distinguish fresh observations
from unknown or unavailable data. Respect the owner's task and delegated authority; a machine scope
does not itself express the owner's investment objective. Do not infer exposure bounds from spending
caps or atomic budget enforcement from sequential headroom observations.

Submit one to eight chosen swaps using supported asset IDs and positive atomic-unit string amounts.
Read [the input contract](references/api.md) when preparing a plan. Supply a stricter output floor only
when the task requires it; never invent a quote. The server obtains the quotes itself. `prepare` calls `externalPlan`, which preserves your chosen
swaps in order. Streamed `rebalance` uses allocation targets and must never substitute for these swaps.
If `externalPlan` is unavailable on a host, stop and report missing integration; do not fall back.

```sh
node /path/to/treasury/scripts/treasury.mjs prepare swaps.json
```

The response is a saved plan with an ID, expiry, mandate/strategy digests, exact inputs and output
floors. It is not an execution receipt. Preparation never moves funds. Inspect every returned action
against the owner's instruction, including any need to shield public inputs during execution.

## Execute only under delegated authority

If the owner has authorized autonomous execution for this task and the credential includes
`execute-plan`, execute the reviewed saved plan. Otherwise present the plan for approval and stop
before execution. Approval of a read or preparation is not approval to execute.

```sh
node /path/to/treasury/scripts/treasury.mjs execute PLAN_ID
```

Keep the exact plan ID and returned operation references. On rejection, explain the reason; prepare a
replacement only when the task still authorizes it. Do not change amounts or floors during execution.
Do not execute another plan as a substitute for one with an unknown outcome.

On timeout, disconnect, partial execution or an ambiguous response, **do not automatically retry or
prepare replacement sends**. Read `activity` and `unresolved`; unresolved outcomes block new sends.
Report what is known and let the owner resolve remaining uncertainty. A stream ending or a tick
finishing does not prove settlement. The helper reports transport failure without claiming nothing moved.

## Sweep and inspect

Sweeping has its own `sweep` scope and requires explicit owner authority for that task. `sweep-preview`
only reads the proposed sweep; `sweep` shields managed public balances. This does not calculate an idle
reserve or implement exact payout unshielding.

```sh
node /path/to/treasury/scripts/treasury.mjs sweep-preview
node /path/to/treasury/scripts/treasury.mjs sweep
node /path/to/treasury/scripts/treasury.mjs activity
node /path/to/treasury/scripts/treasury.mjs unresolved
```

Report requested actions, recorded submissions, confirmed outcomes and refusals separately. Limit
claims to available evidence. This integration does not establish provider concurrency guarantees or
protection against every form of tracing. Access changes cannot cancel operations already submitted.
