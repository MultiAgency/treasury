# Standalone Treasury r2 — released and accepted

Owner-facing date: 2026-10-15 America/New_York. Hosted checks completed
2026-10-16 UTC; final deployment/state observations at 02:44:13Z–02:44:19Z.

**Treasury's fallback sign-in/private-access gate passed.** This is the standalone release, not
the Proto shared-infrastructure deployment. No domain move, agent creation, grant issuance,
provider owner action or money action was performed. Wallet signatures were sign-in messages only.

## Exact release

| Item | Observed value |
| --- | --- |
| Railway project / environment / service | agentic-treasury / production / treasury |
| Deployment | `e2c237bf-7d8b-4c4e-9e5d-b43030e14117`, SUCCESS |
| Railway deployment meta.imageDigest | `sha256:0c3fcddb285cc8d0580b78a4df01c3142642c8c5f1e28e014bd37b3a2f88df52` |
| Reviewed source archive SHA-256 | `a33537adb250a29ca6d25ed4620df5fe5bec535a07e2717bbbfc582f048f4bb0` |
| Original volume | treasury-volume, `db3ab1f9-2122-44f6-84bb-cdca3fc7cafc`, /data |
| Application configuration | /app/deploy/treasury.json; canonical treasury.multiagency.ai; additive signin_hosts includes treasury-production-c98c.up.railway.app |
| Build/start controls | Dockerfile.dashboard; no start override; one replica; zero overlap; ON_FAILURE with ten retries; /health, 120 seconds |

The reviewed archive was verified and freshly extracted, then uploaded through the existing
Railway source workflow with explicit project/environment/service IDs. The submitted deployment
was followed to SUCCESS. All 136 deployed application hashes match r2. Outside the two gateway
files and additive dashboard config, deployed application/frontend bytes retain the prior baseline.
The Railway-built digest above is distinct from the locally built review image's identity.

## Maintenance and recovery evidence

Rollback eligibility and a private baseline were captured before stopping writers: existing
registration, agent identity, settings, executor assignment, retained records and service variables.
The owner confirmed external Treasury writers stopped. Two retained owner intents were settled;
process AUTOPILOT was off and no saved strategy or operation-journal files were found.

The installed Railway volume-file CLI requires an active deployment, conflicting with the original
fully-stopped-deployment download sequence. The owner explicitly approved a bounded maintenance
reader. After the original deployment was verified stopped, a pinned Node base image on the SAME
service/volume served only health/maintenance responses, with no Treasury application or executor.
Its temporary source/start override was restored before r2. No new registry, token, service,
volume, image registry or release package was introduced.

The whole stopped volume was downloaded into restricted local storage and restored into an
isolated local directory without starting an executor. All seven files matched in content, size
and mode; symlinks, registration and agent settings/identity matched. The backup archive, checksum,
receipt, private variables and comparison manifests remain under:
`.test-artifacts/treasury-maintenance-r2-20261015/`.
The volume archive and private records are mode 0600 under a mode-0700 review directory. They contain
private settings and must not be committed, published or copied into Proto.

Both the original deployment and the maintenance-reader deployment were verified stopped before
r2 startup. Final checks observed one gateway and one child executor, with the original executor
assignment and AUTOPILOT control unchanged. All service variables match the private pre-maintenance
baseline; source.image and startCommand are restored to null. The original volume and both domain
attachments are unchanged. After browser acceptance, all seven state files still match the stopped
backup, with no new state files.

Retained rollback target: deployment `07c31669-3ebe-4cc2-ba93-a87009e16c51`, image
`sha256:f3abd3d24779a3c53293ff1341db940bc7e15eda18179d54ddb4f45ed471351e`.
Railway still reported canRollback=true at the final check. If recovery is needed, stop the
replacement/writers first, recheck eligibility, then use the pinned Railway rollback on the SAME
current volume and compare the resulting digest/variables. Preserve every post-release record;
never overwrite a journal with a stale backup or replay an operation/signature. The old image
restores the generated-host callback limitation, so keep the custom domain attached.

## Hosted owner acceptance

| Check | treasury.multiagency.ai | treasury-production-c98c.up.railway.app |
| --- | --- | --- |
| Health | 200 | 200 |
| Challenge recipient | exact custom hostname | exact generated hostname |
| Owner-controlled visible wallet sign-in | verified | verified |
| Expected existing agent and owner | baseline match | baseline match |
| Private instance identity / executor | 200; baseline match | 200; baseline match |
| Retained private owner records | 200; both existing records and stages match | 200; both existing records and stages match |
| Existing scoped private dashboard | opened and inspected | opened and inspected |
| Authenticated empty workspace | **No** | **No** |
| Signed-out scoped private read | 401 | 401 |

The first owner confirmation covered the canonical tab while inspected fallback tabs were still
signed out. That was recorded as signed out, not an authenticated empty workspace. After a second
visible fallback sign-in, both origins were independently verified through their supported private
instance/owner-record endpoints and scoped dashboards. Cookies, auth headers and keys were not exported.
No creation, preview, execute, grant or recovery control was used.

Live signed-out denial was checked without credentials. Outsider membership denial retains the
reused offline gateway-test evidence; no second live account was used for an outsider test. The
hosted checks establish access and preservation, not any new money-path/provider guarantee or
requirement-stage change. The existing requirement inventory remains unchanged.

## Handoff

Treasury's standalone fallback blocker is resolved by this release. Relay this record and the
[r2 source evidence](treasury-signin-release-r2.md) to the Proto reviewer. Proto deployment/domain
moves and its other acceptance gates remain separate decisions; no such action is authorized here.
The existing .treasuries registry, identities, grants, executor assignment and original volume
remain on Treasury; no registration or grant was copied to Proto.

Guidance used: [use-railway](/Users/jlwaugh/.codex/skills/use-railway/SKILL.md),
[signed-in-browser-checks](/Users/jlwaugh/.codex/skills/signed-in-browser-checks/SKILL.md), and
[agent-browser](/Users/jlwaugh/.codex/skills/agent-browser/SKILL.md) plus its installed core guide.
Private evidence/backup files stay outside tracked documentation. Concurrent source edits were preserved.
