# Operations runbooks

Treasury-relevant operating notes moved from the former shared-workspace operations document. They describe
repository configuration; deploys, restarts and money actions are performed by the owner. For the current
guide, see [operations](operations.md). Rollout notes for the earlier combined UI candidate, the Dashboard
deployment, the payout executor and the invoice migration remain in [legacy operations](legacy/operations.md).

## Settings and record-read hardening

Settings updates now lock the canonical settings-file target before reading and replacing it.
Symlink aliases share that lock. A competing update returns a retry error without changing settings;
retry the action after the current writer completes. This is single-host coordination, not distributed
fencing. A CLI edit does not refresh another running process's environment. After a writer crash,
the settings lock must age past its 60-second stale threshold; never delete a live writer's lock.

Before upgrading, stop all writers, including CLI processes using the same settings file. Old writers
do not participate in this lock. Preserve the full state listed above and the settings files. The saved
formats are unchanged, so there is no record conversion. Offline child-process tests cover competing
settings updates, retry, and symlink aliases; this is not a mainnet observation.

Inbox and agreement readers reject damaged records, including a torn final append, rather than hide
them. Unreadable inbox history defers scheduled ticks and logs an error without crashing the server.
The peer owner-intent scan similarly refuses a new DAO delegate when the fields needed to check
pending actions cannot be read. Preserve the damaged file, stop writers before repair, and restore
only from verified records. Do not delete evidence merely to resume a schedule or prepare an action.
Manual ticks and operation-journal authorization retain their existing behavior.

Own and peer owner-intent readers now reject malformed or contradictory lifecycle records. A missing
stage is compatible only with an unsigned legacy preparation; a retained signature must never be
converted back to a first submission. Keep the original file intact, stop writers, and investigate
against verified outcome evidence. This is validation of existing records, not a format conversion.
Onboarding now acquires the executor lease and starts its background loops without a restart. If
ownership is unavailable, recover the original creation action after resolving executor ownership;
do not create another agent or submit the signature again.
The cumulative autopilot ceiling reads existing per-operation `planId` and `usdIn` records; it adds no
counter or state conversion. Preserve those records with the full state above. Missing valuation
evidence refuses a new swap rather than resetting the amount already submitted, and a claimed plan
remains single-use after restart. These local checks do not resume partially executed plans.

Gateway configuration rejects duplicate agent ports before starting listeners or child processes.
Distinct names must point to distinct loopback servers, including externally started servers.

DAO delegate preparation also uses an owner-scoped lock in the shared `.owner-intents/` directory.
Stop every instance and CLI writer sharing that directory before upgrading; older versions do not
take this lock. Keep the entire state listed above unchanged. There is no record-format conversion.
A competing preparation refuses for retry. A dead holder's lock becomes eligible for takeover after
10 seconds; do not delete a live lock. Instances on different hosts or using separate state directories
are not coordinated by this lock.

An unresolved submitted delegate keeps other preparations blocked until the original instance's
owner-intent recovery records an outcome. Expiry alone is insufficient. Owner success permits a
later preparation even when the released payout is still settling. Preserve older settled records
without outcome evidence and investigate them; do not fabricate a result or delete them to unblock.

## Journal v2 and owner-intent locking upgrade

The journal reader also recognizes standalone version-1 authorization snapshots attached to an
unversioned preparation. These historical records remain unchanged and are ignored for lifecycle
decisions: they never establish that an operation was submitted, settled or safe to retry. Unknown
versions, orphan snapshots and snapshots mixed with lifecycle fields still refuse. No conversion
is required. Validate the retained journal with the candidate reader on a disposable backup copy
before starting the executor; source-only tests do not establish compatibility with every history.

This is an additive state-format migration. Stop the executor and every server/CLI that writes this
agent's operations or this instance's owner intents before installing the new build. Do not perform
an overlapping rollout with old writers: they do not participate in the owner-intent lock or write
journal submission claims.

1. Back up the complete state listed at the top of this guide, including `.ops/`, `.invoices/`,
   `.owner-intents/`, `.strategy/`, `.plans/` and `.evidence/`. Preserve SQLite journals and settings.
