# Agentic Treasury Management

Delegate rebalancing to a treasury agent under an owner-signed policy: allowed assets,
per-asset monthly caps and a cross-asset USD budget. The agent reads balances, quotes swaps
before execution, rebalances toward target allocations and shields managed public balances.

The product target is an agent that cannot exceed its signed spending envelope. **That complete
guarantee is not established today.** Mainnet observations cover scheduled rebalancing, quoted
swaps, cap and budget refusals, budget headroom changes and shielding. Provider counter concurrency,
atomic USD-budget accounting and custody-level output-asset enforcement remain open. Spending caps
do not cap portfolio market exposure. See [requirements and evidence](docs/treasury.md) and the
[enforcement assessment](docs/enforcement.md).

## Run locally

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set the backend Agent API key and owner configuration described in .env.example.
pnpm demo
```

The dashboard runs at http://localhost:8787. `pnpm web` starts the frontend development server,
with RPC proxied to the local backend. Ordinary frontend builds and development now use the
Treasury interface; no presentation flag is needed.

Creating an agent, signing its policy and issuing its grant require explicit owner actions.
Saving a strategy leaves scheduling off. The owner authorizes the saved strategy, then explicitly
enables its schedule. Opening a page or preparing a quote moves no funds.

## One product, one demo

The Treasury overview puts allocations, signed monthly caps, budget headroom, quoted rebalancing,
schedule status and confidential sweep together. A confirmed manual plan’s outcomes stay on that
screen, beside before-confirmation and latest observed budget headroom. Signed limits show each
USD budget window; recorded refusal codes load on request. These observations do not establish
atomic charging or attribute every budget change to that plan. This presentation is offline-tested,
not a new hosted or mainnet observation. Supporting views cover targets and schedule,
policy and grants, balances and funding, run details and operation history.

The [60-second walkthrough](DEMO.md) follows one plan from balances through quotes to recorded
operation outcomes and budget changes. The current strategy manages USDC, wNEAR and ETH; a
three-asset rebalance needs at most two swap legs. Do not invent a third swap to match the catalog's
example. Exact unshielding for a public payout is a missing part of the brief, not a reason to add
an invoice or agreement demo.

Payables is a future integration. Invoice collection, agreement management, campaign payments,
DCA and Bitcoin checking are outside the current Treasury demo. Inherited payment routes are
redirected out of the Treasury interface. Steward remains available as a hidden experiment at
`/a/<agent-name>/steward` (or `/steward` on a standalone server): it proposes plans for explicit
review and execution, and is absent from navigation. Shared backend modules and regression fixtures remain where they support authorization,
owner actions, journal recovery or historical compatibility; their presence is not a product feature.
See [repository scope](docs/scope.md).

## Verification

```sh
pnpm typecheck
pnpm test
pnpm test:browser          # Treasury UI, registration and scope fixtures; no real provider
pnpm evidence:check
```

`pnpm verify` also runs the inherited browser and application regressions. Those explicitly select
the historical presentation; their invoice and payout cases protect retained shared code.
`pnpm test:live` touches real funds and runs only when explicitly requested.

Requirements and supporting observations live in [evidence/inventory.ts](evidence/inventory.ts).
Update the inventory, then run `pnpm evidence:write`; generated sections are never hand-edited.
[Mainnet observations](docs/mainnet-log.md) retain their original agent, date and deployment scope.
They do not establish behavior of a new source build or every registered treasury.

## Hosting and state

This standalone checkout was copied from the Treasury release recorded on 2026-10-15:
`07c31669-3ebe-4cc2-ba93-a87009e16c51`, Railway service `treasury`,
https://treasury.multiagency.ai. This cleanup has not been deployed or checked on that host.
The gateway configuration is [deploy/treasury.json](deploy/treasury.json). Self-service registration
is optional and requires `TREASURY_SELF_SERVICE=true`; registration signs nothing and starts with
scheduling off. See [operations](docs/operations.md).

Deploys, restarts and live money actions are the owner's. There must be exactly one executor per
agent. The executor lease and money lock coordinate one host; they are not distributed fencing.
Preserve all agent state before any executor move, including inherited record directories.

## Not done yet

- Atomic USD-budget charging under all concurrent dispatches is not independently established.
  One simultaneous-swap trial is supporting evidence, not a proof.
- Strict cumulative per-asset enforcement under concurrency remains unverified. The application
  checks output assets; the provider's asset restriction has been observed to check inputs only.
- Exact public-payout unshielding and a calculated idle-surplus reserve are not implemented.
  Sweep shields the managed public USDC, wNEAR and ETH balances.
- Confidential balances reduce public balance visibility; universal untraceability is not established.
- Multi-day unattended operation is not demonstrated. Scheduling is not settlement evidence.
- The catalog's API example uses a different policy shape from the pinned SDK in this repo.
  Its address-whitelist conflict and budget-charging semantics must be verified against the actual
  provider before changing the money path; see [scope and compatibility](docs/scope.md).

The [architecture](docs/architecture.md) describes the one send site, durable journal, reconciliation,
owner intents and trust boundaries. Historical two-area instructions are retained under
[docs/legacy](docs/legacy/README.md), outside the primary demo and product scope.
