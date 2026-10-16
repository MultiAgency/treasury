# Treasury rollback and deployment-control review

Read-only review on 2026-10-15 America/New_York. Final control-plane observation:
`2026-10-16T01:14:03.515499Z` (October 15, 9:14 p.m. EDT).
No writers were stopped; no deployment, restart, variable, domain, volume or service setting changed.
The frozen r1 archives and image remain unchanged.

Subsequent [r2 preparation](treasury-signin-release-r2.md) resolved the packaging mismatches below
in new validated artifacts and refreshed the rollback/control observations. This addendum retains
the original read-only findings; it does not authorize a live release.

## Verified Railway-backed rollback reference

| Item | Verified value |
| --- | --- |
| Project | `agentic-treasury`, `0c5d641c-592a-47f4-8606-48d07a91d276` |
| Environment | `production`, `5faa8323-d967-46c3-8f49-4bfe1a68f139` |
| Service | `treasury`, `fb5b50db-651e-45b9-9487-55193d7b18b7` |
| Rollback deployment | `07c31669-3ebe-4cc2-ba93-a87009e16c51` |
| Retained image digest | `sha256:f3abd3d24779a3c53293ff1341db940bc7e15eda18179d54ddb4f45ed471351e` |
| Current deployment status | `SUCCESS` |
| API `canRollback` / `canRedeploy` | `true` / `true` |
| Current `deploymentStopped` | `false`, as expected: no stop was requested |
| Running instance | `618398de-96ef-4b19-9097-07f9da417ca5`, `RUNNING` |

The image digest was available under deployment **meta.imageDigest**. The initial release-package
lookup examined top-level fields and missed it. This addendum corrects the package's statement
that the queried metadata did not supply a digest, without changing its frozen bytes or hashes.

The retrievable reference is the Railway-managed deployment plus the digest above. A fresh API
query reports rollback eligibility for that exact deployment; the provider currently exposes it
as a rollback target. Retrieval is verified at the control-plane eligibility level. No rollback,
restart, image export or Docker pull of the managed image was performed. The queried API and build
logs did not provide a Docker registry/repository URL, and service source.image is null; this is
**not** a verified portable `registry/repository@sha256:…` pull reference. The previously exported
r1 review image is the new candidate, not this rollback image.

