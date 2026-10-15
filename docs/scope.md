# Repository scope

This checkout implements **02 Agentic Treasury Management**. The user-facing idea is delegated
rebalancing inside owner-signed asset and spending limits, with confidential resting balances and
reviewable operation evidence. The primary interface, quick start, deployment defaults and demo
must tell that same story.

## In scope

- Read balances and fresh valuation; target allocations; quote every planned swap before execution.
- Signed allowed assets and per-asset monthly caps; cross-asset USD budget headroom and refusals.
- Strategy-bound grants, explicit authorization, scheduled execution and manual quoted rebalancing.
- Shield managed public balances; preserve confidentiality limitations.
- Durable operation identities, fail-safe unknown outcomes, one send site and private audit history.
- Wallet or Sputnik DAO ownership; isolated self-service registration when configured.

## Missing parts of the brief

Exact unshielding for a public payout, a calculated idle-surplus reserve, independent proof of atomic
USD-budget charging and strict cumulative asset caps under concurrency remain gaps. The current
three-asset strategy needs at most two swap legs. Adding invoice collection or manufacturing a
third leg does not close these gaps.

The catalog example is design input, not executable configuration for the pinned SDK. It uses
`capabilities`/`rules`, separate `budget_set`, camelCase swap arguments and a stated
`policy_confidential_whitelist_conflict`. This repo's SDK policy uses `actions`, `assets`, `limits`,
`budget` and `destinations`; its treasury policy currently has an empty `only` destination list.
Do not silently replace that policy or infer the deployed provider's schema from the example.
A future policy/choreography change needs pinned provider evidence, offline fault tests and an
explicit owner-signed update. No policy or authorization rule changes are part of this cleanup.

## Future integration and hidden experiment

Payables is a future integration. The current prototype first demonstrates Treasury rebalancing,
limits, budget observations and confidential sweep. Retained payout code preserves a foundation
for that integration without adding invoice or agreement tasks to the present demo.

Steward is a hidden experimental demo feature at `/a/<agent-name>/steward`, or `/steward` on a
standalone server. It is not listed in navigation or required by the 60-second Treasury story.
Opening it makes no inference request and submits no operation. Propose requires the existing
permission and backend NEAR AI configuration; it prepares a plan, not a send. Execution retains
its explicit confirmation and the same saved-plan authorization and dispatch checks.

## Retained compatibility code

`src/` retains payout/invoice modules because they share dispatch, owner signatures, recovery,
notification and access-control code and may be needed to interpret existing records. Their tests
remain offline regression coverage. This cleanup does not remove RPC capabilities or change server
permissions; hiding a route is not a security boundary.

`PUBLIC_TREASURY_ONLY=false` exists solely to exercise the inherited frontend regressions. Normal
`pnpm web`, `pnpm build:web`, `pnpm demo` and the dashboard Docker build use Treasury. The default
surface redirects the old payee, payment and guided-demo routes; it has no invoice or
manual payout entry point. The legacy overview hashes open the Treasury landing flow.

Historical docs live in `docs/legacy/`; the dated mainnet log and enforcement assessment keep their
original evidence scope. Roadmap experiments there are not active product requirements. Never
remove retained state or historical outcomes to make the code or demo look simpler.

A later backend extraction must first map every import and record reader, reproduce recovery and
concurrency behavior, preserve old state, and verify a stopped-executor upgrade. Until then,
retaining tested shared safety code is deliberate; it is not a claim that the repo contains only
Treasury source files.
