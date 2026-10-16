# Standalone Treasury sign-in release r2

Released and accepted on 2026-10-16 UTC after owner authorization; see
[hosted acceptance](treasury-release-acceptance.md), deployment
`e2c237bf-7d8b-4c4e-9e5d-b43030e14117`. Frozen artifacts below remain unchanged as review evidence.
Their preparation-time "not deployed" statements are historical, not the current release status.

Use the [short release procedure](treasury-release-procedure.md) for the existing Railway source-upload
workflow. This document retains the detailed evidence; r2 artifacts and hashes remain unchanged.

Prepared 2026-10-15 America/New_York. **Validated and frozen for review; not pushed, deployed or
restarted. Writers were not stopped.** No live settings, registry, executor, grants or domains changed.

## Exact artifacts

Local directory: `.test-artifacts/treasury-signin-release-20261015-r2/` (ignored by Git).
Relay these archives and SHA256SUMS, not the mutable checkout. The source archive includes a
self-contained REVIEW.md with reproduction, state preservation, maintenance sequence and rollback.
The source build/upload root is the extracted `candidate/` directory, not its enclosing review directory.

| Artifact | SHA-256 |
| --- | --- |
| `treasury-signin-release-20261015-r2.tgz` — 2,222,540-byte source/review archive | `a33537adb250a29ca6d25ed4620df5fe5bec535a07e2717bbbfc582f048f4bb0` |
| `treasury-signin-review-image.tar.gz` — 228,537,342-byte exported image | `193a8b5ed8ada294b21e851269b2a7b9b09cb30540468d5ffdc07dc2b263f042` |

Image: `treasury-signin-review:20261015-r2`, linux/amd64.
Image ID: `sha256:252d570f88b2a9bfb9dba73178acfd9fed57b3966c35f736b4b7a629a3e4387b`.
The local image ID is distinct from a future registry manifest digest. No image was pushed.
The archive's 363 file hashes and exported image identity were independently verified.
R1 artifacts retain their original hashes.

## Packaging fix and unchanged application

R2 adds `Dockerfile.dashboard` with identical recipe bytes to the reviewed root Dockerfile and
selects it in railway.json, matching the service's existing RAILWAY_DOCKERFILE_PATH. It preserves
ON_FAILURE with **10 retries**, explicitly retains one replica, zero overlap and /health with a
120-second timeout, and adds no start, pre-deploy, root-directory or environment override.

All 136 application file hashes equal r1. R2's image runtime Config and RootFS layers also equal
r1, although the image IDs differ. Fresh read-only SSH confirmed the deployed baseline has not
drifted. Outside the signing fix, application/frontend assets, dependencies, money-path source,
entrypoint and evidence inventory remain the deployed bytes. Only gateway config.ts, server.ts
and the application dashboard JSON differ from that baseline. No production state is packaged.

The actual deployed config path remains `/app/deploy/treasury.json`; canonical host and existing
DASHBOARD_HOST remain `treasury.multiagency.ai`. The prepared application JSON additively includes
`signin_hosts: ["treasury-production-c98c.up.railway.app"]`. Its existing empty static agents list
stays unchanged; registrations continue loading from the original volume's .treasuries registry.
No empty preset replaces registrations or settings. Old config SHA-256:
`82c7e150673bba063afc498097066bfc39e1a237e5e08090bfc33917619dec15`;
candidate config SHA-256:
`d9da12db71f5be9e892fc4371f509ff65ed811a6c21d803018a7f8591a19c2bb`.

## Build/start controls checked

Fresh read-only API observation: `2026-10-16T01:20:54.860233Z` (October 15 EDT).

| Control | Observed and preserved |
| --- | --- |
| Dockerfile selector | service variable Dockerfile.dashboard; matching r2 file and config selector |
| Builder | UI default RAILPACK; existing deployed manifest DOCKERFILE; r2 explicitly DOCKERFILE, with identical recipes at both detected/selected paths |
| Build command / root / config-file override | null / null / null |
| Start / pre-deploy command and timeout | all null; retain image docker-entrypoint.sh and CMD /app/deploy/dashboard-entrypoint.sh |
| Replicas / overlap / draining | 1 / 0 / no explicit draining interval |
| Healthcheck / timeout / restart | /health / 120 seconds / ON_FAILURE, 10 retries |
| Railway cron / sleep / source repo or image | null / false / null |
| Port / APP_DIR / DATA_DIR / ENV_FILE / NODE_OPTIONS | 8080 / unset / unset / unset / unset |

