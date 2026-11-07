# Deploying the app server

The Treasury app server, with the proposals page it serves, runs on Railway: project `treasury`, environment
`production`, one service `server`, built from this repository's `Dockerfile` with the settings in
`.railway/railway.ts`. It talks to the platform at `api.dev.multiagency.ai`, which runs on mainnet: real agents, owners
and funds. When the platform's production host (`api.multiagency.ai`) exists, the same service moves there by changing
`TREASURY_PLATFORM_ORIGIN` and the credential, which is issued per host.

The old prototype (`dao/treasury`) is a different service, `treasury` in the platform's own project; nothing here touches it.

## The service

- **One replica, a volume at `/data`.** The audit trail, stored requests and DAO requests are files there, each with
  one writer, so the service never scales out. `railway.json` sets one replica and refuses to deploy without the volume.
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
| `TREASURY_AUDIT_FILE` | `/data/audit.jsonl` |
| `TREASURY_DAO_REQUESTS_FILE` | `/data/dao-requests.json` |
| `TREASURY_TRUSTED_PROXY_HOPS` | `1`: Railway's edge appends the client's address last (checked 2026-11-05, below). With `0` the server sees whichever edge node forwarded the request, which varies, so the per-address challenge limit doesn't hold |
| `FASTNEAR_API_KEY` | FastNEAR's key (secret): sign-in's key lookups and DAO policy reads, at its keyed rate |

`PORT` is Railway's. `TREASURY_PAGE_DIR` is set by the image. `watch` runs only with `TREASURY_WATCH_FILE` and
`TREASURY_REQUESTS_FILE` (on `/data`); `.env.example` lists the rest, each with a default.

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
- `GET https://<host>/` is the proposals page, with `cache-control: no-store` and `x-frame-options: DENY`.
- `POST https://<host>/api/session/challenge` without an `Origin` is 403; with `Origin: https://<host>` it issues a
  challenge whose recipient is `<host>`.
- The deploy log starts with `secret_file_written` for the credential, then `listening`, never `Invalid configuration`.
- The proxy hops: eleven challenges in a minute, each with a different made-up `X-Forwarded-For`, are limited like
  eleven with none (429 once the address's 10 a minute are spent), and the log has no `proxy_address_missing`. Spoofed
  addresses getting through would mean too many hops: a client naming its own address gets round the limit. Checked on
  2026-11-05 with `1`: varied, repeated and absent spoofed addresses all drew on one budget, the caller's.

## Rollback

Redeploy the previous deployment (`railway deployment list`, then redeploy it in the dashboard). State stays on the
volume. A newer build may have written records the older one reads as it always did: the audit trail only grows.
