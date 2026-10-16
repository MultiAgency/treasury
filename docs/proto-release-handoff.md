# Treasury → Proto shared-infrastructure release handoff

Prepared 2026-10-15 America/New_York (2026-10-16 UTC during verification).
Current status: **standalone r2 released; both-host sign-in and existing private access verified**.
See [release acceptance](treasury-release-acceptance.md), deployment
`e2c237bf-7d8b-4c4e-9e5d-b43030e14117`, 2026-10-16 UTC. Treasury's fallback blocker is resolved;
Proto/domain release decisions remain separate. The investigation below is the historical
pre-release record; its deployment/verification blockers are superseded by that acceptance report.

The consolidated operator handoff is the [short Treasury r2 release procedure](treasury-release-procedure.md),
which reuses the reviewed source and Railway's existing deployment workflow.

Subsequent release preparation inspected the actual deployed configuration read-only and froze a
minimal standalone backport plus exported review image. Exact hashes, validation and the stopped-writer
procedure are in [the current r2 release package record](treasury-signin-release-r2.md). That frozen
package preserves deployed frontend/runtime bytes outside the bounded fix and supersedes building
the mutable working-tree candidate described below. Nothing has been deployed or restarted.

This is a self-contained handoff for the owner to relay. Work was confined to this Treasury
repository. No deployment, restart, DNS/domain edit, provider owner action, registration, grant,
or money movement was performed. Normal owner-controlled wallet sign-in was attempted.

## Frozen release context

Read `/tmp/proto-infrastructure-review-20261015-r2/review/REVIEW.md` and
`/tmp/proto-infrastructure-review-20261015-r2/review/fallback-handoff.md`.
Those describe the undeployed `proto-shared-review:20261015-r2` image,
`sha256:15a3552618b353a1745f403802c51d76e188107e34f3d17627a8178521f2b055`.
Treasury's independent frontend passed Proto's offline integration per that review; its intended
shared-release host is `treasury.multiagency.ai`, with assets at `/app/frontends/treasury`.
That is review evidence, not a fresh shared-deployment observation. This change does not modify
that frozen artifact, Proto, or Payables, and does not require new Treasury frontend bytes.

The retained standalone installation is a different service and registry. Its fallback is
`https://treasury-production-c98c.up.railway.app/`. It must keep its existing agent and state;
neither registering that owner in Proto nor copying its grant is a fallback-access remedy.

## Hosted observations and remaining unknowns

Read-only observations from the dedicated visible `treasury-proto-fallback-20261015` browser:

| Check | Observation |
| --- | --- |
| Generated-host page | Loaded Agentic Treasury; showed Connect wallet and the public introduction |
| `GET /gw/challenge` | HTTP 200; recipient `treasury.multiagency.ai` |
| `GET /health` | HTTP 200 |
| `GET /gw/me` before sign-in | HTTP 200; viewer absent; self-service Treasury enabled; zero accessible private agents |
| Owner-controlled sign-in | Owner reported “The signed callback URL is not this site” in both the earlier shared browser and dedicated Treasury browser |
| Dedicated tab after that report | Browser snapshot independently showed the same error and Connect wallet |
| Successful private access | **Not established** |

The execution clock read `2026-10-16 00:47:50 UTC` during this inspection; the owner-facing
local date was October 15. These are public/authentication observations, not a funds test.
No cookies, session headers, local-storage credentials or wallet keys were exported. The dedicated
browser remains open. An earlier command against the shared `fallback-review-r2` session returned
Payables' recipient because its active tab was Payables; that result was excluded from Treasury
evidence and a dedicated Treasury session was used thereafter.

The existing expected agent identity, its private retained records and current executor assignment
could not be inspected through the failed sign-in. No live volume, registry, settings or Railway
variables were read or changed. The deployed image/configuration and volume identities have not
been refreshed here. The historical Treasury deployment record in `docs/operations.md` is not
attributed to this new candidate or to these public responses.

## Reproduced cause and candidate remedy

Previously `src/gateway/server.ts` used one `HOST` for every challenge and verification:
`hostOf(DASHBOARD_HOST || config.host)`. Merely serving the generated hostname did not select it
as the signing recipient. `web/src/features/owner/wallet.ts` offers the actual page's origin and
URL as callback candidates. `verifySignIn` rejects any candidate whose host differs from its
signing host before verifying the signature. This also rejects wallets signing without a callback
when the frontend offers generated-host candidates. The owner-reported and browser-observed
error agrees with this source diagnosis.

The new gateway regression failed before the fix: expected recipient `fallback.test`, received
`treasury.test`. A synthetic cryptographic test also reproduces the old callback mismatch.

The candidate adds explicit `signin_hosts` to gateway configuration. The canonical host remains
`treasury.multiagency.ai`; `deploy/treasury.json` additionally lists
`treasury-production-c98c.up.railway.app`. Challenge and session verification select the same
configured host from the request's Host header, ignoring X-Forwarded-Host. Unlisted hosts receive
421 on those two sign-in endpoints. A signing host cannot also be a redirect host.

Both custom-domain and generated-domain signatures therefore bind to their own host. Existing
custom-domain access is preserved by keeping its canonical host, verification rules, permissions,
SESSION_SECRET and host-only Secure/HttpOnly/SameSite=Strict cookie behavior. There is no new
cookie Domain, redirect, cross-origin RPC or CORS relaxation. A signature for one host cannot
authenticate on the other. Browser sessions on the two origins remain separate. Current session
tokens are not reformatted; no state migration is introduced. Unknown-host behavior for other
routes is unchanged. Successful post-change hosted wallet behavior remains unverified.