Railway documents rollback as reuse of a retained deployment image and restoration of custom
variables, without a rebuild. Eligibility is retention-dependent, so re-query `canRollback` and
the digest immediately before release and before rollback. Do not substitute `redeploy` as proof
of exact-image reuse. [Railway rollback guide](https://docs.railway.com/guides/roll-back-bad-deploy)

After separate authorization, the intended provider route is Treasury → Deployments → the exact
deployment ID above → Rollback, after the replacement and all its writers have stopped. Verify
the resulting deployment's meta.imageDigest equals the pinned digest. Do not execute this now.
If eligibility expires, stop release and prepare a reviewed recovery; the captured old source is
a reconstruction aid, not evidence of the original image digest. If an independently pullable
rollback artifact is required, that remains unverified and must be resolved separately.

## Current overrides versus recorded deployment

The service-instance API and selected non-secret variables were read separately from the running
deployment's merged manifest. A service default is not proof of the builder used for a deployment.

| Control | Current service/variable | Recorded running deployment |
| --- | --- | --- |
| Builder | service default `RAILPACK` | `DOCKERFILE` |
| Dockerfile path | UI field null; `RAILWAY_DOCKERFILE_PATH=Dockerfile.dashboard` | `Dockerfile.dashboard`; build logs confirm that filename |
| Root / build command | null / null | null / null |
| Start command | null | null; application uses image CMD |
| Pre-deploy command / timeout | null / null | null / null |
| Replica count | 1 | 1; recorded region map `us-west2: 1` |
| Overlap seconds | 0 | 0 |
| Draining seconds | null, no variable override | null; no explicit grace interval established |
| Healthcheck | `/health`, 120-second timeout | same |
| Restart policy | `ON_FAILURE`, 10 retries | same |
| Railway cron / sleep | null / false | same |
| Source repo / image | null / null | CLI-uploaded deployment metadata |
| Railway config-file override | null | resolved configFile null, fileManifest `{}` |

The resolved-file metadata also contains property mappings for builder, Dockerfile, healthcheck,
replicas and restart policy. Preserve this ambiguity in the record: its empty fileManifest and
null configFile do not establish that a future upload will use the intended recipe. The current
running manifest and build logs establish what the existing deployment actually used.

Selected variable checks: DASHBOARD_FILE remains `/app/deploy/treasury.json`, DASHBOARD_HOST remains
`treasury.multiagency.ai`, self-service is true, parent EXECUTOR unset, service AUTOPILOT `off`,
and SESSION_SECRET is configured (value not printed or saved). There are no explicit overlap,
draining, healthcheck-timeout, APP_DIR, DATA_DIR or restore-archive overrides in the selected service
variables. Parent AUTOPILOT does not establish each registered child's saved schedule or current
run state. No private state baseline was collected in this review.

Two r1 source-package mismatches require resolution before a source upload:

1. Its build recipe is `candidate/Dockerfile` and railway.json points to `Dockerfile`; the existing
   service variable selects `Dockerfile.dashboard`, which is absent from that context. Do not
   assume conflicting path selectors resolve safely. A bounded r2 packaging remedy can supply
   the identical reviewed recipe as Dockerfile.dashboard and align the config path, preserving
   the existing service variable. Any changed source archive needs its own hash/review; do not
   alter r1 in place. The already-built local image's application bytes are unaffected.
2. r1's railway.json specifies 5 restart retries; the deployed/current setting is 10. A new source
   package should explicitly preserve 10. Config-in-code can override dashboard settings, so the
   current UI value alone does not guarantee it survives a future upload.

These are packaging/deployment-control findings, not new sign-in or money-path behavior. No
service variable was removed, and no package or application image was rebuilt in this review.
[Dockerfile path documentation](https://docs.railway.com/builds/dockerfiles),
[configuration precedence](https://docs.railway.com/config-as-code).

## No-overlap controls and their limits

The API currently reports **one active deployment with one running instance**, overlapSeconds 0,
and the original volume attached at `/data`. Volume metadata from this review's status snapshot
matches `treasury-volume`, `db3ab1f9-2122-44f6-84bb-cdca3fc7cafc`.
Railway's documentation says volume-backed services cannot run two deployments simultaneously.
This is a provider-documented control, not an observed replacement-deployment exercise.
[Railway volume-backed deployment caveat](https://docs.railway.com/guides/roll-back-bad-deploy)

Zero overlap seconds governs deployment transition timing; it does not independently prove every
gateway child, CLI writer or external instance has stopped. The application registry lease and
money lock coordinate one host, not distributed fencing. Healthcheck success proves neither a
stopped predecessor nor correct executor assignment.

The maintenance gate remains explicit: after an authorized stop, query the OLD deployment and
require `deploymentStopped=true`, no RUNNING instances and no active predecessor; independently
confirm all application children, CLI/external writers and competing agent instances are stopped
before backing up or starting the replacement. The live API schema describes deploymentStopped
as checking whether all deployment instances have stopped. That gate has not been exercised here.
Do not rely on status REMOVED alone, a gateway log line, or replica count to satisfy it.

## Remaining maintenance-window prerequisites

- Resolve the two source-package mismatches in a newly frozen/reviewed package, or explicitly
  review a pinned prebuilt-image deployment route. Confirm the future resolved build/start and
  restart settings; retain canonical signing host and additive signin_hosts configuration.
- Refresh rollback eligibility/digest, current config hash, service/volume mapping and controls
  at the window. Securely compare rollback-restored service variables with current required
  settings and any secret rotations; do not assume environment/shared variables are historical.
- Agree on the downtime/stop window and inventory all writers. Privately capture existing agent
  identity, owner, registry names/ports, settings, executor assignment, saved schedules, active
  runs, unresolved operations and attempted owner signatures. Decide any schedule maintenance
  hold/resumption explicitly. No run should be created merely for acceptance.
- Once separately authorized, stop and verify writers, create a consistent whole-volume backup,
  demonstrate isolated restore and record private stopped-state hashes. Preserve the registry,
  every child directory/settings file, SQLite and WAL/SHM, journals, intents, strategy/plans,
  evidence/inbox, agreements/notifications and all inherited state, as the release runbook lists.
- Start one replacement on the same volume only after the stop gate. Confirm the same agent,
  retained records, final executor assignment and schedule/settings. Then verify visible wallet
  sign-in on BOTH hostnames, expected private agent access, signed-out and outsider denial.
  Keep domain moves paused until those checks and Proto's other acceptance gates pass.

Read-only evidence is in `.test-artifacts/treasury-rollback-review-20261015/`, including the exact
query, timestamped sanitized control snapshot, selected variables and image-related build-log
lines. Raw project/deployment metadata stays private and is not included in a relay artifact.
Only documentation and local review records changed. No application-source validation was
rerun because the frozen code/image were unchanged; `git diff --check` checks this addendum.
