# Treasury operations

This runbook covers the Treasury gateway and executors. Deployment, restarts and live money actions
are performed by the owner. Local validation is not a deployment observation.

## Dashboard

Both the default `Dockerfile` and compatibility `Dockerfile.dashboard` build the Treasury interface.
`railway.json` selects `Dockerfile.dashboard`. The default gateway configuration is
`deploy/treasury.json`, with host `treasury.multiagency.ai` and no preconfigured agents.

For self-service registration, configure the backend Agent API key, `SESSION_SECRET` (at least
32 characters), `TREASURY_SELF_SERVICE=true`, and the correct sign-in host. Set `TRUST_PROXY=true`
behind Railway. With self-service off, configure explicit Treasury agent entries and their separate
settings files instead; an empty configuration intentionally refuses startup. `deploy/dashboard.json`
is also Treasury-only. `deploy/legacy-dashboard.json` is historical regression input.

Use one replica and a persistent `/data` volume. The entrypoint runs the gateway from `/data/state`;
registered treasury state is under its `.treasuries/` directory. Never populate a new service with
another running executor's agent ID or grant. A frontend build does not establish executor ownership.

The copied Treasury release record is `07c31669-3ebe-4cc2-ba93-a87009e16c51`, service `treasury`,
2026-10-15. This cleanup has not been deployed or observed on that host. Earlier `dao` and `invoices`
deployment records describe the historical shared workspace; see [the mainnet log](mainnet-log.md)
and [legacy operations](legacy/operations.md).

## Owner release handoff

For the selected DAO demo, use the prepared [routing rollout](treasury-rollout.md) and
`deploy/dao-treasury-demo.json`. It keeps the DAO executor and volume on the existing **dao**
service while making `treasury.multiagency.ai` its entry point. This plan has not been applied.

Before deploying this cleanup, review the exact source revision and run `pnpm verify`. Include the
new Treasury browser fixtures and retained legacy files in the release; a tracked-only diff omits
new files. Confirm that concurrent edits have finished before treating the verification as final.

In Railway, verify the intended project and **treasury** service before deploying. Keep one replica,
the existing `/data` volume, sign-in host, explicit gateway configuration and executor assignments.
The new default configuration has no preconfigured agents: preserve the current configuration or
the existing self-service setting rather than accidentally starting with an empty configuration.
Use the state-preservation procedure below for backup or executor movement. Do not deploy this
Treasury image to the historical invoice executor.

The selected `agentic.sputnik-dao.near` Treasury currently uses the existing **dao** service at
`proto.multiagency.ai`, not the separate self-service **treasury** service. For this target, preserve
its existing Treasury executor and payout approve-only assignment. Both `deploy/dashboard.json`
and the image's default configuration now contain no agents, so do not rely on either for the
existing DAO rollout. Preserve an explicit host configuration; the retained
`deploy/legacy-dashboard.json` describes the inherited host and assignments. Review that mapping
against the actual service before selecting it. The Treasury interface can hide Payables while
the server preserves the existing state and executor responsibilities.

After the owner's deployment:

1. Record the source revision, deployment ID and UTC time privately. Check `/health` and run the
   read-only `pnpm smoke` command below against the intended host.
2. Sign in normally and inspect the Treasury overview, policy, targets and schedule, balances,
   Activity and one selected retained run. Verify the intended schedule state without changing it.
3. Confirm Payables and Steward are absent from navigation. Steward remains available by its
   direct experimental route; opening it is separate from proposing or executing a plan.
