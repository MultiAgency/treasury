# Repository scope and destinations

This repository focuses on **idea 2 — Agentic Treasury Management** at
`treasury.multiagency.ai`, retaining compatible **idea 1 — SputnikDAO Confidential Treasury
Facilitator** and **idea 3 — Invoicing & Purchase-Order Management** code. Payables and Invoices
are future sibling experiences outside this Treasury quality phase. `proto.multiagency.ai`
remains the umbrella showcase for all three ideas and must never redirect to Treasury.

The actual sibling checkout is `/Users/jlwaugh/agencies/proto`, a separate Git working tree
with origin `MultiAgency/agentic-treasury-private`; this checkout's origin is `MultiAgency/treasury`.
Both contain related gateway, owner-intent and executor code. Proto has evolving shared-infrastructure
and routing work of its own; its candidate architecture does not determine Treasury's product scope.
No code synchronization, platform extraction or Proto modification is part of this cleanup.
Local directory inspection establishes these source boundaries, not deployed service ownership.

A hostname names a product destination; it does not confer authority or create an executor.

The canonical local definitions are the catalog mapping and buyer/supplier workflows in
[Agent Connect audit](agent-connect-audit.md#scope-and-the-four-audit-gates). Requirement stages
come from [evidence/inventory.ts](../evidence/inventory.ts), not domain names. The inventory's
short label “Purchase orders” denotes idea 3, whose full catalog title is above.

## Domain-to-responsibility mapping

| Destination | Purpose, audience and primary flow | Current frontend and backend | Agent, executor and persistent state |
|---|---|---|---|
| payables.multiagency.ai — idea 1 | DAO owners/members review external requests, separately agree payees, then approve held confidential payouts | Shared React Payables area (`PUBLIC_TREASURY_ONLY=false`), gateway and `rpc/payables.ts`; intake is currently served by the invoice host. No dedicated Payables host configuration is tracked | Existing payout agent, its own owner-signed policy and payout grant. Historical `dao` gateway instance is approve-only; `invoices` service is its sole executor. Payout settings and `.ops/`, SQLite `.invoices/`, `.owner-intents/`, `.agreements/`, `.inbox/`, `.notify/` remain at their existing locations |
| invoices.multiagency.ai — idea 3 | Buyer creates and explicitly authorizes/funds one isolated order; supplier files its fixed invoice; owner reviews payout; observe outcome and retire authority. Separately owned supplier agent converts receipts and forwards proceeds | Current `invoice-page.ts` / `invoice-browser.js` and `invoice-http.ts` serve general idea-1 intake. Work-order RPC, private bridge and payee APIs exist; no work-order frontend is connected. Supplier settlement is absent | Current host runs the idea-1 payout executor via `invoices-server.ts`, not a separate invoice grant. Candidate order subprocesses use their own agent, fixed policy, expiring `invoices` grant and state under `.work-orders/<parent-agent>/`; supplier agent lifecycle remains unimplemented |
| treasury.multiagency.ai — idea 2 | Owners delegate quoted rebalancing within signed limits; authorize strategy, explicitly enable scheduling, inspect operations and sweep | Default Treasury React build; gateway plus treasury RPC, plans and autopilot. `deploy/treasury.json` has no preset agents; optional self-service registry | Separate Treasury agent/policy/strategy grant and sole executor per agent. `/data/state`, `.treasuries/registry.json`, isolated child settings and complete state. Existing DAO Treasury remains associated with historical `dao` until an owner-reviewed topology change |
| proto.multiagency.ai — umbrella | Public reviewers discover all three ideas and their evidence stages; signed-in members follow scoped tasks | Historical shared React build and gateway (`deploy/legacy-dashboard.json`). Its current public presentation covers two areas; a complete three-idea showcase remains a UI gap | No umbrella wallet, pooled policy or shared money authority. Historical gateway starts Treasury executor and payout approve-only instance, with separate settings. It must reuse those assignments rather than duplicate executors |

This is a source/configuration inspection, not a fresh live deployment inspection. Historical
`dao` and `invoices` observations retain their dates, proposals and deployment references in
[mainnet log](mainnet-log.md). The copied Treasury release was recorded as
`07c31669-3ebe-4cc2-ba93-a87009e16c51` on 2026-10-15; that does not certify this candidate.
No deployment of a dedicated Payables destination or complete idea-3 destination is established here.

## Shared infrastructure and authority boundaries

Share the TypeScript server, gateway sign-in and per-agent permissions, provider adapter, owner-intent
verification, dispatch, reconciliation, journal formats and frontend components. Never pool agents'
wallets, policies, grant tokens, permissions or operation records. A shared owner or provider key
does not authorize another agent's purpose. An agreement on the payout agent is not an isolated
order agent. Supplier authority belongs to its own owner and policy, not the buyer or main Treasury.

Every send retains the single dispatch site, mandate digest, money lock, write-ahead record and
unresolved-operation refusal. Keep exactly one executor per agent and `EXECUTOR=off` elsewhere.
Locks and leases coordinate one host only. Explicit owner signing, payout approval and plan/sweep
confirmations remain separate steps. Presentation flags and hidden routes do not restrict backend
authorization. No money-path or state-format change is part of this documentation update.

## Implementation and evidence gaps

- Decide whether Payables and Proto use separate gateway services or a host-aware shared gateway;
  define host-bound sessions, scoped frontend builds and read/approval access before rollout.
  Current single-host configuration does not implement that destination split.
- Decide the DAO Treasury's eventual host/service assignment without displacing Proto or losing
  the separate Treasury wallet workspace. The previous Proto redirect rollout is superseded.
- Connect idea-3 order controls and payee UI; verify full creation, funding, payment, restart,
  authority retirement and residual-fund handling. Candidate modules and offline tests are not
  evidence of a deployed order lifecycle. Partial invoices and amendments need separate designs.
- Implement separately owned supplier receipt discovery, conversion and forwarding with durable
  operation identities and interrupted-run recovery. No supplier settlement flow is established.
- Complete idea-1 acceptance evidence for a new payee. Agreement ceilings/deadlines are review
  context in the general payout flow, not universal automatic enforcement.
- Treasury still lacks exact public-payout unshielding, an idle-surplus reserve, multi-day unattended
  evidence and independent proof of strict cumulative caps/atomic USD charging under concurrency.
  Spending caps do not bound market exposure; confidentiality is not universal untraceability.

## Build and demo boundaries

Ordinary `pnpm web`, `pnpm build:web`, `pnpm demo` and dashboard images currently default to
Treasury. `PUBLIC_TREASURY_ONLY=false` selects the implemented shared Payables/Portfolio interface
for retained sibling regression checks and separately scoped future work.
The default Treasury frontend redirects payment routes and cannot serve the intended Payables
or complete Proto experience. Keep the idea-2 minute focused; do not add invoice tasks to it.
Steward remains hidden at `/a/<agent-name>/steward` or `/steward`, with explicit plan execution.

Historical documents and generated evidence remain under `docs/legacy/`; their location does not
make idea 1 or idea 3 out of scope. Preserve every record and its original evidence attribution.
Any future extraction or state conversion requires recovery/concurrency validation and a
stopped-executor preservation procedure; no such migration is authorized here.
