# Deploying the app server

The Treasury app server, with the app it serves, runs on Railway: project `treasury`, environment
`production`, one service `server`, built from this repository's `Dockerfile` with the settings in
`.railway/railway.ts`. It talks to the platform at `api.dev.multiagency.ai`, which runs on mainnet: real agents, owners
and funds. When the platform's production host (`api.multiagency.ai`) exists, the same service moves there by changing
`TREASURY_PLATFORM_ORIGIN` and the credential, which is issued per host.

The old prototype (`dao/treasury`) is a different service, `treasury` in the platform's own project; nothing here touches it.

## The service

- **One replica, a volume at `/data`.** The audit trail, stored requests and DAO requests are files there, each with
  one writer, so the service never scales out: its config sets one replica. With `TREASURY_REQUIRED_MOUNT=/data` the
  server refuses to start unless Railway reports the volume mounted there (`RAILWAY_VOLUME_MOUNT_PATH`), so a deploy
  without it never starts on the container's own disk.
- **Health check:** `GET /api/health`. The server answers only after its configuration, credential file and audit
  trail were checked at startup, so a deploy that would fail to start never takes traffic.
- **Secrets as variables, files at startup.** The server reads its credential (and the anchor key, with A7.3) only from
  0600 files. `src/start.ts` writes each from its variable to the file its setting names, then deletes it from the
  environment the server and its child processes see. Rotating one is changing the variable and restarting.

## Variables