Changing only DASHBOARD_HOST to the generated hostname would reverse the callback mismatch for
custom-domain access. Do not use that single-host override as a substitute for this remedy.
If an existing DASHBOARD_HOST overrides the canonical host, retain or reconcile it explicitly
after privately inspecting the current configuration; the candidate does not prove its live value.

## Changed files and offline validation

Base HEAD at inspection: `81e64f6f1cbafb67320f94f1fa5ff53412cb531d` (context, not an artifact digest).
The initial working-tree status was clean. No unexpected concurrent changes were observed;
no reset, stash, checkout, commit or edits outside this repository were made.

| File | Change |
| --- | --- |
| `src/gateway/config.ts` | Optional signing-host list, default empty; reject redirect overlap |
| `src/gateway/canonical-host.ts` | Explicit configured signing-host selection |
| `src/gateway/server.ts` | Use selected host for challenge and session verification; refuse unlisted signing hosts |
| `deploy/treasury.json` | Add standalone generated signing hostname; retain custom canonical host and empty preset agent list |
| `test/gateway.test.ts` | Synthetic signatures with/without callbacks on both hosts; replay refusal; config checks |
| `test/gateway-canonical.test.ts` | Real gateway subprocess: fallback recipient, session verification path, host/origin denial, retained redirect behavior |
| `README.md` | Record fallback-access gap under Not done yet |
| `docs/proto-release-handoff.md` | This handoff |

Validation: `pnpm typecheck`, `pnpm test`, and `git diff --check` pass. The full offline suite
contains 737 passing tests. Loopback fixture binding required sandbox escalation; the offline
network guard remained active and live tests were not run. The gateway submission test uses a
synthetic signature and reaches chain-key lookup, which refuses the synthetic key offline and
sets no cookie. Separate injected FullAccess tests establish successful signature verification
for both hosts. Neither test establishes real hosted owner membership or private agent access.

## Future owner release procedure — not executed

1. Review these changes and freeze a separate standalone Treasury image/source candidate. This
   handoff does not authorize deployment. Do not deploy the Proto image to the Treasury service.
   Inspect Railway service overrides, actual DASHBOARD_FILE and DASHBOARD_HOST privately first.
   If the standalone service uses another configuration file, add only the signing-host list to
   that file; preserve its agents and all existing settings. Do not replace it with an empty preset.
2. Agree on a stopped-writer maintenance window, check schedules, unresolved operations and
   attempted owner signatures, and record the current deployment/image, volume, environment,
   registry identities and executor assignments privately. The candidate needs a standalone
   backend deployment/process restart to take effect; editing JSON without restart is insufficient.
3. Preserve the entire existing `/data` volume and `/data/state`. Make a consistent backup with
   gateway, children and CLI writers stopped, and demonstrate an isolated restore. Retain
   `.treasuries/registry.json`, each registered child's `.env.instance` and full working directory,
   all other settings, `.initialized` where present, `.ops/`, `.invoices/` including SQLite and
   applicable WAL/SHM files, `.owner-intents/`, `.strategy/`, `.plans/`, `.evidence/`, `.inbox/`,
   `.agreements/`, `.notify/`, `.work-orders/`, inherited `.intake/`, and every other retained record.
   Never initialize a new registry over this state or reapply stale initial settings over it.
4. Use the SAME standalone service, volume, agent identity, grants, settings and executor
   assignments. Start no second executor or replica and avoid deployment overlap. The lease is
   single-host coordination, not distributed fencing. No import to Proto's `.hosted` registry,
   grant copying, executor migration, or state-format conversion belongs to this change.
5. Before any custom-domain move, verify both hosts' challenge recipients, normal visible wallet
   sign-in and access to the expected existing agent. Compare agent/provider identity, owner,
   executor assignment and retained evidence against the private baseline. Inspect existing
   records only; do not register a workspace or create an agent to make the check pass. Verify
   outsider denial separately. Health and authenticated-but-empty access are insufficient.
6. Relay these observations to Proto's release reviewer. Keep the shared release/domain move
   paused until fallback private access is proven and the frozen review's other blockers are
   resolved. The future shared host and standalone fallback must retain separate authority/state.

## Rollback and blockers

Before a future standalone deployment, capture its prior image and actual config privately.
If the candidate fails, stop its writer before restoring the previous image/configuration on the
same volume, with one replica and the original executor assignment. Keep SESSION_SECRET and
all post-change records. Do not restore a stale journal, erase unresolved records, resubmit an
attempted owner signature or replay a money action. This preparation changes no domain; rollback
requires no DNS edit. The old image will ignore the additive config field and again have the
single-host fallback limitation. If a domain has subsequently moved, that old limitation means
application rollback alone cannot be claimed to restore fallback access; resolve routing under
a separate owner-reviewed release decision before proceeding.

Remaining blockers: deploy/restart of this standalone remedy by the owner; verification of its
actual live configuration and preserved executor/state baseline; successful generated-host wallet
sign-in and private access to the expected existing agent; and fresh custom-host acceptance before
moving its domain. Proto r2's maintenance-window and other acceptance gates remain independent.

Guidance used: repository `AGENTS.md` and `CONTEXT.md`,
`/Users/jlwaugh/.codex/skills/signed-in-browser-checks/SKILL.md`, and
`/Users/jlwaugh/.codex/skills/agent-browser/SKILL.md` plus installed
`agent-browser skills get core`. No other session's response is required to use this handoff.
