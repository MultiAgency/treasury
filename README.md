# treasury

The Treasury app for [MultiAgency](https://github.com/MultiAgency/platform): an agent runs an Organization's treasury, and its owner decides what it may do. The owner approves each proposal, or delegates to autopilot under a grant and the signed policy, and can freeze the agent. It's built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.5.9, pinned to the bytes verified against the final frozen handoff, against the platform's app route (`/apps/v1`).

The owner can also ask the [treasury assistant](docs/assistant.md) about the treasury in plain language: it answers from the agent's own records, each figure citing the read it came from, and drafts a change for the owner to review and sign. It holds no key and sends nothing (#219).

Freeze is the stop that halts every send. A wallet owner can freeze the agent from the app's pages (#133). A DAO-owned agent has no such stop through the app yet: its freeze vote must pass within the provider intent's 600 seconds, which most DAOs can't do (MultiAgency/platform#20). Until then, `autopilot/stop` ends its schedule and the strategy engine proposes nothing at L4, but other apps' access and approved proposals are untouched.

For an agent whose `watch` entry enables `ballast` and `risk`, a stabilization agent projects the book under tail scenarios and from its recent price history, raises the level early, and proposes a de-risk within the same limits, or recommends pausing autopilot or a freeze. It only ever proposes or recommends: a de-risk is the owner's to approve, and a freeze needs their signature (#220, [ADR 5](docs/adr/0005-forward-risk.md)). Risk reports and what-ifs use its recorded assessments; asking the assistant does not create an assessment or start `watch`.

| Path | What |
| --- | --- |
| `apps/server/` | The app's own server. It holds the deployment's `tap_` credential, calls `/apps/v1` with `appClient`, serves the app's pages, and runs `watch`, the proposer. See [docs/app-server.md](docs/app-server.md); for deploying, [docs/deploy.md](docs/deploy.md). |
| `web/src/` | The app's pages, served by the app server: sign-in, setup, the connection, proposals, strategy and autopilot, funding, and the forward risk report. These are the one Treasury app (#128). See [docs/web.md](docs/web.md). |
| `packages/core/` | The strategy engine: pure decision logic, run by `watch` for the agents configured with it, and the stabilization agent beside it ([ADR 3](docs/adr/0003-engine-parameters.md), [ADR 5](docs/adr/0005-forward-risk.md), [HISTORY.md](packages/core/HISTORY.md)). It also carries the diversified book's asset registry, sleeves, stablecoin split and runway rules ([ADR 6](docs/adr/0006-diversified-book.md), [#221](https://github.com/MultiAgency/treasury/issues/221)), and the deterministic backtest behind [docs/diversified-backtest.md](docs/diversified-backtest.md). |
| `scripts/stabilization-backtest.ts` | The deterministic backtest behind [docs/stabilization-backtest.md](docs/stabilization-backtest.md): Ballast's bands alone against the stabilization agent, on a synthetic placeholder until real history loads. |
| `scripts/stack.ts` | Starts the platform's simulated stack for the stack tests, and drives it through its state and control files only. |
| `docs/` | Decisions (`adr/`), the app server and web builds, the [treasury assistant](docs/assistant.md), deploying, and the SDK report. |

## Operating environments

Use the [environment map](docs/deploy.md#environment-map) and [exact target inventory](.railway/environments.json) before operational work. Production is `treasury.multiagency.ai`; synthetic staging is `treasury.dev.multiagency.ai`. The live API remains `api.dev.multiagency.ai` and uses real mainnet funds; its `.dev` suffix does not make it synthetic. Staging has a separate API, credentials and volumes. A merged commit, staging deployment and live deployment are distinct release states.

## Running it locally

This repository uses the exact vendored SDK and matching platform commit described in [the final compatibility handoff](docs/sdk-final-compatibility.md). SDK 0.5.9 is published, and the coordinator verified that the public tarball is byte-identical to this tested pin. The local stack described below simulates provider, chain, signatures and settlement; this does not describe the live service. See the environment map for deployed release state. Use Node 24 for compatibility receipts and pnpm 12.16.1. Use the supplied verified source archive or an isolated exact-commit checkout. GitHub resolves the exact pinned platform commit. For a new isolated checkout (keep shared checkouts unchanged):

```sh
git clone https://github.com/MultiAgency/platform.git /tmp/treasury-platform-final
git -C /tmp/treasury-platform-final checkout --detach 252cba1d1e6642a5ea9f42ea4927f982423ed8e1
(cd /tmp/treasury-platform-final && pnpm install --frozen-lockfile && pnpm exec rsbuild build --root web)
export TREASURY_PLATFORM=/tmp/treasury-platform-final
pnpm install --frozen-lockfile
pnpm verify:sdk
```

Started with `--app <deployment>`, the stack issues the app's `tap_` credential into a 0600 file named in its `state.json`. To run the server itself, see [docs/app-server.md](docs/app-server.md#running-it).

## Tests

```sh
pnpm check                                   # every package's typecheck and unit tests
pnpm build                                   # every package, and the app's pages
pnpm test:compatibility                      # frozen platform funding/recovery/rollback gates (Node 24)
pnpm --filter @treasury/server test:stack    # the app server on fresh stacks, one with a DAO-owned agent
pnpm --filter @treasury/web test:stack       # the app's pages through the app server
pnpm --filter @treasury/server test:sandbox  # the on-chain key check on near-kit's local node; not in CI
pnpm backtest:diversified                    # rewrites docs/diversified-backtest.md from the seeded synthetic history
```

The stack tests need `../platform` (or `TREASURY_PLATFORM`) at `252cba1d1e6642a5ea9f42ea4927f982423ed8e1` with its own dependencies installed. CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm build` on Node 24 and 26 for every pull request and push to `main`, then both stack tests. `anchor-check.yml` is configured to check the audit log's anchors on chain hourly, with best-effort GitHub scheduling. Failed-run alerts don't detect missing runs; an optional external heartbeat covers that gap once activated. See [the operator checks](docs/deploy.md#audit-anchor-monitor).

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

The payment crash checks in `apps/server/test/watch.test.ts` cover overlapping ticks, recovery after an accepted proposal's acknowledgement is lost, and restart during uncertain execution. The owner execution case in `apps/server/test/stack.e2e.ts` also checks identical-request replay, refusal of changed amounts under the same request ID, and concurrent execution producing one successful operation. Run the focused checks with:

```sh
node --test apps/server/test/watch.test.ts apps/server/test/proposals.test.ts apps/server/test/watcher-lease.test.ts
TREASURY_PLATFORM=/path/to/verified-platform node --test --test-name-pattern='the owner reads, approves and executes' apps/server/test/stack.e2e.ts
```

These stack checks use simulated settlement and operation records, not observed on-chain balances. Fresh request IDs create separate proposals; the gateway test verifies that approving the first does not authorize execution of the second. This is approval isolation, not invoice deduplication: treasury proposals have no invoice identity. Production watch acquires a SQLite exclusive lease beside its request store before reading it; release drains pending writes and prevents further writes from the former owner; a second process sharing that path refuses startup. `apps/server/test/watcher-lease.test.ts` verifies contention from a separate process and recovery after SIGKILL; `main.test.ts` verifies that a second full server refuses startup before listening or ticking, and a subsequent server starts after the owner stops. Processes on independent storage are not fenced. Preserve the request store and its `.lease` file together, and stop watchers before moving that state. The separate NEAR sandbox suite checks account keys, not treasury settlement.

The opt-in settlement recovery test runs the pinned platform's dispatch, journal, money lock and recovery code in child processes against a local NEAR sandbox. A test provider adapter maps fixture USDC amounts to native NEAR transfers (1 fixture raw unit = 10^18 yoctoNEAR); policy and grant responses are fixtures. It kills the submitting process after the transfer finalizes, before the operation ID is recorded and, separately, after the ID is recorded but before status acknowledgement. A frozen policy is refused before submission with no transfer. Two recovery processes running under a frozen policy verify the same transaction identity and an exact single credit to each recipient. A lost ID remains unresolved and blocks sends; a recorded ID settles through status reads without another send.

```sh
TREASURY_PLATFORM=/path/to/verified-platform pnpm --filter @treasury/server test:settlement:sandbox
```

The run writes transaction hashes, recipient balances, adapter send counts, and journals to `.test-artifacts/settlement-recovery/latest.json`. This establishes recovery for native sandbox transfers through the test adapter. It does not verify live provider idempotency, confidential USDC custody, swaps, production policy enforcement, or deployed behavior. The platform runtime remains pinned and unchanged.