2. Keep existing JSONL and owner-intent JSON files in place. No rewrite or backfill is needed:
   unversioned operation records remain legacy, and missing submission evidence remains ambiguous.
   Never add `journalVersion: 2` to an old request to clear an unresolved operation.
3. Start only the new build. New non-invoice request lines carry `journalVersion: 2`; a separate
   `SUBMISSION_ATTEMPTED` line commits before the provider call. Startup/reconciliation acquires the
   money lock and may append `never_submitted` only to an unclaimed v2 preparation. Existing invoice
   records keep their SQLite schema and continuation rules.
4. Owner-intent JSON retains its format. All new writers lock its per-instance path and reload it
   before updating; expired preparations and settled-token cleanup run under that lock too. A dead
   writer's lock must become stale before takeover. Do not delete a live writer's lock.
5. Review unresolved operations before resuming work. An attempted operation without an ID still
   requires investigation. Do not downgrade to writers that ignore v2 claims or owner-intent locking;
   stop and review state compatibility before any rollback.

This migration preserves historical evidence and does not reinterpret legacy uncertainty as proof
of non-execution. The fixes have offline process-crash and concurrency coverage; deployment remains
a separate owner action.

## Unattended run: observing the treasury autopilot

How a 24-hour observation of the scheduled autopilot is started, recorded and reported. It answers one
question: does the scheduler run on its own without missed ticks, duplicate execution, actions outside its
schedule, or manual recovery? It says nothing about custody guarantees or economic benefit
([enforcement](enforcement.md)).

### What records the evidence
- **The scheduler itself**, not a watcher, appends synced lines to `.evidence/<agent id>.jsonl` in the
  agent's state directory (on `dao`, `/data/state/.evidence/`, a volume with backups enabled). See
  src/evidence.ts.
  - **`start`, written before the tick acts:** a unique tick id, the trigger (`schedule` or `operator`),
    the scheduler's recorded settings (on, interval, limit, and the run its schedule counts from), and the
    build: Railway's deployment id plus sha256 digests of the `src/` tree, `pnpm-lock.yaml` and
    `package.json`. Also the policy revision and digest, the strategy digest, and the live grant's id and
    label (never the token).
  - **`end`, written after:** the book, drift, budget usage and unresolved operations before and after;
    the plan with its legs and quotes; each step's and shield's status and correlation id; rejection
    reasons; a proven refusal's code; and the tick's own summary.
- **Write failures:**
  - If the start can't be written, the tick doesn't run and the inbox says so.
  - If the end can't be written, the inbox says so.
  - A start without an end is reported as incomplete (interrupted, or outcome unknown), never as success
    or failure.
  - A line that doesn't parse, such as a torn final line, is counted as unreadable, not trusted.
  - Every log here appends through one function (`src/synced.ts`). After a torn final line, the next
    record starts its own line, so a crash mid-append loses only the torn line (offline-tested,
    `test/synced.test.ts`).
- **Interventions:** the gateway records every call classified by `isIntervention` in
  `.evidence/interventions.jsonl` (account, agent, procedure, time) before forwarding it. If the record
  can't be written, the call isn't run. Calls made on a host directly (CLI, shell) are not in this record.
  An unreadable line in the record is counted and fails the "no operator interventions" criterion, since
  it may have been a call. Builds up to c25b61b skipped such lines instead; `pnpm run-report` refuses a
  gateway that doesn't count them.
- **Reading the records:** `autopilot/evidence` on the treasury agent server, and `/gw/interventions`
  (execution or settings permission). In the build under observation (fe3330c), `autopilot/evidence` is operator-only too, so
  the gateway records each read of it in the intervention record; the report lists those reads separately as
  operator reads, not interventions. Later builds make it a member read, which the gateway doesn't record.
- **The report:** `pnpm run-report` (src/run-report.ts, logic in src/report.ts, tests in
  test/report.test.ts). It reads the evidence, the intervention record and the books, and reports:
  - each criterion;
  - configuration segments (build, mandate or scheduler settings);
  - every tick's outcome: executed, no-op, refused, failed, skipped or incomplete;
  - the incident behind each failed criterion.

