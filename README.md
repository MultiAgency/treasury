# treasury

The Treasury app's owner UI, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.4.0: the owner's Treasury pages, replacing the prototype's, in the session the owner signs in to with their wallet (`/a/<agent>/`, `ownerClient` same-origin). It lives in `web/` ([below](#the-owner-ui)). Beside it, `apps/server/` is the app's own server on the app route ([below](#the-app-server), #20): the only way to reach Treasury proposals.

Whether the owner UI stays on the owner session or moves to the app's own routes on the platform (`/apps/v1`) is an open question for the platform ([MultiAgency/platform#14](https://github.com/MultiAgency/platform/issues/14)). Most of its calls would move by changing its one platform module, `web/src/platform.ts`; some are served only by the owner session. App access doesn't reach DAO-owned agents yet ([MultiAgency/platform#13](https://github.com/MultiAgency/platform/issues/13)).

This repository had a CLI on Treasury's machine route (`/machine/v1`). It was removed in favour of the app route: the SDK's [getting-started](https://github.com/MultiAgency/platform/blob/sdk-v0.4.1/src/contract/skills/getting-started/SKILL.md) skill says the machine route isn't extended and is retired once Treasury moves to app access, and that a new app uses `appClient`. `watch` (#2) comes back as the app server's proposer (#20).

Both run against the platform's simulated stack at [`1a7fe98`](https://github.com/MultiAgency/platform/commit/1a7fe98) (tag `sdk-v0.4.0`, the commit SDK 0.4.0 was published from). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. Requires Node ≥ 24.22 and pnpm 12.15, and the platform checked out beside this repository:

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 1a7fe98
(cd ../platform && pnpm install --frozen-lockfile)
pnpm install
```

`scripts/stack.ts` starts a fresh stack and drives it through its state file and control files only (`setTargets`, `authorizeStrategy`, `fundPublic`, `dropSwapResponse`, `signOwner` and the others), for both stack tests. Started with `--app <deployment>`, the stack also issues the app's `tap_` credential into a 0600 file named in its `state.json`.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

## The app server

`apps/server/` is its own package in the pnpm workspace: Node running TypeScript directly, `node:http`, `@multiagency/sdk` 0.4.0 and `near-kit` 0.20.2. It holds the deployment's `tap_` credential and calls the platform with `appClient`. Its design, rules and plan are in #20. The first version so far:

- **Owner sign-in:** a NEP-413 challenge addressed to this server, verified with `near-kit` before any chain call, then a full-access key of the signing account on chain (FastNEAR's RPC, configured as the platform's `src/chain.ts`). Each challenge is single-use and expires in 5 minutes.
- **Sessions:** a `Secure`, httpOnly, `SameSite=Strict` cookie, ended after 30 minutes idle, 12 hours or sign-out; in memory, so a restart signs everyone out. Every write checks `Origin` and requires JSON.
- **Per-agent authorization:** every `/api/agents/:agent` route checks that the signed-in account is the agent's owner, read fresh from the platform on each request.
- **Configuration** is checked at startup (`src/config.ts`); secrets print as `[secret]`. The credential file must be 0600 and is re-read on every call, so rotating it needs no restart.

```sh
pnpm --filter @treasury/server typecheck
pnpm --filter @treasury/server test          # in-process, with fakes for the platform and the chain
pnpm --filter @treasury/server test:stack    # against a fresh stack started with --app
pnpm --filter @treasury/server test:sandbox  # the on-chain key check against near-kit's local NEAR node; not run in CI
```

To run it, set `TREASURY_PLATFORM_ORIGIN`, `TREASURY_DEPLOYMENT`, `TREASURY_CREDENTIAL_FILE`, `TREASURY_PUBLIC_ORIGIN` and `TREASURY_DATA_DIR` (and optionally `FASTNEAR_API_KEY` or `NEAR_RPC_URL`), then `pnpm --filter @treasury/server start`.

## The owner UI

`web/` is its own package in the pnpm workspace: React 19, TanStack Router and Query, rsbuild, Tailwind 4 and shadcn, on `@multiagency/sdk` 0.4.0 only. Nothing is imported from the platform's or the prototype's source.

- **One platform module.** `web/src/platform.ts` makes every call: the gateway's session routes, and each agent's reads, actions and streams. Reads are cached and may retry (`reads`). An action or stream returns its result, decided by `kind`, and is never sent again. Screens import only from it.
- **Features port one at a time** from MultiAgency/treasury-prototype's `web/src`, each in its own issue. So far: the session and access (sign-in and out, account switches, access denials, the agent frame). The other pages show where their feature will land.
- **`contract.json`** names the platform capabilities the build uses (`gateway-session-v1` and `agent-observe-v1` so far). The release server refuses a build whose capabilities its host doesn't offer. `web/test/contract.test.ts` checks it both ways: every call the app makes is covered, and every capability it requires is used.
- **Accessible names** the platform's E2E specs query, and every change to them, are listed in [`web/PLATFORM-SESSION.md`](web/PLATFORM-SESSION.md), along with this app's deviations from the brief.

```sh
pnpm --filter @treasury/web build       # web/dist, with contract.json
pnpm --filter @treasury/web typecheck
pnpm --filter @treasury/web test        # platform.ts with a mocked fetch
pnpm --filter @treasury/web test:stack  # builds, then drives the build on a fresh stack served with --frontend
```

The stack test starts the platform's stack with its browser, whose owner page starts signed in, and attaches to it over CDP. It covers sign-in and out across tabs, the redirects, an outage of the agent's provider (setup unavailable, then recovered), the keyboard paths, and an axe scan (WCAG A and AA) of every page it opens.

CI (`.github/workflows/ci.yml`) runs the app server's typecheck and unit tests and the owner UI's typecheck, unit tests and build on every pull request and push to `main`, then both stack tests on a stack from the platform at 1a7fe98. Locally, the stack tests need `../platform` (or `TREASURY_PLATFORM`) at 1a7fe98 with its dependencies installed.
