# Standalone Treasury sign-in release package

Superseded for release review by [r2](treasury-signin-release-r2.md), which resolves the Dockerfile
selector and retry-count mismatches. R1 remains unchanged as historical evidence.

Prepared 2026-10-15 America/New_York. **Frozen for review; not pushed, deployed or restarted.**
No domain, volume, registry, setting, grant or executor assignment was changed. Real wallet
acceptance and access to the existing agent remain unverified on the candidate.

Read-only follow-up verified the Railway-backed rollback deployment/image and found two source-upload
packaging mismatches (Dockerfile selector and restart retries). See the
[rollback and override addendum](treasury-rollback-review.md) before authorizing release.
The r1 archives remain frozen; their original review's missing-digest statement is corrected there.

## Artifacts

Local directory: `.test-artifacts/treasury-signin-release-20261015-r1/` (ignored by Git).
Relay the archives and detached SHA256SUMS, not the mutable checkout.

| Artifact | SHA-256 |
| --- | --- |
| `treasury-signin-release-20261015-r1.tgz` — frozen source/build context, patch, manifests, logs and complete REVIEW.md | `a78d5b3e87cea0e84ce148e37833c72799ccd2d2245ca6d288f97c8867132004` |
| `treasury-signin-review-image.tar.gz` — exported local linux/amd64 image | `a228114c23494c7503d6ada67891b06ced7c2a7c400e5fa20c9a4b38e3ecfb3d` |

Image tag: `treasury-signin-review:20261015-r1`.
Image ID: `sha256:b27593103ece6a1697d10bdaaf2c9f803c7d1c92dd013dba567a444ed50672ac`.
This is a local image ID, not a pushed registry manifest digest. The source archive has 353
file hashes in `review-manifest.json`; its archive was independently checked against that manifest.

The candidate is a minimal backport onto an allowlisted capture of the actual running standalone
application. Only `src/gateway/config.ts`, `src/gateway/server.ts` and `deploy/treasury.json` differ
from that capture. Frontend assets, dependencies/lockfile, money-path source, entrypoint and evidence
inventory retain their deployed bytes. The new build recipe uses the captured frontend without
rebuilding it and pins the Node base digest. No live volume data or credentials are packaged.

This frozen package intentionally excludes unrelated differences between the deployed application
and this checkout, including canonical-redirect/default-path code, tools, frontend and inventory
changes. The checkout's previous 737-test result supports the design; the separate frozen candidate
has its own validation below. Do not substitute a build of the working checkout for this artifact.

## Actual deployed configuration and prepared change

Read-only Railway SSH and deployment/volume metadata established:

| Item | Observed value |
| --- | --- |
| Project / environment / service | `agentic-treasury` / `production` / `treasury` |
| Project ID | `0c5d641c-592a-47f4-8606-48d07a91d276` |
| Environment ID | `5faa8323-d967-46c3-8f49-4bfe1a68f139` |
| Service ID | `fb5b50db-651e-45b9-9487-55193d7b18b7` |
| Running deployment | `07c31669-3ebe-4cc2-ba93-a87009e16c51`, SUCCESS, created `2026-10-15T15:03:42.385Z` |
| Existing volume | `treasury-volume`, `db3ab1f9-2122-44f6-84bb-cdca3fc7cafc`, `/data`, Ready |
| Effective DASHBOARD_FILE | `/app/deploy/treasury.json` |
| Effective DASHBOARD_HOST | `treasury.multiagency.ai` |
| Self-service / parent EXECUTOR | `true` / unset |
| State / registration registry | `/data/state` and `.treasuries/registry.json` exist |

The actual application JSON contains `host: treasury.multiagency.ai` and `agents: []`.
The captured old config SHA-256 is
`82c7e150673bba063afc498097066bfc39e1a237e5e08090bfc33917619dec15`.
The candidate adds only:

```json
"signin_hosts": ["treasury-production-c98c.up.railway.app"]
```

The resulting file SHA-256 is
`d9da12db71f5be9e892fc4371f509ff65ed811a6c21d803018a7f8591a19c2bb`.
The existing empty static agent list stays unchanged; the existing self-service registrations stay
on the volume and load at startup. No preset replaces the registry. Reconfirm the old config hash
before release: if anyone changes it, stop and prepare a new additive candidate preserving every
field and agent. Keep canonical DASHBOARD_HOST, DASHBOARD_FILE, SESSION_SECRET, self-service,
provider settings and executor assignment unchanged. No environment change is required.

