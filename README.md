# treasury

The Treasury app for [MultiAgency](https://github.com/MultiAgency/platform): an agent runs an Organization's treasury, and its owner decides what it may do. The owner approves each proposal, or delegates to autopilot under a grant and the signed policy, and can freeze the agent. It's built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.5.3, against the platform's app route (`/apps/v1`).

Freeze is the stop that halts every send. A wallet owner can freeze the agent from the owner-session UI, which runs only on the simulated stack, and from the app's pages (#133). A DAO-owned agent has no such stop through the app yet: its freeze vote must pass within the provider intent's 600 seconds, which most DAOs can't do (MultiAgency/platform#20). Until then, `autopilot/stop` ends its schedule and the strategy engine proposes nothing at L4, but other apps' access and approved proposals are untouched.

| Path | What |
| --- | --- |
| `apps/server/` | The app's own server. It holds the deployment's `tap_` credential, calls `/apps/v1` with `appClient`, serves the app's pages, and runs `watch`, the proposer. See [docs/app-server.md](docs/app-server.md); for deploying, [docs/deploy.md](docs/deploy.md). |
| `web/src/proposals/` | The app's pages, served by the app server: sign-in, setup, the connection, proposals, strategy and autopilot, funding. These are becoming the one Treasury app (#128). See [docs/web.md](docs/web.md). |
| `web/src/app/`, `web/src/features/` | The owner-session UI, the simulated-stack reference until it's retired ([ADR 2](docs/adr/0002-owner-ui-app-access.md), #138). |
| `packages/core/` | The strategy engine: pure decision logic, run by `watch` for the agents configured with it ([ADR 3](docs/adr/0003-engine-parameters.md), [HISTORY.md](packages/core/HISTORY.md)). |
| `scripts/stack.ts` | Starts the platform's simulated stack for the stack tests, and drives it through its state and control files only. |
| `docs/` | Decisions (`adr/`), the app server and web builds, deploying, and the SDK report. |

## Running it locally

Everything runs against the platform's simulated stack at [`49b8d51`](https://github.com/MultiAgency/platform/commit/49b8d51), the commit SDK 0.5.3 was published from (tag `sdk-v0.5.3`). Its provider, chain, signatures and settlement are simulated. It needs Node ≥ 24.22, pnpm 12.16, and the platform checked out beside this repository:

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 49b8d51
(cd ../platform && pnpm install --frozen-lockfile && pnpm exec rsbuild build --root web)  # the confirm page the stack serves
pnpm install
```

Started with `--app <deployment>`, the stack issues the app's `tap_` credential into a 0600 file named in its `state.json`. To run the server itself, see [docs/app-server.md](docs/app-server.md#running-it).

## Tests

```sh
pnpm check                                   # every package's typecheck and unit tests
pnpm build                                   # both web builds
pnpm --filter @treasury/server test:stack    # the app server on fresh stacks, one with a DAO-owned agent
pnpm --filter @treasury/web test:stack       # the owner UI, and the app's pages through the app server
pnpm --filter @treasury/server test:sandbox  # the on-chain key check on near-kit's local node; not in CI
```

The stack tests need `../platform` (or `TREASURY_PLATFORM`) at `49b8d51` with its dependencies installed. CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm build` on Node 24 and 26 for every pull request and push to `main`, then both stack tests. `anchor-check.yml` checks the audit log's anchors on chain every hour.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).
