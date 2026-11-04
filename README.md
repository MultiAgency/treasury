# treasury

The Treasury app's owner UI, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.5.0: the owner's Treasury pages, replacing the prototype's, in the session the owner signs in to with their wallet (`/a/<agent>/`, `ownerClient` same-origin). It lives in `web/` ([below](#the-owner-ui)). Beside it, `apps/server/` is the app's own server on the app route ([below](#the-app-server), #20): the only way to reach Treasury proposals.

The owner UI moves to the app's own routes on the platform (`/apps/v1`): the owner session gets no production host ([MultiAgency/platform#14](https://github.com/MultiAgency/platform/issues/14)). Most of its calls move by changing its one platform module, `web/src/platform.ts`; the rest are served only by the owner session, and which of them reach app access is [MultiAgency/platform#17](https://github.com/MultiAgency/platform/issues/17). SDK 0.5.0 adds app access for DAO-owned agents (consent, setup and owner actions by the DAO's vote); it isn't on any host yet, and this repository doesn't use it yet ([MultiAgency/platform#13](https://github.com/MultiAgency/platform/issues/13)).

This repository had a CLI on Treasury's machine route (`/machine/v1`). It was removed in favour of the app route: the SDK's [getting-started](https://github.com/MultiAgency/platform/blob/sdk-v0.5.0/src/contract/skills/getting-started/SKILL.md) skill says the machine route isn't extended and is retired once Treasury moves to app access, and that a new app uses `appClient`. `watch` (#2) comes back as the app server's proposer (#20).

Both run against the platform's simulated stack at [`6ba0831`](https://github.com/MultiAgency/platform/commit/6ba0831) (tag `sdk-v0.5.0`, the commit SDK 0.5.0 was published from). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. Requires Node ≥ 24.22 and pnpm 12.16, and the platform checked out beside this repository:

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 6ba0831
(cd ../platform && pnpm install --frozen-lockfile)
pnpm install
```

`scripts/stack.ts` starts a fresh stack and drives it through its state file and control files only (`setTargets`, `authorizeStrategy`, `fundPublic`, `dropSwapResponse`, `signOwner` and the others), for both stack tests. Started with `--app <deployment>`, the stack also issues the app's `tap_` credential into a 0600 file named in its `state.json`.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

## The app server

`apps/server/` is its own package in the pnpm workspace: Node running TypeScript directly, `node:http`, `@multiagency/sdk` 0.5.0 and `near-kit` 0.20.2. It holds the deployment's `tap_` credential and calls the platform with `appClient`. Its design, rules and plan are in #20. The first version so far:

- **Owner sign-in:** a NEP-413 challenge addressed to this server, verified with `near-kit` before any chain call, then a full-access key of the signing account on chain (FastNEAR's RPC, configured as the platform's `src/chain.ts`). Challenges are stateless (the nonce carries its issue time and an HMAC under a per-process key), so issuing one stores nothing and a flood can't crowd out an owner's; each is single-use once validly signed (only its canonical base64 text is accepted) and expires in 5 minutes. Challenges and sign-in attempts are each rate-limited per client (an IPv4 address, or an IPv6 /64).
- **Sessions:** a `Secure`, httpOnly, `SameSite=Strict` cookie, ended after 30 minutes idle, 12 hours or sign-out, and swept when abandoned; in memory, so a restart signs everyone out. Signing in again ends the previous session, and sign-out always clears the cookie, with or without a body. Every write checks `Origin` and requires JSON.
- **Per-agent authorization:** every `/api/agents/:agent` route checks that the signed-in account is the agent's owner, as the platform answers it, and that the agent's identity names this deployment. The platform allows a credential 1,200 calls an hour, shared by every owner, so a successful answer is reused for up to a minute per agent (never a failure, so an agent set up a moment later is reachable at once), concurrent reads share one call, and each account may make 60 owner-route requests a minute. A reused answer that would refuse the account is read once more anew, so a new owner isn't locked out after a transfer. Routes that answer from the server's own records (`owner-fresh`, from PR 2) always read it anew. A missing agent and someone else's get the same answer, `not_owner`; any other platform failure is `unavailable`, as is an identity naming another deployment (this server misconfigured). The platform's error text is logged, never sent to the browser.
- **Connecting an agent:** the server builds the consent text from the agent's identity as the platform answers it now (`read` and `treasury` for 90 days, under the owner's Organization: their account with each `.` written as `--`), and the owner's wallet signs it for the platform's host. An agent already connected isn't offered another signature. The server relays only that exact consent, submits the same signed body once more if the answer is lost, revokes the owner's older consents for the agent once a new one is stored, and limits each account to `CONSENTS_PER_DAY` new consents (the platform caps a deployment's unexpired consents, revoked ones included). A consent counts as the agent's only for its current ID, with `read` and `treasury`, unrevoked and unexpired. Disconnecting revokes those, at most five a request, found in the platform's own list, never by an ID from the browser.
- **Proposals:** the owner lists and reads their agent's proposals, under their own Organization only. Approving or rejecting relays the owner's wallet signature over the SDK's `proposalText` of the proposal the page shows; the server reads it anew first and refuses, with nothing relayed, unless it's unexpired, still open and exactly that text, signed with a full-access key of the owner for the platform's host. Execute is sent only for an approved proposal, once per request, and never again after a lost answer: the proposal is read and answers `final`, `pending` (offer no Execute; read it again later) or `not_executable` (nothing was sent; it may be tried later). The platform claims a proposal once, so it never runs twice.
- **Audit trail:** every relayed consent, revocation, approval, rejection and execute is recorded in `TREASURY_AUDIT_FILE`, a JSON line before the platform is asked and one with its answer: who, what, the SHA-256 of the signed text, the platform's status and the code the browser got, never a signature. The server won't start if it can't append to the file or if others can read it.
- **The proposals page:** with `TREASURY_PAGE_DIR` set to the page's build (`web/dist-proposals`), the server serves the owner's proposals page from its own origin. It reads the build's regular files into memory at startup (no dotfiles or links) and serves them by exact path, for GET and HEAD: every other path outside `/api/` and `static/` is the page, which is never cached, may not be framed and sends no referrer. The page calls only this server's `/api/` routes.
- **`watch`, the proposer (#2):** with `TREASURY_WATCH_FILE` naming its agents, the server proposes a rebalance for each one when its holdings drift past the agent's threshold (5 points of the total by default), every `intervalS` (300 by default). It proposes only, with `legs: "strategy"`, and the owner approves on the proposals page. It holds while the agent has unresolved operations, while autopilot is on, while the policy isn't in force, and while a proposal of its own is still open. Each request is stored in `TREASURY_REQUESTS_FILE` before it's sent, and a lost answer is sent again unchanged, so it never makes a second proposal. If the owner's consent ends, the agent waits until they connect again. `notify`, a command and its arguments, runs once per proposal without a shell, with the proposal as JSON on stdin and only `PATH` in its environment. The server won't start if the agents' reads would spend more than half the platform's 1,200 calls an hour (3 a tick).
- **Configuration** is checked at startup (`src/config.ts`); secrets print as `[secret]`, and a variable set to nothing counts as unset. This server's origin must be https except on localhost, since the session cookie is `Secure`. The credential file must be 0600; it's checked on every call and read again when it changes, so rotating it needs no restart. The rate limits use the connection's address unless `TREASURY_TRUSTED_PROXY_HOPS` says how many reverse proxies to trust for `X-Forwarded-For`.

```sh
pnpm --filter @treasury/server typecheck
pnpm --filter @treasury/server test          # in-process, with fakes for the platform and the chain
pnpm --filter @treasury/server test:stack    # against a fresh stack started with --app
pnpm --filter @treasury/server test:sandbox  # the on-chain key check against near-kit's local NEAR node; not run in CI
```

To run it, set `TREASURY_PLATFORM_ORIGIN`, `TREASURY_DEPLOYMENT`, `TREASURY_CREDENTIAL_FILE`, `TREASURY_PUBLIC_ORIGIN` and `TREASURY_AUDIT_FILE` (and optionally `TREASURY_PAGE_DIR`, `TREASURY_WATCH_FILE` with `TREASURY_REQUESTS_FILE`, `FASTNEAR_API_KEY`, `NEAR_RPC_URL`, `TREASURY_TRUSTED_PROXY_HOPS`, `OWNER_REQUESTS_PER_MINUTE` or `CONSENTS_PER_DAY`), then `pnpm --filter @treasury/server start`.

## The owner UI

`web/` is its own package in the pnpm workspace: React 19, TanStack Router and Query, rsbuild, Tailwind 4 and shadcn, on `@multiagency/sdk` 0.5.0 only. Nothing is imported from the platform's or the prototype's source.

- **One platform module.** `web/src/platform.ts` makes every call: the gateway's session routes, and each agent's reads, actions and streams. Reads are cached and may retry (`reads`). An action or stream returns its result, decided by `kind`, and is never sent again. Screens import only from it.
- **Features port one at a time** from MultiAgency/treasury-prototype's `web/src`, each in its own issue. A page not ported yet shows a placeholder where its feature will land.
- **`contract.json`** names the platform capabilities the build uses. The release server refuses a build whose capabilities its host doesn't offer. `web/test/contract.test.ts` checks it both ways: every call the app makes is covered, and every capability it requires is used.
- **The proposals page** (#20) is a second build in the same config (`src/proposals/`, built to `dist-proposals/`), served by the app server, not the platform: the owner signs in to that server with their wallet, connects the agent with a consent, then approves or rejects each proposal by signing its exact text and executes approved ones. `src/proposals/proposals-api.ts` is its only module that calls a server, parsing every answer with `apps/server/src/contract.ts`; it never imports `src/platform.ts`.
- **Accessible names** the platform's E2E specs query, and every change to them, are listed in [`web/PLATFORM-SESSION.md`](web/PLATFORM-SESSION.md), along with this app's deviations from the brief.

```sh
pnpm --filter @treasury/web build       # web/dist (the owner UI, with contract.json) and web/dist-proposals (the proposals page)
pnpm --filter @treasury/web typecheck
pnpm --filter @treasury/web test        # platform.ts with a mocked fetch
pnpm --filter @treasury/web test:stack  # builds, then drives the owner UI on a stack served with --frontend, and the proposals page through the app server on its own stack
```

The stack test starts the platform's stack with its browser, whose owner page starts signed in, and attaches to it over CDP. It covers sign-in and out across tabs, the redirects, an outage of the agent's provider (setup unavailable, then recovered), the keyboard paths, and an axe scan (WCAG A and AA) of every page it opens.

CI (`.github/workflows/ci.yml`) runs the app server's typecheck and unit tests and the owner UI's typecheck, unit tests and build on every pull request and push to `main`, then both stack tests on a stack from the platform at 6ba0831. Locally, the stack tests need `../platform` (or `TREASURY_PLATFORM`) at 6ba0831 with its dependencies installed.
