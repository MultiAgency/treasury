# The web builds

`web/` is its own package in the pnpm workspace: React 19, TanStack Router and Query, rsbuild, Tailwind 4 and shadcn, on `@multiagency/sdk` 0.5.3 only. Nothing is imported from the platform's or the prototype's source. rsbuild builds the app's pages.

## The app's pages (`src/proposals/`)

The build (`src/proposals/`, built to `dist-proposals/`), served by the app server, not the platform: the owner signs in to that server with their wallet, connects the agent with a consent, then approves or rejects each proposal by signing its exact text and executes approved ones. `src/proposals/proposals-api.ts` is its only module that calls a server, parsing every answer with `apps/server/src/contract.ts`. It has pages, from one table (`src/proposals/pages.ts`) that its TanStack Router routes and its titles are built from (#129): `/` your treasuries, `/setup/dao/<dao>`, and an agent's `/agents/<agent>/` (Home: what needs your decision, where the agent stands, its book and portfolio, and its connection; creating it while it isn't), `…/proposals`, `…/proposals/<id>`, `…/strategy`, `…/funding` and `…/activity` (the full history, the owner's actions, the autopilot's runs at `…/activity/runs/<id>`, and the books), each with one `<h1>`, inside a frame with the agent's name, who is signed in and the navigation. An address that names nothing says so. The server serves the page for every path, so each address opens directly.

It is the one Treasury app, decisions first (#128). The owner-session build it replaced was removed in #138 ([ADR 2](adr/0002-owner-ui-app-access.md)).

## Building and testing

```sh
pnpm --filter @treasury/web build       # web/dist-proposals, the app's pages
pnpm --filter @treasury/web typecheck
pnpm --filter @treasury/web test        # unit tests; the API modules against a mocked fetch
pnpm --filter @treasury/web test:stack  # builds, then the app's pages' two stack tests
```

The app's pages are tested through the app server, run in-process with the stack's own `tap_` credential: `test/proposals.e2e.ts` on a stack with a wallet-owned agent, the owner's wallet signing through the stack's `signOwner` control, and `test/dao-proposals.e2e.ts` on one with a DAO-owned agent, its council signing with their own key and the DAO voting through the stack's `daoVote` control. Both scan the pages they open with axe (WCAG A and AA).

- **Policy** (`/agents/<agent>/policy`, #134, #142): the policy as signed, its limits beside what is reported left, the editor (reusing `policy-draft.ts` and `policy-review.ts`, now in `src/proposals/`), the grants with revocation behind a confirm dialog, and the revisions with the mandate digest, collapsed. Issuing or renewing a grant stays on the Strategy page; the proposal page's `policy_not_in_force` refusal links here. On the stack, the page's e2e revokes the grant by keyboard, signed once, and reads it ended (#187).
