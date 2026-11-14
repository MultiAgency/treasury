# Persistent synthetic staging

The replacement provider and gateway are deployed alongside the retained backend. Treasury's canonical synthetic staging app now points to the replacement gateway. Hosted acceptance under the owner's wallet is complete. The separately reviewed production rollout and accounting receipt import also completed on November 13, 2026; production uses the real provider, not this harness.

| Component | Staging service ID | Serving deployment observed (November 14, 2026) |
| --- | --- | --- |
| Provider | `4766bb85-e9b3-4cab-900e-2286585a717d` | `0c0b1f27-6434-443c-8cb3-c8f5a1675bf5` |
| Gateway | `c53df1f5-2cf7-4757-b553-43893077ec55` | `d90a6b33-93ea-4532-a72a-3fc6d0d688d9` |
| Treasury app | `d6734b71-4e83-4e74-8995-2ca7570c454a` | `00b7f33d-e291-4915-81da-73f6cd732852` |

All three are in synthetic staging environment `343dceb7-e189-409d-bf96-9cc0be45d10b`, project `7113126f-e45d-4ce1-ab6c-8604ade66134`. Reverify serving releases before operational changes. Provider and gateway have separate new volumes. The old synthetic backend remains running with its old volume.

The provider stores agents, funding receipts, signed intents, grants, balances and operation receipts in SQLite WAL with FULL synchronization. A swap's balance changes and receipt commit in one transaction. Replay binds the original terms and signed floor. Owner intent effects and consumption commit together. The hosted provider credits each agent 10 synthetic USDC as it is created, recorded as a deposit. Further funding requires a separate staging token and an idempotent identity.

The service has no transaction RPC, provider signing key or mainnet submission client. Wallet-key and DAO-policy ownership checks use restricted final reads against a pinned FastNEAR RPC. The gateway's network guard routes transaction-history requests to explicitly synthetic evidence; other external fetches are blocked. Managed workers inherit the guard using their standard provider URL, which is tested separately.

Synthetic asset prices are fixed: USDC $1, wNEAR $2 and ETH $3,000. Budget windows roll over 24 hours, seven days and 30 days; asset-window caps and hourly action counts are enforced transactionally. These are synthetic test semantics, not observed live-provider behavior. Timelocked execution and general policy editing remain unsupported and refuse requests.

## Verification

Use Node 24.22 or later. The focused default suite skips gateway integration unless its explicit isolated-platform inputs are provided:

```sh
node --test staging/*.test.*
```

CI runs the separate **Persistent staging harness (full journey)** job on Node 24.22.0. It checks out platform `730e910`, installs frozen dependencies, builds both apps, installs Chromium, typechecks the harness and runs `pnpm test:staging`. The acceptance runner requires every integration input, forces the browser/Books/SDK paths on, and rejects skipped tests. This is separate from the existing workspace and simulated-stack checks.

Locally, after installing dependencies and building both apps, run `STAGING_PLATFORM_SOURCE=/absolute/path/to/isolated/platform pnpm test:staging`. The runner derives the loader and SDK paths from that checkout. For direct focused invocation, full acceptance uses `STAGING_PLATFORM_SOURCE` pointing to an isolated copy of reviewed platform `730e910`, with its dependencies and built web assets; `STAGING_TSX_LOADER` naming its loader; `STAGING_PROVIDER_SDK` naming its installed provider SDK; and `STAGING_BROWSER=true`. Run Node with that same loader and `--test staging/*.test.*`. Do not point these tests at hosted or production state.

All 14 local tests passed together with every optional integration enabled (zero skips), including the three rolling asset-cap boundary cases. The harness TypeScript check also passed. They exercise actual merged-platform Books reconciliation (zero public drift and confidential residual), the actual gateway's setup, creation, consent, grant, proposal approval and execution, and the actual Treasury UI's approval and execution. The browser test loses the execution response, restarts the provider and reloads the UI: the outcome is executed and the operation settles once. It also checks 390px horizontal overflow. A separate child-process SIGKILL case verifies settlement durability. Local test wallets are injected through dependency interfaces; deployed entry points do not accept fixture key lists.