| Variable | Value |
| --- | --- |
| `TREASURY_PLATFORM_ORIGIN` | `https://api.dev.multiagency.ai` |
| `TREASURY_DEPLOYMENT` | `multiagency-treasury`: the credential's deployment |
| `TREASURY_CREDENTIAL` | the `tap_…` token (secret) |
| `TREASURY_CREDENTIAL_FILE` | `/data/secrets/app-credential` |
| `TREASURY_PUBLIC_ORIGIN` | `https://<host>`, the service's domain. Sign-in names this host, so it isn't changed once owners have signed in |
| `TREASURY_REQUIRED_MOUNT` | `/data`: the server starts only on the volume mounted there |
| `TREASURY_AUDIT_FILE` | `/data/audit.jsonl` |
| `TREASURY_DAO_REQUESTS_FILE` | `/data/dao-requests.json` |
| `TREASURY_AGENT_TOKENS_FILE` | `/data/agent-tokens.json`: the tokens issued to owners' agents (hashed). Without it they last as long as the process |
| `TREASURY_STRATEGY_PROPOSALS_FILE` | `/data/strategy-proposals.json`: the strategies agents proposed, until the owner answers. Without it they last as long as the process, and a declined one may be proposed again after a restart |
| `TREASURY_TRUSTED_PROXY_HOPS` | `1`: Railway's edge appends the client's address last (checked 2026-11-05, below). With `0` the server sees whichever edge node forwarded the request, which varies, so the per-address challenge limit doesn't hold |
| `FASTNEAR_API_KEY` | FastNEAR's key (secret): sign-in's key lookups and DAO policy reads, at its keyed rate |
| `NEARAI_API_KEY` | NEAR AI Cloud key (secret), required when enabling the hosted assistant with `nearai`; see [the assistant's data and credential boundaries](assistant.md#model-and-data) |
| `TREASURY_ASSISTANT_PROVIDER` | `nearai` when enabling the hosted assistant with NEAR AI Cloud |
| `TREASURY_ASSISTANT_MODEL` | `Qwen/Qwen3.8-27B`, the model verified by the synthetic live smoke check |

`PORT` is Railway's. `TREASURY_PAGE_DIR` is set by the image. `watch` runs only with `TREASURY_WATCH_FILE` and
`TREASURY_REQUESTS_FILE` (on `/data`); `.env.example` lists the rest, each with a default.

Owners can explicitly record an assessment with `POST /api/agents/:agent/risk/assess` while watch remains unconfigured. Supply reviewed Ballast spend, cash-floor, profile and diversification terms; the server validates these against current reads and records the assessment through its canonical audit writer. See [ADR 5](adr/0005-forward-risk.md#explicit-assessment-without-watch-250).

Automatic assessments require a watch entry with `ballast` and `risk`. Enabling watch can create trade proposals and strategy suggestions. With no recorded assessment, what-if returns problems and no numerical result; incomplete genuine price history remains an explicit projection limitation after recording. Neither verification nor a lack of history calls for enabling watch, funding an agent or inserting synthetic production records.

## Service settings

`.railway/railway.ts` declares the service and its volume: build, health check and replicas. The restart policy is
Railway's default (on failure, 10 retries), which it stores as unset, so the file doesn't declare it. Railway keeps a
required mount unset for this service whatever the file says, so the server checks the volume itself
(`TREASURY_REQUIRED_MOUNT`). Railway doesn't read the file during deploys; it stores what the last apply set. After
changing the file:

```sh
railway config plan    # read-only: what would change
railway config apply   # asks before changing anything
```

Variables are listed with `preserve()`, so their values stay in Railway. A variable added in Railway is added to the
file too, or the plan stops. `pnpm typecheck` compiles the file against the `railway` package.

## The credential

The platform's operator issues it on the gateway, from the gateway's state directory, and the token prints once. Run it
in your own terminal, so the token goes nowhere but the variable above:

```sh
railway ssh -p <platform project id> -e <platform staging environment id> -s <gateway service id> -- \
  sh -c 'cd /data/state && /app/node_modules/.bin/tsx /app/src/app-credential.ts issue multiagency-treasury api.dev.multiagency.ai 90 "MultiAgency Treasury"'
```

It lasts 90 days. Before it expires, issue a new one the same way, set the variable, restart, and revoke the old one
(`app-credential.ts revoke <id>`). A token that was ever shown anywhere else is revoked and reissued.

## Deploying

Railway builds from the `Dockerfile`, not from a local folder's guess. Either connect the service to this repository's
`main` on GitHub (each merge deploys; the health check holds a broken one back), or upload a clean export, so nothing
untracked beside a checkout goes with it:

```sh
railway config plan --detailed-exit-code   # exits 2 while .railway/railway.ts has changes not applied: apply them first
rm -rf /tmp/treasury-deploy && git worktree prune && git worktree add --detach /tmp/treasury-deploy <commit>
railway up /tmp/treasury-deploy --path-as-root --service server --environment production
git worktree remove /tmp/treasury-deploy
```

The first deploy: set the variables, `railway config apply`, deploy, then `railway domain` for the service, point a
CNAME for `<host>` at the domain it shows, and set `TREASURY_PUBLIC_ORIGIN` to it.

## Checks after a deploy

Read-only, from outside:

- `GET https://<host>/api/health` answers `{"ok":true,"value":{"status":"up"}}`.
- `GET https://<host>/` is the app, with `cache-control: no-store` and `x-frame-options: DENY`.
- `POST https://<host>/api/session/challenge` without an `Origin` is 403; with `Origin: https://<host>` it issues a
  challenge whose recipient is `<host>`.
- The deploy log starts with `secret_file_written` for the credential, then `listening`, never `Invalid configuration`.
- The proxy hops: eleven challenges in a minute, each with a different made-up `X-Forwarded-For`, are limited like
  eleven with none (429 once the address's 10 a minute are spent), and the log has no `proxy_address_missing`. Spoofed
  addresses getting through would mean too many hops: a client naming its own address gets round the limit. Checked on
  2026-11-05 with `1`: varied, repeated and absent spoofed addresses all drew on one budget, the caller's.

### Audit anchor monitor

`anchor-check.yml` is configured for minute 17 of every hour, UTC. GitHub can
[delay or drop scheduled runs](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times).
Failed-run alerts cover runs that execute. The optional external heartbeat below detects missing successful checks
only after its check, GitHub secret and alert routing are configured and verified. Inspect the recent runs, including
their event, commit and all statuses:

```sh
gh run list --repo MultiAgency/treasury --workflow anchor-check.yml --all --branch main --limit 10 \
  --json databaseId,event,headSha,createdAt,status,conclusion,url
```

For a fresh check, dispatch the workflow on `main`. Its script only reads FastData KV and NEAR; it creates no anchor
and moves no funds:

```sh
gh workflow run anchor-check.yml --repo MultiAgency/treasury --ref main
```

Use the returned run URL, or repeat the list above and identify the new `workflow_dispatch` run by its creation time
and intended `main` commit. Replace `RUN_ID` below with that run's numeric ID. Follow that exact run to completion and
require `status: completed` and `conclusion: success`; check its `headSha` and the "The key's history, confirmed on chain"
step for the checked network, account, key and newest anchor. A dispatch command succeeding alone proves no check result.

```sh
gh run watch RUN_ID --repo MultiAgency/treasury --exit-status
gh run view RUN_ID --repo MultiAgency/treasury --json headSha,event,status,conclusion,url
```

A successful manual check verifies anchor health at that time. Scheduled delivery has recovered only when later runs
with `event: schedule` arrive. Both manual and scheduled successes renew the optional external heartbeat.

Verified on 2026-11-10: at 16:20 UTC, the newest scheduled run had
[passed at 09:53 UTC](https://github.com/MultiAgency/treasury/actions/runs/42794403878), with no newer run visible while
the workflow remained active. A [manual check](https://github.com/MultiAgency/treasury/actions/runs/42854361504) of
`main` at `2b3bc0d` passed at 16:25:46 UTC. This confirmed anchor health without establishing restored hourly delivery.

Rechecked on 2026-11-11: scheduled successes had resumed, including
[15:14 UTC](https://github.com/MultiAgency/treasury/actions/runs/43046398925), but the preceding runs began at 06:26 UTC
that day and 23:24 UTC the previous day. Those seven- and nine-hour gaps still do not establish hourly delivery.

**Activate the external heartbeat:**

Operator activation and verification are tracked in [#251](https://github.com/MultiAgency/treasury/issues/251).
Landing the workflow and these instructions does not establish an active monitor.

First land this workflow and helper on the repository's default branch, `main`. Confirm repository Actions are enabled
and `anchor-check.yml` is active. Review the repository variables `ANCHOR_NETWORK`, `ANCHOR_ACCOUNT`, `ANCHOR_KEY`,
`ANCHOR_INTERVAL_S` and `ANCHOR_SINCE` against the intended deployment; the existing optional `FASTNEAR_API_KEY` secret
belongs only to the anchor-check step. The heartbeat uses no new application or signing credential.

1. In your own Healthchecks.io account, create one check named `Treasury audit anchor check`. Use a Simple schedule
   with **Period 1 hour** and **Grace Time 2 hours**: an alert is due after three hours without a successful ping.
   Keep it unpaused, allow only POST and leave request-body content filtering off. These are
   [Healthchecks' check settings](https://healthchecks.io/docs/configuring_checks/).
2. Route its alerts to the operator's chosen email and verify receipt of Healthchecks' test notification. Store only
   its single-check `https://hc-ping.com/<uuid>` URL as the repository Actions secret `ANCHOR_CHECK_PING_URL`, following
   [Healthchecks' GitHub Actions guidance](https://healthchecks.io/docs/github_actions/). The URL is a bearer credential:
   never put it in chat, a commit, a Railway variable, or a command argument. In your own terminal, the following reads
   it silently and passes it to `gh` on stdin; paste the URL at the hidden input and press Enter:

   ```sh
   read -r -s anchor_check_ping_url
   printf '%s' "$anchor_check_ping_url" | gh secret set ANCHOR_CHECK_PING_URL --repo MultiAgency/treasury
   unset anchor_check_ping_url
   ```

3. Dispatch and verify the exact `main` run as above. After the anchor check succeeds, its last step sends a bodyless
   HTTPS POST with no redirects, at most three attempts of ten seconds each. It accepts only HTTP 200 with the exact
   `OK` body, rejecting the [ping API's](https://healthchecks.io/docs/http_api/) unknown-check and rate-limited replies.
   Even exact `OK` does not prove renewal when content filtering or sticky pausing ignores a ping. A missing secret
   emits an explicit notice and sends nothing. A ping failure fails the workflow without logging the URL or response.
   Confirm a matching success event and an unpaused, healthy check in Healthchecks.
4. Verify a missing-heartbeat alert and recovery in a controlled test before treating alerting as active. After a
   confirmed success, withhold pings for more than three hours **without pausing the Healthchecks check**; verify the
   operator receives the down notification, then resume a successful check and verify recovery. A separate temporary
   check with shorter period and grace can exercise notification routing first. Any successful manual dispatch also
   resets the real check's three-hour window. Restore workflow delivery and confirm later `schedule` runs arrive.

Healthchecks account/check creation, GitHub configuration and notification verification are operator steps; this
repository does not provision them.

The heartbeat needs no Treasury or Platform credential. An alert means no successful check was confirmed within the
three-hour window: inspect workflow delivery, the anchor-check step and heartbeat delivery to locate the failure.
The anchor script's freshness allowance stays a day, two anchor intervals and ten minutes; the heartbeat does not
change that allowance or make GitHub deliver its schedule on time. See the [credential threat model](app-server.md#audit-monitor-credential).

## Rollback

Redeploy the previous deployment (`railway deployment list`, then redeploy it in the dashboard). State stays on the
volume. A newer build may have written records the older one reads as it always did: the audit trail only grows.
