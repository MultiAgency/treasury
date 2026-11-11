# treasury

The Treasury app for [MultiAgency](https://github.com/MultiAgency/platform): an agent runs an Organization's treasury, and its owner decides what it may do. The owner approves each proposal, or delegates to autopilot under a grant and the signed policy, and can freeze the agent. It's built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.5.5, against the platform's app route (`/apps/v1`).

The owner can also ask the [treasury assistant](docs/assistant.md) about the treasury in plain language: it answers from the agent's own records, each figure citing the read it came from, and drafts a change for the owner to review and sign. It holds no key and sends nothing (#219).

Freeze is the stop that halts every send. A wallet owner can freeze the agent from the app's pages (#133). A DAO-owned agent has no such stop through the app yet: its freeze vote must pass within the provider intent's 600 seconds, which most DAOs can't do (MultiAgency/platform#20). Until then, `autopilot/stop` ends its schedule and the strategy engine proposes nothing at L4, but other apps' access and approved proposals are untouched.

Beside the strategy engine, a stabilization agent projects the book under tail scenarios and from its recent price history, raises the level early, and proposes a de-risk within the same limits, or recommends pausing autopilot or a freeze. It only ever proposes or recommends: a de-risk is the owner's to approve, and a freeze needs their signature (#220, [ADR 5](docs/adr/0005-forward-risk.md)).

| Path | What |
| --- | --- |
| `apps/server/` | The app's own server. It holds the deployment's `tap_` credential, calls `/apps/v1` with `appClient`, serves the app's pages, and runs `watch`, the proposer. See [docs/app-server.md](docs/app-server.md); for deploying, [docs/deploy.md](docs/deploy.md). |
| `web/src/proposals/` | The app's pages, served by the app server: sign-in, setup, the connection, proposals, strategy and autopilot, funding, and the forward risk report. These are the one Treasury app (#128). See [docs/web.md](docs/web.md). |
| `packages/core/` | The strategy engine: pure decision logic, run by `watch` for the agents configured with it, and the stabilization agent beside it ([ADR 3](docs/adr/0003-engine-parameters.md), [ADR 5](docs/adr/0005-forward-risk.md), [HISTORY.md](packages/core/HISTORY.md)). It also carries the diversified book's asset registry, sleeves, stablecoin split and runway rules ([ADR 6](docs/adr/0006-diversified-book.md), [#221](https://github.com/MultiAgency/treasury/issues/221)), and the deterministic backtest behind [docs/diversified-backtest.md](docs/diversified-backtest.md). |
| `scripts/stabilization-backtest.ts` | The deterministic backtest behind [docs/stabilization-backtest.md](docs/stabilization-backtest.md): Ballast's bands alone against the stabilization agent, on a synthetic placeholder until real history loads. |
| `scripts/stack.ts` | Starts the platform's simulated stack for the stack tests, and drives it through its state and control files only. |
| `docs/` | Decisions (`adr/`), the app server and web builds, the [treasury assistant](docs/assistant.md), deploying, and the SDK report. |

## Running it locally

Everything runs against the platform's simulated stack at [`2e7b1e6`](https://github.com/MultiAgency/platform/commit/2e7b1e6), SDK 0.5.5 (tag `sdk-v0.5.5`). Its provider, chain, signatures and settlement are simulated. It needs Node ≥ 24.22, pnpm 12.16, and the platform checked out beside this repository:

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 2e7b1e6
(cd ../platform && pnpm install --frozen-lockfile && pnpm exec rsbuild build --root web)  # the confirm page the stack serves
pnpm install
```

Started with `--app <deployment>`, the stack issues the app's `tap_` credential into a 0600 file named in its `state.json`. To run the server itself, see [docs/app-server.md](docs/app-server.md#running-it).

## Tests

```sh
pnpm check                                   # every package's typecheck and unit tests
pnpm build                                   # every package, and the app's pages
pnpm --filter @treasury/server test:stack    # the app server on fresh stacks, one with a DAO-owned agent
pnpm --filter @treasury/web test:stack       # the app's pages through the app server
pnpm --filter @treasury/server test:sandbox  # the on-chain key check on near-kit's local node; not in CI
pnpm backtest:diversified                    # rewrites docs/diversified-backtest.md from the seeded synthetic history
```

The stack tests need `../platform` (or `TREASURY_PLATFORM`) at `2e7b1e6` with its dependencies installed. CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm build` on Node 24 and 26 for every pull request and push to `main`, then both stack tests. `anchor-check.yml` is configured to check the audit log's anchors on chain hourly, with best-effort GitHub scheduling. Failed-run alerts don't detect missing runs; an optional external heartbeat covers that gap once activated. See [the operator checks](docs/deploy.md#audit-anchor-monitor).

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).
