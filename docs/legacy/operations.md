> Historical shared-workspace documentation. Retained for evidence and compatibility; this is not the Treasury product scope or its current runbook. Start at [README](../../README.md).

# Operations

These instructions describe the repository configuration. Deploys, restarts and money actions are
performed by the owner. For the product and recorded results, see [README](../../README.md).

Preserve the complete state when moving an executor: `.ops/`, `.invoices/` (including SQLite journals),
`.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`, `.agreements/`, `.notify/` (which alerts were sent: losing it re-sends them), any legacy `.intake/` files, and its
settings file. Stop writers before copying state; never start the destination before stopping the
source. The lease coordinates processes on one host only.

## Combined UI, strategy and recovery candidate

This is the locally prepared candidate based on `5cd6cc9fbb584a3174b6d7586fbdda8633cf4d45`,
not a deployment record. The base commit alone does not identify its uncommitted changes: retain
the reviewed file-hash manifest and the final release commit or source-archive checksum in the
private release record. Recheck changes made after validation before shipping. Local browser
fixtures and offline tests do not establish hosted behavior or actual screen-reader speech.

### What ships where

| Service | Candidate changes | Persistent state |
|---|---|---|
| `dao` (`Dockerfile.dashboard`) | Dashboard simplification; reviewed policy/payment confirmations; strategy save, authorization and enable controls; payment/owner-action recovery views; private AG-UI recording inspector/export. Treasury executes here; payout remains approve-only. | Existing `/data/state`, including both agents' settings and this host's owner intents |
| `invoices` (`Dockerfile`) | Invoice agreements precede amount fields; stable focus during refresh; continuation of unchanged, never-submitted invoices; shared payout/backend changes. Payout executes here. | Existing `/data`, including invoice SQLite, agreements and payout settings |

The dashboard image must copy `evidence/` before building the web bundle: its UI imports the
canonical inventory. `test/dashboard-build.test.ts` builds only the Dockerfile’s declared source
inputs offline; it does not validate a Linux image or hosted runtime.

Both services must use the same reviewed source candidate and frozen lockfile. Rebuilding `dao`
alone does not update the public invoice page. Preserve `AGREEMENTS_URL` and matching
`AGREEMENTS_SECRET` configuration so the approve-only dashboard continues reading the executor's
agreements; do not copy its store to the dashboard as a substitute.

Invoice refreshes display only the latest requested read. Superseded responses cannot restore old
invoice controls or clear a newer read failure (`test/browser/invoices.cjs`, offline fixtures).

The subsequent [live run view](../live-run.md) integrates automatic AG-UI snapshot refresh into recent run timelines in the
dashboard, using the existing private recording endpoint. It introduces no stream endpoint or
state migration. The shared FastNear helper now reports read failures explicitly and rejects
malformed JSON; ship that correction to both services with the same reviewed candidate.

The recording adapter now exports envelope version 3 with AG-UI protocol 1.0 lifecycle validation.
The dashboard continues to read archived versions 1/2. Exports are derived from existing records;
this envelope change needs no stored-record conversion and adds no directory. Preserve the run
progress and evidence stores described below. Verify the reader and exporter together from the
same candidate; this compatibility is offline-tested, not a deployed-host observation.

### FastNear access for this candidate

Keep `FASTNEAR_API_KEY` configured server-side on both services. `src/chain.ts` already sends it
as a Bearer header to FastNear RPC, Transactions and Transfers APIs. With a key and no
`NEAR_RPC_URL` override, RPC uses `https://rpc.mainnet.fastnear.com`. Check the effective override
privately: an empty value breaks the default, and a custom host receives the same authorization
header. Use the intended FastNear host; never put the backend key in browser code or copied URLs.