Nothing depends on a chat session or a laptop staying up. Collection runs only while a build containing
src/evidence.ts runs on `dao`.

### How the report judges
- **Scheduled work:**
  - Only completed scheduled ticks count. Operator, skipped and incomplete ticks are named inside any gap
    they fall in.
  - Each gap is judged by the interval the later tick recorded, plus 3 minutes.
  - Records are sorted, and both window bounds apply.
- **Duplicates:**
  - "Duplicate references" (an operation or plan named by two ticks) is reported apart from duplicate
    execution.
  - Duplicate execution is confirmed only when one plan leg settled twice. An execution no tick recorded
    with the same terms as one a tick recorded is a suspected duplicate: separate operations can share
    terms.
  - If executions no tick recorded exist without such a match, the answer is "cannot be established",
    not "yes".
- **Unresolved operations** seen at a tick are reported as an observation. Interventions come only from
  the gateway's record and operator-triggered ticks, so "none" means none recorded there.
- **Refusals** show a control was invoked, not that it refused correctly. A failed shield or step, or an error, is a failure.

### Starting a window
1. Deploy a build whose `src/` contains authorization, evidence collection and the execution-mode
   removal, from a reviewed snapshot. Record the deployment id, image digest, and the snapshot's `src/`,
   lockfile and `package.json` digests.
2. Confirm the autopilot is on and hourly, and that the live grant approves the strategy in force.
3. Wait for the first scheduled tick. Its start line must match the deployment id and all three digests.
   Its end line fixes the starting book, budget and mandate.
4. The window starts at that tick, in UTC, and ends 24 h later.

### During the window
- Don't press "Run now".
- Don't force imbalances, raise limits or manufacture trades.
- A correct no-op or refusal is a valid outcome.
- Any operator action, payment or approval in the window is reported as an incident, not hidden.
- If the build, policy, strategy or grant changes, the report starts a new segment. Evidence from earlier
  segments still counts for its own configuration.

### Generating the report
Sign in to the dashboard with execution or settings permission. Save the `dao_session` cookie to a 0600 file, never
pasted anywhere. Then run:

    DASHBOARD_URL=https://proto.multiagency.ai REPORT_COOKIE_FILE=<file> \
    SINCE=<window start> UNTIL=<window end> OUT=<report.md> pnpm run-report

### Success
- **The run succeeds when** it has, with incidents recorded honestly:
  - no unexplained missed ticks;
  - no duplicate execution;
  - no execution outside scheduled ticks;
  - no unresolved operation needing manual recovery;
  - every tick able to read its book and mandate.
- **No particular number of swaps is required.**
- **Reported separately from the result:** operational reliability is one thing. Custody guarantees (atomic
  budgets, strict monthly caps, the bought asset) and economic benefit are separate claims that one day
  doesn't support.


## Run progress rollout

The writer creates `.evidence/progress/<agent-id>/` when it records the first observation.
No migration command or existing-state conversion is needed. New start lines optionally identify
progress format 1; new end lines may flag incomplete progress. Recording exports use envelope
version 2 for these ticks. Historical version 1 recordings remain supported.

1. Stop the executor for the agent and confirm that no unattended observation or freeze window
   is active. Keep all other instances approve-only. The executor lease is single-host,
   not distributed fencing; it cannot detect an executor on another host.
2. Back up the entire state volume, preserving `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`,
   `.plans/`, `.evidence/`, `.inbox/`, `.agreements/` and `.notify/` together.
3. Deploy the reader, dashboard and executor from the same release, then restart the single executor.
   Check a private recording for stage events and confirm unknown outcomes remain unresolved.
   This rollout and any mainnet action are the owner's actions; they have not been performed here.

For rollback, stop the executor again and retain every state directory, including progress files.
Older code ignores the optional start/end fields and does not read the progress directory; it cannot
show the intermediate history. Keep the newer reader available for version 2 downloads. Never
convert a version 2 file to version 1 by relabeling it.
`test/run-progress.test.ts` verifies automatic initialization and existing-state preservation offline;
the recording tests cover historical ticks without progress.

## Scheduling cadence and local refactoring

