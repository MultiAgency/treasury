# Treasury r2 release procedure

Execution completed after owner authorization and a separately approved maintenance-reader extension:
[both-host release acceptance](treasury-release-acceptance.md), deployment
`e2c237bf-7d8b-4c4e-9e5d-b43030e14117`, 2026-10-16 UTC. The preparation text below remains the
reviewed procedure and is not authorization for another deployment.

Prepared 2026-10-15 America/New_York using the [use-railway skill](/Users/jlwaugh/.codex/skills/use-railway/SKILL.md).
**Preparation only. No deployment, restart, writer stop, domain move or money action is authorized.**

Use the existing Railway source-upload workflow for `agentic-treasury / production / treasury`.
Use the reviewed r2 source archive in `.test-artifacts/treasury-signin-release-20261015-r2/`,
SHA-256 `a33537adb250a29ca6d25ed4620df5fe5bec535a07e2717bbbfc582f048f4bb0`.
No GHCR, new tokens, image-source switch or another packaging cycle is needed.

1. **Pin recovery.** Refresh Railway rollback eligibility for deployment
   `07c31669-3ebe-4cc2-ba93-a87009e16c51`, image
   `sha256:f3abd3d24779a3c53293ff1341db940bc7e15eda18179d54ddb4f45ed471351e`.
   It last reported canRollback=true; rollback has not been exercised. Reconfirm current configuration,
   staged changes and writers. Privately capture existing agent identity, owner, records, settings,
   executor assignment, schedules, unresolved operations and attempted owner signatures.

2. **Establish a recoverable backup.** In a separately authorized window, agree on schedule
   hold/resumption, stop intake and all gateway/child/CLI/external writers, and verify the old
   deploymentStopped=true with no running predecessor plus independent writer checks. Back up the
   entire original /data volume with writers stopped, record its backup ID/location, and demonstrate
   an isolated restore without starting a duplicate executor. Preserve .treasuries and every child
   directory/settings file, all journals/evidence/intents, SQLite/WAL/SHM, inherited records and
   required private service variables. A source archive or accepted backup request is insufficient.

3. **Preserve the installation.** Retain volume `db3ab1f9-2122-44f6-84bb-cdca3fc7cafc`
   (`treasury-volume`, /data), existing agents/settings/grants and one executor per agent.
   Keep DASHBOARD_FILE=/app/deploy/treasury.json, canonical DASHBOARD_HOST=treasury.multiagency.ai,
   self-service=true and SESSION_SECRET. Add only the reviewed signin_hosts entry for
   treasury-production-c98c.up.railway.app; do not replace registrations with a preset or import
   them into Proto. R2 matches Dockerfile.dashboard, ten ON_FAILURE retries, one replica, zero
   overlap and /health with a 120-second timeout. No build/start/pre-deploy override is needed.
   The lease coordinates one host; it is not distributed fencing.

4. **Upload r2 after authorization and the backup gate.** Verify the archive checksum and manifest,
   then use a fresh extraction, not the mutable checkout. RELEASE_REVIEW below is its extracted
   review root; candidate/ is the build root. The command is for that later window only.
   --no-gitignore prevents the repository's ignored artifact path from omitting reviewed files.

   ```sh
   RAILWAY_CALLER=skill:use-railway@1.7.0 RAILWAY_AGENT_SESSION=treasury-release-r2 \
   railway up "$RELEASE_REVIEW/candidate" --path-as-root --no-gitignore \
     --project 0c5d641c-592a-47f4-8606-48d07a91d276 \
     --environment 5faa8323-d967-46c3-8f49-4bfe1a68f139 \
     --service fb5b50db-651e-45b9-9487-55193d7b18b7 \
     --ci --message "Treasury standalone signing r2"
   ```

   Follow the submitted deployment ID to SUCCESS, record its resulting digest and verify resolved
   controls/configuration/volume. Upload exit status alone is insufficient. Railway builds the
   reviewed source; its digest need not equal the local review image ID. The old writers must be
   stopped before replacement startup. Keep domains unchanged.

5. **Accept or roll back.** On BOTH treasury.multiagency.ai and
   treasury-production-c98c.up.railway.app, check the recipient, complete visible owner wallet
   sign-in and open the expected existing private agent/records. Compare identity, retained records,
   settings/schedules and executor assignment with the baseline; verify signed-out/outsider denial.
   Export no cookies/keys and initiate no owner or money action. Health or an empty workspace is
   insufficient. If acceptance fails, stop the replacement/writers before using the pinned Railway
   rollback target on the SAME current volume; verify its digest and required variables. Retain
   post-start records and secret rotations; never overwrite current journals with stale backups
   or replay an operation. Rollback restores the old fallback limitation: retain the custom domain.

Completed checks are reused: typecheck, 50 offline tests, build/control audit, 136 application hashes,
both-host synthetic sign-in/private reads, retained fixtures across two starts, and archive verification.
[Detailed r2 evidence](treasury-signin-release-r2.md) remains unchanged.

**Remaining gate:** an authorized maintenance window, demonstrated recoverable backup and private
baseline, followed by real both-host/private-record acceptance. No new engineering blocker is
identified; the candidate has not been released or accepted live. Keep domain moves paused.
