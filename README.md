# treasury

The Treasury app for [MultiAgency](https://github.com/MultiAgency/platform): an agent runs an Organization's treasury, and its owner decides what it may do. The owner approves each proposal, or delegates to autopilot under a grant and the signed policy, and can freeze the agent. It's built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.6.0, pinned to the exact tarball in `scripts/sdk-pin.ts`, against the platform's app route (`/apps/v1`).

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

## NEAR HACKATHON submission

**The problem.** An Organization, whether a single wallet or a Sputnik DAO, wants its treasury rebalanced and de-risked without giving a bot custody or a blank cheque. **Treasury** gives the job to an agent. The owner sets the strategy and signs a policy. The agent only proposes trades inside that policy, and nothing moves until the owner approves. The owner can delegate to autopilot under a grant bound to one strategy, and can freeze the agent at any time.

**How NEAR fits.**

| NEAR piece | What Treasury does with it | Where |
| --- | --- | --- |
| NEAR Intents | Swaps run on NEAR Intents mainnet through the platform's agent provider. The hedge plan reads NEAR Intents' public 1Click API for the live token list and dry-run quotes only; it never sends through it. | `apps/server/src/proposals.ts`, `apps/server/src/intents.ts`, `apps/server/src/hedge.ts` |
| The owner's signed policy | Sign-in, consent, proposal approval and the strategy grant are NEP-413 signatures from the owner's own NEAR wallet. Policy edits and freezes are owner actions: the wallet signs them in the app or on the platform's confirm page, whichever the platform returns. The app holds no key that can move funds. | `apps/server/src/contract.ts`, `web/src/` |
| DAO votes | A Sputnik DAO owns its agent through its own votes: consent, setup, the Treasury grant and each proposal approval are DAO proposals that members vote on (the app links to Trezu). Treasury reads the proposals' status from the DAO contract. | `apps/server/src/dao.ts`, `apps/server/src/dao-offer.ts`, [ADR 2](docs/adr/0002-owner-ui-app-access.md) |
| NEAR chain | The audit log's sequence number and head hash are anchored on NEAR (testnet in the hosted deployment), and a scheduled GitHub check reads them back (best effort: GitHub delays and drops scheduled runs). | `apps/server/src/anchor.ts`, `apps/server/src/anchor-check.ts` |
| NEAR AI Cloud | The [treasury assistant](docs/assistant.md) answers the owner's questions from the agent's own records through NEAR AI Cloud. It holds no key and sends nothing. | `apps/server/src/assistant/` |

**Evidence, and what is simulated.** On 2026-11-07 a wallet owner approved a Treasury rebalance on mainnet through this app, signing with their own key, and both swaps read `SUCCESS`. This is recorded in the platform's [mainnet log](https://github.com/MultiAgency/platform/blob/main/docs/mainnet-log.md); amounts are kept private. On 2026-11-14 the same flow ran again on this release, Treasury `3a43489` as live deployment `edf440da`. Watch proposed a single swap, the owner approved it by signature at about 19:18Z, and it executed once with `success`. This is read from the app's own record; the amount and operation identifiers are kept private. Everything under [Running it locally](#running-it-locally) and [Tests](#tests) runs against the platform's **simulated** provider, chain and settlement. The synthetic staging host (`treasury.dev.multiagency.ai`) also settles **synthetic** balances only. The live host (`treasury.multiagency.ai`) uses real mainnet funds.

**Shared infrastructure.** This application uses the shared MultiAgency Platform and `@multiagency/sdk` for app consent, owner/DAO signatures, guarded execution, durable request identity and local simulation. Treasury and Paperwork are separate applications with one shared founder. These primitives are shared work, not independently invented by both teams.

The other project is **Paperwork**: https://github.com/MultiAgency/demo.

Treasury's own contribution is this repository:
- the app server: consent, proposals, the `watch` proposer, the audit log and its anchor
- the owner's pages, for wallet and DAO owners
- the strategy engine (bands, policy, levels, faults, replay and calibration)
- the stabilization agent and forward risk report
- the diversified book and hedge plan
- the treasury assistant

The exception is code adapted from the platform's baseline: about 1% of this repository's code lines. Most of it is UI components and form, format, price, budget and policy-draft helpers in `web/src`: `shared/format.ts`, `shared/ui.tsx`, `shared/form.tsx`, `shared/prices.ts`, `shared/budget.ts`, `policy-draft.ts`, `policy-review.ts`, `strategy-form.ts`, `components/ui/alert.tsx` and `components/ui/field.tsx`. An earlier prototype, [MultiAgency/treasury-prototype](https://github.com/MultiAgency/treasury-prototype) (commits from 2026-10-15 to 2026-10-19), explored the idea. It took the same helpers from the platform. Apart from those, it shares a few layout lines with this repository and no other code.

**Hackathon window.** This repository was created on 2026-10-28 (`837fb10`), after the 2026-10-19 announcement, so there is no earlier commit to tag. All of its history is window work: [`837fb10...hackathon-submission`](https://github.com/MultiAgency/treasury/compare/837fb10...hackathon-submission). The pre-window baseline is the founder's own [MultiAgency/platform](https://github.com/MultiAgency/platform), which this app consumes through `@multiagency/sdk`. Its last commit before the announcement is [`af6c03b`](https://github.com/MultiAgency/platform/commit/af6c03b), which already had a treasury agent and autopilot. Platform changes made during the window are shared infrastructure, described above, and are not claimed as this submission's work.

**Libraries.** These are the direct dependencies, from each `package.json`:
- The founder's own: `@multiagency/sdk` (the vendored 0.6.0 candidate, verified by `pnpm verify:sdk`) and MultiAgency/platform, which provides the local simulated stack. Their pre-window baseline and in-window changes are described under Hackathon window.
- NEAR: `near-kit`, `@fastnear/near-connect`, plus FastNEAR RPC and KV, the NEAR Intents 1Click API and NEAR AI Cloud as services.
- Server: `zod`, `@ag-ui/core`.
- Pages: `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `radix-ui`, `class-variance-authority`, `cn`, `tailwindcss`, `tw-animate-css`, `shadcn`, `motion`, `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing`, `postprocessing`, `@phosphor-icons/react`, and the Geist and Inter fonts (`@fontsource-variable/*`).
- Build and test: `typescript`, `@rsbuild/core`, `@rsbuild/plugin-react`, `@tailwindcss/postcss`, `playwright`, `@axe-core/playwright`, `railway`.

The code was written with AI coding assistants.

**Try it.** Follow [Running it locally](#running-it-locally) and [Tests](#tests). These are the steps CI runs on every push to `main`. On 2026-11-14 they were run from fresh public clones of both repositories on macOS:
- `pnpm check`: 1,316 unit tests passed (web 215, core 409, server 692).
- The two stack suites: 30 app-server tests and 76 browser tests passed.
- `pnpm test:compatibility`: 220 tests passed on Node 24.22.3, and again on Node 26.13.1.

On Linux, use `playwright install --with-deps chromium`.

## Operating environments

Use the [environment map](docs/deploy.md#environment-map) and [exact target inventory](.railway/environments.json) before operational work. Production is `treasury.multiagency.ai`; synthetic staging is `treasury.dev.multiagency.ai`. The live API remains `api.dev.multiagency.ai` and uses real mainnet funds; its `.dev` suffix does not make it synthetic. Staging has a separate API, credentials and volumes. A merged commit, staging deployment and live deployment are distinct release states.

## Running it locally

This release uses the exact vendored SDK 0.6.0 and platform pair recorded in `scripts/sdk-pin.ts`: platform source `f4729f4a7244a4e415d03678535328960b695d71`, candidate `c1a3ae617f7c2ff64dc4a976e1493b96bceec56cf6c98d675d1c863cbd817509`, SDK SHA-256 `aa3d4325bde4f74604280c577fac99b50acea805d27214a89899a77e1132af9a`, byte-identical to `@multiagency/sdk@0.6.0` on npm. Platform-wide acceptance remains open. The [0.5.9 compatibility handoff](docs/sdk-final-compatibility.md) is historical evidence for its own pair. The local stack described below simulates provider, chain, signatures and settlement; this does not describe the live service. See the environment map for deployed release state. Use Node 24 or later and pnpm 12.16.1. Use the supplied verified source archive or an isolated exact-commit checkout. GitHub resolves the exact pinned platform commit. For a new isolated checkout (keep shared checkouts unchanged):

```sh
git clone https://github.com/MultiAgency/platform.git /tmp/treasury-platform-final
git -C /tmp/treasury-platform-final checkout --detach f4729f4a7244a4e415d03678535328960b695d71
(cd /tmp/treasury-platform-final && pnpm install --frozen-lockfile && pnpm exec rsbuild build --root web && pnpm exec playwright install chromium)
export TREASURY_PLATFORM=/tmp/treasury-platform-final
pnpm install --frozen-lockfile
pnpm verify:sdk
```

Started with `--app <deployment>`, the stack issues the app's `tap_` credential into a 0600 file named in its `state.json`. To run the server itself, see [docs/app-server.md](docs/app-server.md#running-it).

## Tests

```sh
pnpm check                                   # every package's typecheck and unit tests
pnpm build                                   # every package, and the app's pages
pnpm test:compatibility                      # frozen platform funding/recovery/rollback gates (Node 24 or later)
pnpm --filter @treasury/server test:stack    # the app server on fresh stacks, one with a DAO-owned agent
pnpm --filter @treasury/web test:stack       # the app's pages through the app server
pnpm --filter @treasury/server test:sandbox  # the on-chain key check on near-kit's local node; not in CI
pnpm backtest:diversified                    # rewrites docs/diversified-backtest.md from the seeded synthetic history
```

The stack tests need `../platform` (or `TREASURY_PLATFORM`) at `f4729f4a7244a4e415d03678535328960b695d71` with its own dependencies installed. CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm build` on Node 24 and 26 for every pull request and push to `main`, then both stack tests. `anchor-check.yml` is configured to check the audit log's anchors on chain hourly, with best-effort GitHub scheduling. Failed-run alerts don't detect missing runs; an optional external heartbeat covers that gap once activated. See [the operator checks](docs/deploy.md#audit-anchor-monitor).

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