The scheduler currently counts its interval from the latest inbox `run` summary, written before the
final after-observation and tick evidence end. Warnings and dismissals do not change that timestamp.
An interrupted evidence start does not itself advance the schedule; an unresolved operation still
blocks sends through the existing money lock. `test/autopilot.test.ts` checks these distinctions offline.
Keep `.inbox/` alongside `.evidence/` during preservation and migration. No new scheduler checkpoint or
state migration is introduced by the planning extraction; switching scheduling sources would require
separate restart semantics and compatibility tests.

The planning extraction keeps `.plans/` filenames, JSON, content digests and execution claims unchanged.
It changes the source digest, so identify any deployed build with its own release record. The optional
`DASHBOARD_AREA` setting changes presentation, not authorization. Configure an external agent server's
area explicitly as well as its gateway entry; gateway-managed children receive it from `area`.

## Task-flow and RPC extraction candidate

The task-flow extraction adds a private, member-readable `instance` procedure and preserves existing
RPC paths and action permissions. Ship the gateway allowlist, agent server and frontend from the same
reviewed build so the provider-independent schedule-stop view can read instance mode. This work
changes no state formats and requires no conversion. Preserve all existing state directories as usual.
The lazy application entrypoints and recovery views are verified locally with intercepted browser
requests; deployment, restarts and hosted verification remain separate owner actions.

An inherited `EXECUTOR=off` remains a process-lifetime restriction even if the instance settings file
contains `EXECUTOR=on` or settings are saved at runtime. Changing executor ownership requires the
existing stopped-executor procedure; instance-file loading cannot lift that restriction.

## Isolated Treasury-only interface candidate

Build the brief 02 presentation with `PUBLIC_TREASURY_ONLY=true pnpm build:web`; the dashboard Dockerfile accepts the same build argument. Default builds retain the shared workspace. The flag scopes presentation only; gateway permissions and the existing dispatch path remain authoritative. It does not create an executor, migrate state, configure DNS or authorize a rollout. The intended hostname is `treasury.multiagency.ai`; sign-in must use the matching gateway host when deployed.

The interface is prepared in an isolated source copy while other sessions continue. Preserve the one-executor mapping and follow the coordinated rollout above before pointing this interface at the existing live services. Do not deploy this full source candidate while its unrelated work-order access-classification tests fail.

## Optional self-service Treasury registration (isolated candidate)

Set `TREASURY_SELF_SERVICE=true` on the gateway and build with `PUBLIC_TREASURY_ONLY=true` (a Docker build argument). `DASHBOARD_FILE=/app/deploy/treasury.json` supplies the intended host and an empty initial agent list. A signed-in NEAR account can register its own workspace; a Sputnik DAO additionally requires current group proposal permission. Registration creates local state only. Agent creation, policy, grant and schedule enablement retain their separate existing owner controls. An unavailable ownership or permission read refuses access. Default gateway builds retain configured-owner admission.

This candidate can run as a separate service for newly created agents; it must never be populated with another executor's agent ID or grant. The gateway starts one child per registered owner with a separate working directory and settings file, and does not pass parent agent credentials, owner private keys, invoice ports or schedule settings. Shared Agent API and RPC service credentials remain server-side. The prototype has a fixed capacity of 16 registered treasuries and one per owner; it has no workspace deletion, ownership transfer, distributed provisioning or cross-host fencing. Provider account quota remains shared.

Preserve the entire `.treasuries/` directory, including `registry.json`, every `.env.instance`, and every child’s `.ops/`, `.invoices/`, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/`, `.work-orders/` and legacy state. Stop the gateway and all child writers before backup, copying or migration. Never initialize a new registry over retained child state. Missing registered settings and a corrupt registry fail startup. New empty installations initialize additively; existing state needs no conversion. Offline tests cover retry/restart preservation. Rollback with self-service disabled must retain all these directories and stops serving their workspaces; do not restart their executors elsewhere without the stopped-writer procedure. The gateway lease coordinates only one host.

Registration and access isolation are tested with loopback fixtures, and both owner choices are browser-tested through preparation with signing intercepted. No real account or DAO was created for this candidate, and no live service was changed.
