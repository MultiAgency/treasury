# The web builds

`web/` is its own package in the pnpm workspace: React 19, TanStack Router and Query, rsbuild, Tailwind 4 and shadcn, on `@multiagency/sdk` 0.5.3 only. Nothing is imported from the platform's or the prototype's source. One rsbuild config makes two builds.

## The app's pages (`src/proposals/`)

A second build in the same rsbuild config (`src/proposals/`, built to `dist-proposals/`), served by the app server, not the platform: the owner signs in to that server with their wallet, connects the agent with a consent, then approves or rejects each proposal by signing its exact text and executes approved ones. `src/proposals/proposals-api.ts` is its only module that calls a server, parsing every answer with `apps/server/src/contract.ts`; it never imports `src/platform.ts`. It has pages, from one table (`src/proposals/pages.ts`) that its TanStack Router routes and its titles are built from (#129): `/` your treasuries, `/setup/dao/<dao>`, and an agent's `/agents/<agent>/` (Home: what needs your decision, where the agent stands, its book and portfolio, and its connection; creating it while it isn't), `…/proposals`, `…/proposals/<id>`, `…/strategy`, `…/funding` and `…/activity` (the full history, the owner's actions, the autopilot's runs at `…/activity/runs/<id>`, and the books), each with one `<h1>`, inside a frame with the agent's name, who is signed in and the navigation. An address that names nothing says so. The server serves the page for every path, so each address opens directly.

It's becoming the one Treasury app, decisions first: the owner UI's remaining features move here, then the owner-session build is retired (#128, #138).

## The owner-session UI (`src/app/`, `src/features/`)

The owner's Treasury pages in the session the owner signs in to with their wallet (`/a/<agent>/`, `ownerClient` same-origin), replacing the prototype's. The owner session gets no production host (MultiAgency/platform#14), so [ADR 2](adr/0002-owner-ui-app-access.md) moves these pages behind the app server; until that's done, this build is the simulated-stack reference. `pnpm --filter @treasury/web audit:app-access` compares its calls with the installed SDK's consent scopes.

- **One platform module.** `web/src/platform.ts` makes every call: the gateway's session routes, and each agent's reads, actions and streams. Reads are cached and may retry (`reads`). An action or stream returns its result, decided by `kind`, and is never sent again. Screens import only from it.
- **Its features were ported** from MultiAgency/treasury-prototype's `web/src`, one issue each; Runs and the guided walkthrough are still placeholders.
- **`contract.json`** names the platform capabilities the build uses. The release server refuses a build whose capabilities its host doesn't offer. `web/test/contract.test.ts` checks it both ways: every call the app makes is covered, and every capability it requires is used.
- **Accessible names** the platform's E2E specs query, and every change to them, are listed in [`web/PLATFORM-SESSION.md`](../web/PLATFORM-SESSION.md), along with this app's deviations from the brief.

## Building and testing

```sh
pnpm --filter @treasury/web build       # web/dist (the owner UI, with contract.json) and web/dist-proposals (the app's pages)
pnpm --filter @treasury/web typecheck
pnpm --filter @treasury/web test        # unit tests; the API modules against a mocked fetch
pnpm --filter @treasury/web test:stack  # builds, then the owner UI's stack test and the app's pages' two
```

The owner UI's stack test (`test/stack.e2e.ts`) starts the platform's stack with its browser, whose owner page starts signed in, and attaches to it over CDP. It covers sign-in and out across tabs, the redirects, an outage of the agent's provider (setup unavailable, then recovered), the keyboard paths, and an axe scan (WCAG A and AA) of every page it opens.

The app's pages are tested through the app server, run in-process with the stack's own `tap_` credential: `test/proposals.e2e.ts` on a stack with a wallet-owned agent, the owner's wallet signing through the stack's `signOwner` control, and `test/dao-proposals.e2e.ts` on one with a DAO-owned agent, its council signing with their own key and the DAO voting through the stack's `daoVote` control. Both scan the pages they open with axe (WCAG A and AA).

- **Policy** (`/agents/<agent>/policy`, #142): the agent's grants, live and ended, with revocation behind a confirm dialog. Issuing or renewing a grant stays on the Strategy page. The pinned platform stack's simulated provider does not prepare a revocation, so the signed path is covered by the server tests with the fake platform; the page's e2e covers the listing, the keyboard path to the dialog and the honest refusal.