Hosted verification found and corrected a managed-worker preload dependency: staging-only environment variables are not inherited by hosted workers. The packaged guard now also accepts their standard synthetic provider URL. The owner's reservation survived that gateway redeployment and its identity read returned HTTP 200. The signed-in owner subsequently completed setup, creation, connection, strategy authorization, proposal approval and execution through the hosted Treasury UI. Both synthetic swaps succeeded and Books showed zero residual for all three assets. The hosted provider preserved identical state across restart after funding. Interrupted execution-response recovery and post-settlement process termination were exercised locally, rather than injected into the hosted owner session. The hosted execution page also passed the 390px overflow check.

## Build contexts

`Dockerfile.provider` uses the Treasury repository root as its build context, but the provider service builds whatever is named `Dockerfile` at the root of what is uploaded, and the repository's root `Dockerfile` is the Treasury app server's. Uploading the repository as it is would build the app server into the provider service. Export the exact commit, put the provider's file at its root, and upload that:

```sh
git archive <commit> | tar -x -C /tmp/provider-release-<commit>
cp /tmp/provider-release-<commit>/staging/Dockerfile.provider /tmp/provider-release-<commit>/Dockerfile
railway up /tmp/provider-release-<commit> --path-as-root \
  --project 7113126f-e45d-4ce1-ab6c-8604ade66134 \
  --environment 343dceb7-e189-409d-bf96-9cc0be45d10b \
  --service 4766bb85-e9b3-4cab-900e-2286585a717d \
  --detach --json -m "Synthetic provider from main <commit>"
```

Follow the returned deployment ID to `SUCCESS`, then confirm three things: its build log ends in `COPY staging staging` (the provider's ten steps, not the app server's), its runtime log says `ready=true synthetic=true`, and `GET /healthz` answers 200. The service has no health check configured, so a build that fails to start is not held back. Its state is on the volume and survives the restart: a deployment on November 14, 2026 left every stored record and operation identical, compared by hash before and after.

`Dockerfile.gateway` uses an exported reviewed platform release containing its built `web/dist` and immutable `manifest.json`, with this directory copied into that export as `staging/`. It cannot build from the Treasury root. Keep the original platform manifest unchanged and record the staging overlay hashes separately.

Each service requires `STAGING_SYNTHETIC=true`, its own empty persistent volume (`STAGING_DATA_DIR`, default `/data`) and HTTPS `STAGING_PUBLIC_ORIGIN`. The provider requires a distinct `STAGING_CONTROL_TOKEN` of at least 32 characters; the gateway requires a distinct `STAGING_SESSION_SECRET` of at least 32 characters and `STAGING_PROVIDER_ORIGIN`. Supply secrets through the hosting environment, never a build context. The gateway passes only an explicit environment allowlist to its child process.

## Retained evidence and completed rollout

Do not restart, replay, clear or reconstruct the old in-memory provider. Before cutover, its exact prior balances, frozen state, autopilot off and one unresolved missing-ID case were re-read. Treasury's watcher hash remained `4e7d2773e89b75eaf683b4604e5c510a08e8f8c423e18d1420fab0f483b06501`; its audit chain remained valid at sequence 111 after cutover.

The new entry points refuse initialization on an old backend volume. Runtime secrets and rollback connection settings are retained privately outside the repository. After hosted acceptance, a fresh production preflight passed. The selected executor was stopped, state was backed up, reviewed platform `730e910` was deployed and its 258 runtime files verified against the immutable manifest. Treasury combined release `2080da0` includes reconciliation `244cdb4`, the wallet/session corrections and the emergency stop moved below the main journey. Its typechecks, build and 1,298 unit tests passed. Live platform deployment: `e69baa0a-7da9-42ba-b664-c8489b9ea6d4`; live Treasury deployment: `ae0313cb-73ce-4fd2-9443-4674f147bc21`.

The retained receipt was imported through the normal money lock as an operator-attested accounting credit. An identical replay created no additional credit. Fresh Books matched, the reconciliation gap cleared, provider balances and execution-journal hashes were unchanged, and the executor’s previous mode was restored with autopilot still off. The watcher now waits for its DCA zone to re-arm; this is a separate pacing hold. Receipt contents and live account details remain in private release records. This receipt path is operator attestation, not independent provider settlement verification. The old synthetic backend was rechecked afterward: balances, freeze, disabled autopilot and unresolved recovery evidence remained intact.
