# Treasury quality handoff

**Create a Treasury agent, sign its spending envelope, and delegate quoted rebalancing with
inspectable outcomes.** The DAO Treasury is the reference; wallet and DAO owners use existing
optional registration and explicit owner actions. Payables and Invoices remain compatible future
siblings outside this phase. Steward stays hidden and requires explicit plan execution.

## Source boundaries

Treasury owns its focused interface and reuses the existing agent, executor, owner intents,
dispatch, reconciliation and evidence paths. Each agent retains its own authority and state.
There is no platform extraction or new money API.

The separate evolving `/Users/jlwaugh/agencies/proto` checkout is context for shared infrastructure.
Its product and deployment are outside this task. The five isolated local Proto packaging files
previously added here were removed from the candidate after inspection; they were not used by
the default Treasury build. No live Proto deployment was performed. The duplicate reference
configuration was consolidated into `deploy/dao-treasury-demo.json`, without redirect hosts.

## Reviewable journeys

The [demo](../DEMO.md) covers signed limits, quoted rebalancing, strategy-bound scheduling,
confidential sweep and inspectable operation outcomes. Creation is a separate journey through
registration, explicit creation/policy authorization, strategy authorization, funding and schedule
enablement. Opening a page or registering signs nothing. Offline browser fixtures stop before
real signing; the reference's historical evidence does not certify a new owner's Treasury.

Spending limits do not cap market exposure. Owner authorization does not enable a schedule.
Run completion does not establish operation settlement. Budget differences are observations,
not necessarily plan-specific charges. Strict cumulative caps and atomic USD accounting under
concurrency remain unverified; confidential balances do not establish universal untraceability.

## Release and verification

Use [scope](scope.md) for boundaries, [architecture](architecture.md) for execution invariants,
[operations](operations.md) for state preservation and [release review](treasury-rollout.md) for
unresolved topology decisions. Those documents replace the earlier Proto redirect proposal.
No deployment, restart, DNS change, state migration or money action is authorized here.

The earlier report of 733 tests and browser passes describes a prior working-tree snapshot.
Current validation results must be reported against the candidate actually checked. Generated
requirement tables remain owned by `evidence/inventory.ts`; do not edit them by hand.