4. Rehearse the presenter fallback in [DEMO.md](../DEMO.md#presenter-fallback). Keep this hosted
   inspection read-only; quotes, confirmations and any low-value mainnet demonstration are separate
   owner actions.

If startup or private reads fail, retain state and investigate the configuration or access evidence.
Rollback changes the application image while preserving all operation and owner-action records;
it must not create a second executor. A successful health check alone does not establish a safe
executor assignment or a settled operation.

## Optional self-service Treasury registration

A signed-in NEAR account can register a workspace for itself. A Sputnik DAO additionally requires
current group proposal permission. Registration creates local state, signs no provider intent and
moves no funds. Agent creation, policy updates, strategy authorization and schedule enablement retain
separate explicit actions. Unavailable ownership or permission evidence refuses access.

The current prototype permits one workspace per owner and at most 16 per host. It has no workspace
deletion, ownership transfer, distributed provisioning or cross-host executor fencing. Each registered
owner gets an isolated working directory and settings file. Shared provider and RPC credentials remain
server-side; child processes do not receive parent agent grants, owner private keys or invoice ports.

Registration and access isolation have offline tests. Those tests do not establish that a real owner
created an agent through the current hosted build.

## Executor migration and state preservation

Stop the gateway, every child executor and all CLI writers before backup, copying, upgrade or moving
an executor. Start the destination only after the source is stopped. `EXECUTOR=off` is required on
every other instance of the same agent. The lease and money lock coordinate a single host only.

Preserve the entire state directory and all settings, including:

- `.treasuries/registry.json` and every registered child's `.env.instance` and complete working directory.
- `.ops/`, `.invoices/` including SQLite journals, `.owner-intents/`, `.strategy/`, `.plans/`,
  `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/` and legacy `.intake/` state.
- Existing grant tokens, staged grant settings, journal identities and owner-action records.

Do not discard inherited directories because the Treasury UI no longer exposes their workflows.
Never initialize a fresh registry over retained child state. A corrupt registry or missing registered
settings must be investigated; do not replace them merely to resume execution.

This cleanup changes product defaults, routing, documentation and read-only tools. It changes no stored
money records, policy schema, dispatch authorization or executor locking, and requires no state-format
migration. Changing defaults is still a reviewed rollout: preserve explicit existing environment and
executor settings. Rollback must retain all records and avoid starting another executor.

## Settings and record-read hardening

Settings writers lock the canonical settings-file target. Symlink aliases share that lock; contention
returns a retry error without replacing settings. A CLI edit does not refresh another process's
environment. Do not remove a live writer's lock. Unreadable journal, owner-intent, inbox and agreement
records require investigation against verified evidence; never erase them to unblock sending.
Detailed historical upgrade notes remain in [legacy operations](legacy/operations.md#settings-and-record-read-hardening).

## Scheduling cadence and local refactoring

Saving a strategy persists scheduling off. The owner authorizes its exact digest-bound grant, then
explicitly enables the schedule. Stop prevents future scheduled ticks; an already started tick can
submit further operations and submitted operations may finish.

Cadence is counted from the latest recorded inbox `run` summary. That summary precedes the final
after-observation and evidence end. A missing end can mean an interrupted or unknown run; it does
not independently pause cadence. Unresolved operations still block new sends. A separate durable
scheduler checkpoint is not implemented.

## Unattended run: observing the Treasury autopilot

Use the existing `pnpm run-report` with its configured dashboard URL, session file and agent name.
Keep reports and real recordings outside the repo. A scheduled run, provider acceptance, operation
settlement and an absence of dashboard interventions are separate observations. The report's
historical intervention classification is retained. Multi-day unattended operation remains a gap.
See [the detailed report procedure](legacy/operations.md#unattended-run-observing-the-treasury-autopilot).

## Read-only checks

```sh
DASHBOARD_URL=https://treasury.multiagency.ai pnpm smoke
DASHBOARD_URL=https://treasury.multiagency.ai REPORT_COOKIE_FILE=/private/session pnpm demo-check
```

Smoke checks health, headers, host-bound sign-in and signed-out access refusal. With a private session
and `SMOKE_SNAPSHOT`, it checks preservation for the actual accessible agent names, including registered
Treasuries. An old two-agent snapshot is not silently rewritten; identity differences fail the check.
`INVOICES_URL` is optional and only enables historical invoice-host checks.

Demo preflight discovers the accessible Treasury. Set `REPORT_AGENT` when more than one is accessible.
It reads valuations, budget headroom, unresolved operations and schedule state. A manual preview does
not require scheduling on; set `REPORT_REQUIRE_SCHEDULE=true` for a scheduled-run demonstration.
`REPORT_EXPECTED_USD` is a rehearsal estimate, default 5, not authorization or a spendable-balance
claim. A missing USD budget fails the check rather than proving an unlimited budget is acceptable.
These commands do not create a quote, recover an operation, sign or send funds.

## Historical compatibility

`PUBLIC_TREASURY_ONLY=false` selects the inherited UI for regression tests only. Payables execution
requires the explicitly named `Dockerfile.legacy-invoices` or `pnpm legacy:invoices`; it is outside
the Treasury product. Its state and recovery obligations remain documented in
[legacy operations](legacy/operations.md#payout-executor).
