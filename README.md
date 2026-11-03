# treasury

The Treasury app's owner UI, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.4.0: the owner's Treasury pages, replacing the prototype's, in the session the owner signs in to with their wallet (`/a/<agent>/`, `ownerClient` same-origin). It lives in `web/` ([below](#the-owner-ui)).

Whether the owner UI stays on the owner session or moves to the app's own routes on the platform (`/apps/v1`) is an open question for the platform ([MultiAgency/platform#14](https://github.com/MultiAgency/platform/issues/14)). Most of its calls would move by changing its one platform module, `web/src/platform.ts`; some are served only by the owner session. App access doesn't reach DAO-owned agents yet ([MultiAgency/platform#13](https://github.com/MultiAgency/platform/issues/13)).

This repository had a CLI on Treasury's machine route (`/machine/v1`). It was removed in favour of the app route: the SDK's [getting-started](https://github.com/MultiAgency/platform/blob/sdk-v0.4.1/src/contract/skills/getting-started/SKILL.md) skill says the machine route isn't extended and is retired once Treasury moves to app access, and that a new app uses `appClient`. An agent runtime that reads and proposes through the app route is planned, not designed yet; `watch` (#2) waits for it.

The owner UI runs against the platform's simulated stack at [`1a7fe98`](https://github.com/MultiAgency/platform/commit/1a7fe98) (tag `sdk-v0.4.0`, the commit SDK 0.4.0 was published from). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. Requires Node ≥ 24.22 and pnpm 12.15, and the platform checked out beside this repository:

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 1a7fe98
(cd ../platform && pnpm install --frozen-lockfile)
pnpm install
```

`scripts/stack.ts` starts a fresh stack and drives it through its state file and control files only (`setTargets`, `authorizeStrategy`, `fundPublic`, `dropSwapResponse` and the others), for the owner UI's stack test.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

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

CI (`.github/workflows/ci.yml`) runs the owner UI's typecheck, unit tests and build on every pull request and push to `main`, then its stack test on a stack from the platform at 1a7fe98. Locally, the stack test needs `../platform` (or `TREASURY_PLATFORM`) at 1a7fe98 with its dependencies installed.