No separate build/start, Railpack/Nixpacks, PNPM/Corepack, UID, overlap/draining/healthcheck-timeout
variable overrides were found. Restore and initial-settings bootstrap variables are absent.
Canonical DASHBOARD_HOST, DASHBOARD_FILE, self-service, SESSION_SECRET and executor settings remain
untouched. Only SESSION_SECRET presence was recorded, never its value. The source package records
the full checked allowlist and image configuration.

A separate read-only query with secret decryption disabled returned an empty staged patch at
`2026-10-16T01:23:27.491633Z`; no staged changes were committed. Current build/start conflicts
identified for r1 are resolved in r2. A future provider-resolved deployment manifest has not been
observed and must still be compared before startup. No setting was changed to make these checks pass.

## Validation and rollback pin

- Frozen backend typecheck and all 50 selected offline tests passed.
- Packaging/control validator passed and rejects superseded r1 as its negative control.
- The selected Dockerfile.dashboard built the local pinned-base image successfully.
- Image check with networking disabled and no production mount passed: 136 application hashes,
  two starts, four synthetic sign-ins and four private fixture reads across both hostnames,
  host/origin/replay refusals, and 14 retained fixture hashes unchanged.
- Both final archive hashes, source manifest contents and exported image identity passed verification.

These synthetic checks do not establish real owner access, existing private-agent identity or
production backup/restore. No live-funds tests or new frontend build were run.

Retained Railway rollback target: deployment `07c31669-3ebe-4cc2-ba93-a87009e16c51`, image digest
`sha256:f3abd3d24779a3c53293ff1341db940bc7e15eda18179d54ddb4f45ed471351e`.
Fresh API canRollback=true. This is provider-backed rollback eligibility, not a verified portable
Docker pull URL or an executed rollback. Recheck eligibility/digest at release time.
The current control-plane snapshot still has one active deployment and one running instance.

## Remaining maintenance and acceptance gates

1. Agree on an authorized downtime/stopped-writer window. Recheck rollback eligibility, controls,
   staged changes and actual config hash. Privately capture existing agent/provider identity,
   owner, registry, settings, grants/executor assignment, schedules, active runs, unresolved
   operations and attempted owner signatures. Decide schedule hold/resumption explicitly.
2. Only after separate authorization, stop intake, gateway, children, CLI/external and competing
   writers; require old deploymentStopped=true and no running predecessor, plus independent writer
   checks. Replica count and zero overlap alone do not prove quiescence. The lease is single-host.
3. Back up the whole same volume with writers stopped and demonstrate isolated restore. Preserve
   registry/child directories and settings, .initialized, all journals, SQLite/WAL/SHM, owner intents,
   strategy/plans, evidence/inbox, agreements/notifications and every inherited/secret file. The
   full list and stopped-state hashing procedure are in packaged REVIEW.md.
4. Apply only the separately approved frozen candidate to the same Treasury service/volume with
   unchanged identity/settings/executor assignment. No Proto registration import, grant copying,
   executor migration, state conversion or domain move. Start one replacement after the stop gate;
   compare its resolved build/start/restart controls before accepting it.
5. Verify normal visible wallet sign-in on BOTH hostnames and private access to the expected existing
   agent. Compare identity, retained records, final executor assignment and settings/schedules with
   the private baseline; check signed-out/outsider denial. Do not create an agent or money/owner action
   for acceptance. Health or authenticated-but-empty access is insufficient.

If acceptance fails, stop the replacement and its writers before using the pinned Railway rollback
target on the SAME current volume. Compare the restored image digest and required variables;
preserve all post-start records, unresolved operations, attempted signatures and secret rotations.
Never overwrite current journals with a stale backup or replay an operation. Rollback restores
the old generated-host limitation, so keep the custom domain attached and all domain moves paused.
Full rollback and retention-expiry handling are in the packaged review.

This turn prepared local artifacts and documentation only. Concurrent working-tree edits were
preserved. [Original investigation](proto-release-handoff.md),
[read-only rollback/control findings](treasury-rollback-review.md), and
[superseded r1 package record](treasury-signin-release.md) retain their historical evidence.