The integration already uses canonical RPC for account, DAO policy and access-key reads;
Transactions for DAO execution discovery (including relayed transactions) and deposit receipts;
and Transfers for public `intents.near` books. This matches FastNear's documented separation of
[RPC and indexed APIs](https://docs.fastnear.com/agents/choosing-surfaces), checked 2026-10-14.
The [authentication guide](https://docs.fastnear.com/auth) documents one key across these APIs.
Key presence alone does not prove deployed access or indexer freshness. During owner-run
verification, distinguish authentication/rate-limit failures from missing records and inspect the
relevant indexed service's `/status` when investigating lag. Indexed public history does not prove
confidential settlement, authorize a retry, or replace provider evidence for an unresolved operation.

No additional FastNear UI or API feature is introduced here. Future read-performance work should
measure existing calls first, then consider batching deposit receipt lookups by transaction hash;
DAO discovery already batches those lookups. Keep missing evidence explicit and validate any
change to recovery or authorization separately.

### Compatibility and state

- Dashboard `pay` and `owner/prepare` policy updates now require `expectedPolicy` (revision and
  mandate digest). Old requests without it fail validation before provider reads. A changed review
  is refused; reload the page and review again rather than replaying the old request.
- Treasury grant preparation requires the saved `expectedStrategyDigest` and the schedule off.
  New `strategy/get`, `strategy/save`, `autopilot/enable` and `autopilot/stop` routes support the
  workflow. Legacy `autopilot/set` can stop unchanged settings without a digest, but refuses
  unreviewed changes/enablement and combined change-and-enable requests. A stale settings form
  may therefore fail even when its button says Turn off: refresh and use the new stop control.
- `owner/actions`, `paymentHistory` and `autopilot/log` are private member reads. Strategy writes
  require settings permission; enabling scheduling requires execution permission. Approve-only instances refuse strategy changes
  and recording export. Owner-action history is local to its instance; payout discovery is bounded
  to 250 provider records from the past day and reports incomplete scans. Missing reads are not
  proof that no payout or owner action exists.
- `POST /api/invoices/:id/continue` uses the authenticated payee's stored terms and identity.
  It refuses revised or submission-attempted invoices; it is not a retry for unknown outcomes.
  The `/internal/agreements` contract is unchanged. Old/new mixed builds are not a validated
  operating configuration; keep activity paused until both services are upgraded.
- No SQLite, journal, owner-intent or strategy schema changes are introduced relative to this
  candidate's base. The invoice SQLite and journal-v2 migrations below already exist in that base
  (and in recorded source `9b2941a`). Do not rerun migration or initialize empty stores merely
  because this release adds recovery views. If the actual deployed source/state is older or
  unknown, establish compatibility and apply the relevant stopped-writer procedure first.
- Strategy controls add a transient single-host control lock beside the existing strategy file;
  strategy saves persist schedule-off before replacement. This is not distributed fencing.
  AG-UI exports read existing evidence/journal files and add no durable recording store.

### Owner-run rollout

1. Confirm no unattended observation or freeze window is in progress. Coordinate a maintenance
   window with all sessions and stop new invoice submissions, approvals and dashboard/CLI money
   actions. Turn schedules off and retain that setting for validation. If a provider-enforced stop
   is required, the owner must freeze the policy; schedule-off alone does not block invoice or
   manual sends, and already-submitted operations may still finish.
2. Record each service's deployment/source identity and retained unresolved/owner-action records
   privately. Stop both services and every other writer before backing up. Preserve the complete
   state listed at the top of this guide, including `.notify/`, legacy `.intake/`, settings, SQLite
   journals and `.sqlite.initialized` markers. Use consistent backups and retain checksums; never
   delete a marker, rewrite legacy uncertainty, or discard an owner intent to clear a blocker.
3. Deploy the reviewed candidate to `invoices` first, reusing its existing `/data` volume and
   configuration, with one replica and no old executor still running. Keep new submissions paused;
   check `/health`. Startup reconciliation may update records, so preserve any new state even if
   the next deployment fails. Before restarting, review retained prepared and submitted owner
   actions: the owner-intent watcher can submit a signature already produced by a passed DAO vote.
   Pausing new approvals and schedules does not make startup status-only, and a policy freeze
   does not block every kind of owner action. Record any automatic progression without deleting
   or replacing the retained action.
4. Deploy the same candidate to `dao`, reusing `/data/state`, one replica, and the existing
   treasury-executor/payout-approve-only mapping. Every other copy of either agent stays
   `EXECUTOR=off`. Do not use restore/bootstrap variables to overwrite existing state. Check
   `/health` before reopening use; do not enable schedules as part of a health check.
5. Reload dashboard and invoice tabs after both services are ready. Discard stale confirmation
   dialogs, not durable prepared/submitted actions. Follow existing owner-action records after
   reload; an attempted owner signature remains poll-only, never resubmitted as a fresh action.

### Verification and recovery

The owner runs the read-only smoke command before and after the rollout:

```sh
DASHBOARD_URL=https://proto.multiagency.ai INVOICES_URL=https://invoices.multiagency.ai pnpm smoke
```

For signed-in checks, use `SMOKE_COOKIE_FILE` and `SMOKE_SNAPSHOT` paths in the private release
record, not tracked files. Compare the same snapshot before and after. Smoke deliberately avoids
`setup`, `held` and invoice-list reads that may update records, and does not prove all new routes
work. A subsequent owner-run screen walkthrough is non-money-moving but can refresh local records:
check agreements/invoice ordering, funding disclosure, retained payment and owner-action states,
strategy readiness, and a retained recording with source gaps. Do not submit invoices, approve
payouts, enable schedules, continue prepared invoices or choose Run now just to verify the UI.
An unavailable read must remain explicit; never replace an unresolved payment to make the check pass.

If health, access, state comparison or contract checks fail, keep activity paused and retain the
new state and logs. Do not restore an older snapshot over post-startup records or downgrade writers
without reviewing state compatibility and reconciling operations. The preferred recovery is a
reviewed forward correction. Record UTC verification times, deployment IDs and source identity;
operation IDs, hashes, amounts and payees stay private. Reopening submissions, unfreezing and
resuming schedules are separate owner decisions. `pnpm test:live` requires separate authorization.

## Dashboard

**Deploy the dashboard on Railway** (service `dao`: `Dockerfile.dashboard`, one replica, a volume at
`/data`). One container runs the public gateway (`src/gateway/server.ts`) and, on loopback beside it,
each agent server listed in `deploy/dashboard.json`. An agent with `"executor": false` runs approve-only.
Each agent names its `owner` (a Sputnik DAO, whose members sign in, or a wallet account, which signs in
itself). Dashboard permissions come from that owner or the DAO's policy; legacy `operators` fields are
ignored and should be removed from configuration. The gateway closes an agent whose own server reports a different owner, so
a wrong `owner` locks the agent rather than opening it.
Ownership verification uses the agent server's `ownerIdentity` read. Deploy matching gateway and
agent-server code together, or update agent servers first; older servers without that read deny
access when the gateway has no cached ownership evidence. This change needs no state migration.
Ship the capability-based gateway with its matching frontend. Old cached frontends have no compatible
role response and must be reloaded; server checks still deny unauthorized calls. A previously configured
DAO operator needs actual group membership and the relevant onchain permissions. Existing schedules
continue under their current signed policy and grant; removing dashboard access does not stop them.
All state lives on the volume in `/data/state`; the app stays in `/app`.

1. Create the service and attach a volume at `/data`. Point it at its Dockerfile with the variable
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.dashboard`. The repository’s `railway.json` selects the payout
   `Dockerfile`; the dashboard uses its own Dockerfile. Set the healthcheck path to `/health`.
2. Set `NEAR_INTENTS_AGENT_API_KEY`, `NEAR_INTENTS_AGENT_API_URL`, `NEARAI_API_KEY`, `FASTNEAR_API_KEY`,
   and `SESSION_SECRET` (random, 32+ characters). `TRUST_PROXY=true` is set in the image.
3. For the first boot only, give each agent its settings file as a base64 variable: `DAO_ENV` and
   `PAYOUT_ENV` for `.env.dao` and `.env.payout`. To move an existing executor's state, also set
   `RESTORE_ARCHIVE` (a base64 gzipped tar of its complete state, listed above) and `RESTORE_SHA256`
   (that tar's SHA-256). `deploy/dashboard-entrypoint.sh` restores only
   when the checksum matches and no state exists, and writes a settings file only if it is missing.
   Delete these four variables once the service has started: they hold grant tokens and owner intents,
   which from then on live only on the volume.
4. Deploy with `railway up --service dao`. To test before DNS is in place, set `DASHBOARD_HOST` to the
   service's Railway domain. Sign-in is bound to that host instead of `host` in `deploy/dashboard.json`.
   Then point a CNAME at the target `railway domain status <domain> --service dao` shows, and remove
   `DASHBOARD_HOST`.

Each agent has exactly one executor, and nothing enforces that across machines: the executor lease
covers one host. Every other copy of an agent, such as the owner's laptop, sets `EXECUTOR=off`. Such a
copy needs no grant token (it shows the executor's grant, read from the API) and refuses to issue grants,
since the new token would be saved on the wrong machine. To move an executor back, stop the `dao`
service, copy the agent's state files out of `/data/state`, and remove `EXECUTOR=off` from the laptop's
settings file before starting it there.

To stop an agent's sends, freeze its policy by owner vote: the provider refuses every send while the
executor keeps reconciling. To stop one host from sending, set `EXECUTOR=off` there.

## Payout executor

The payout executor now serves both the private dashboard and public invoice page. Stop an existing
payout server before starting `ENV_FILE=.env.payout pnpm invoices`: the dashboard listens on loopback
port 8790 and invoices on 8791. Both use the payout agent's existing grant, money lock and recovery
loop. One host is the agent's executor; any other instance of the same agent, such as the owner's
local dashboard while the executor runs on Railway, sets `EXECUTOR=off`: it reads and approves as the
owner but never sends, reconciles or serves invoices. A lifetime lease prevents a second
current-version executor on the same host/user; it is not distributed fencing.
For an existing `pnpm server` or gateway-managed worker, set `INVOICES_PORT=8791` in that worker's
settings instead. A gateway can point at the already-running loopback worker without `envFile`.

**Agreements across hosts.** Agreement requests and offers live with the invoice page, in the payout
executor's `.agreements/`. The hosted dashboard's approve-only payout instance reads and answers them on
that host: set the same random `AGREEMENTS_SECRET` (32+ characters) on the invoices service and in the
dashboard's `.env.payout`, and `AGREEMENTS_URL=https://invoices.multiagency.ai` in `.env.payout`. Without
the secret on the invoices service, its `/internal/agreements` endpoint doesn't exist; without both on
the dashboard, its Agreements list reads its own (empty) store.

## Invoice migration and deployment

**Upgrade and migration:** stop old invoice/payout writers first and back up the complete persistent
state listed above before starting the new executor. Existing JSONL invoice history is imported read-only: recorded outcomes (paid, failed, refused) are shown as
they were, open ones as needing review, and missing business-to-payment links are never guessed. Non-invoice operations continue using their existing `.ops/` JSONL log;
new invoice operations are authoritative in SQLite and projected into the same activity/recovery
views. Each legacy file is moved to `.invoices/legacy/` once imported, so a stale writer can only start a new
file, which is imported in turn; its ids are never filed again. The `.sqlite.initialized` marker
prevents a missing database from silently becoming an empty one; restore the database rather than
removing the marker. Preserve SQLite journals and use a consistent backup. Do not roll back to an
old writer after new SQLite payments without reconciling/exporting the new records.

**Deploy on Railway** (`Dockerfile`, `railway.json`, one replica, one executor host per agent):

1. Move the payout executor and its persistent state together. Any other instance of this agent, such
   as the owner's local dashboard, runs with `EXECUTOR=off`. The database cannot coordinate with an
   independent volume.
2. Attach `/data` with the migrated state. Keep the existing payout agent's `AGENT_ID`,
   `AGENT_GRANT_TOKEN`, `NEAR_INTENTS_AGENT_API_KEY` and `NEAR_INTENTS_AGENT_API_URL` in the environment.
   These variables are its settings: what the service saves itself (a new grant token, the treasury link)
   isn't read back after a restart, so rotate its grant by changing `AGENT_GRANT_TOKEN` here.
3. Set `INVOICES_PUBLIC_HOST`, `INVOICES_SESSION_SECRET` (random, 32+ bytes), and optionally
   `INVOICES_TITLE`. Railway's `PORT` is the public invoice port; `AGENT_PORT` defaults to 8790 for
   private dashboard/RPC access inside the host. The public invoice listener exposes no dashboard RPC.
4. Review imported and unresolved records before submitting new invoices. An outcome without a
   correlation ID requires provider/operator investigation; there is no assumed lookup-by-key API.