The backend selects a configured signing host for both challenge and signature verification from
Host, never X-Forwarded-Host. Each hostname signs on its own origin. Unlisted signing hosts receive
421; callbacks, signatures, full-access keys, cookies and existing owner permissions retain their
verification. There is no redirect, shared cookie Domain, CORS relaxation or state migration.

## Validation of the exact candidate

- Frozen backend typecheck passed.
- 50 selected offline gateway, signature, permissions, registration and recovery tests passed.
- The same fallback regression fails against captured unmodified deployed source, as expected.
- Pinned-base linux/amd64 image built locally; no push occurred.
- With container networking disabled and no production mount: 136 runtime hashes checked; two
  entrypoint starts; four synthetic sign-ins and four private fixture reads across both hostnames;
  host/origin/replay refusals; 14 retained synthetic file hashes unchanged.

The package includes commands and logs in REVIEW.md. Synthetic keys, RPC and private fixture
records do not establish real owner access or production backup/restore. Live tests were not run.

## Stopped-writer release and preservation

The complete reviewed sequence and rollback are in packaged REVIEW.md. After separate authorization:

1. Reconfirm service/config/volume and artifact hashes; capture the retrievable previous image
   reference/digest, actual build/start overrides, replica/overlap behavior, private agent identity,
   settings, registry, executor assignment, schedules, unresolved operations and attempted owner
   signatures. The initial lookup missed nested meta.imageDigest; the addendum now pins it. These
   private state and provider-override checks remain required before starting release.
2. Agree on a maintenance window; stop intake, gateway, all child executors, CLI/external writers
   and competing instances. Verify exit before starting a replacement. One replica is insufficient
   to prove absence of deployment overlap; the lease is single-host, not distributed fencing.
3. With writers stopped, back up the whole existing /data volume and demonstrate isolated restore.
   Preserve registry and every registered child's settings and full directory, all settings,
   .initialized where present, .ops/, SQLite .invoices/ and applicable WAL/SHM, .owner-intents/,
   .strategy/, .plans/, .evidence/, .inbox/, .agreements/, .notify/, .work-orders/, inherited .intake/
   and all other retained files, including secret settings. Privately hash the stopped baseline.
4. Apply only the approved frozen image/config on the SAME standalone service and volume. Preserve
   identity, agents, grants, settings and executor assignment. No registry initialization, import
   into Proto .hosted, copied grants, executor migration or domain move belongs to this release.
5. Start one replacement only after the old writers are gone. Restart can resume retained schedules;
   if any are active, agree on an explicit maintenance hold/resumption plan before authorizing it.
   Do not silently change saved schedules or executor assignment to make acceptance pass.
6. Verify both-host acceptance below without creating an agent or initiating a money/owner action.

## Acceptance and rollback

On both hostnames, check the exact recipient, complete normal visible owner wallet sign-in and open
the expected existing private agent. Compare provider agent ID, owner, registry identity/port,
settings, retained record identities/evidence and executor assignment against the private baseline.
Inspect an existing retained record/run and confirm one executor and preserved schedule/settings.
Check signed-out/outsider denials. Record deployment/digest/time and private comparisons. Health
or authenticated-but-empty access is insufficient. No cookies or keys should be exported.

If acceptance fails, stop the replacement and all writers first. Restore the previous application
image/config and original environment on the SAME current volume with one executor/replica. Retain
all post-start records, unresolved operations, attempted owner signatures and secret rotations.
Never overwrite current journals with a stale backup or replay an action. Previous application
bytes are packaged for reconstruction, but a rebuild is not its original provider image digest.

Rollback changes no domains and restores the old single-host limitation: custom-domain sign-in
remains its intended path; generated-host access is blocked again. Keep domain moves paused.
No restart/resumption, state restore, deployment or live acceptance is authorized by this document.

See [the original fallback investigation](proto-release-handoff.md) for the owner-reported and
browser-observed callback error and the browser skills used. No concurrent source edits were
overwritten; this turn added release artifacts and this documentation only.
