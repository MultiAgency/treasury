# treasury

The Treasury app, built on [`@multiagency/sdk`](https://www.npmjs.com/package/@multiagency/sdk) 0.4.0. It shows two SDK surfaces for Treasury agents:

| | Surface | Reached with | Where |
| --- | --- | --- | --- |
| **The CLI** | Treasury's machine route (`/machine/v1/a/<agent>`): an agent managing the holdings for its wallet owner | `ownerClient` with an absolute base and an owner-issued `tmc_` bearer credential | `src/`, `scripts/`, `test/` (this page) |
| **The owner UI** | The owner's session on the host (`/a/<agent>/`): the owner's Treasury pages, replacing the prototype's | `ownerClient` same-origin, in the session the owner signs in to with their wallet | `web/` ([below](#the-owner-ui)) |

Under direction B, both move to the app's own routes on the platform (`/apps/v1`). For the UI, that switch is confined to its one platform module, `web/src/platform.ts`. The app path today (`appClient`, owner consents, payout requests) is demonstrated by the MultiAgency dashboard.

The machine route covers Treasury agents owned by a wallet only. A DAO-owned agent is refused, since a member's permissions aren't the DAO's consent. The platform host doesn't serve the machine route yet, so both surfaces run against the platform's simulated stack at [`1a7fe98`](https://github.com/MultiAgency/platform/commit/1a7fe98) (tag `sdk-v0.4.0`, the commit SDK 0.4.0 was published from). Its provider, chain, signatures and settlement are simulated. Pointing at a hosted platform is a separate decision. The CLI's host, agent and credentials live in `.env`.

SDK and platform feedback goes to [MultiAgency/platform](https://github.com/MultiAgency/platform).

## What the agent may do

Each credential reaches only its scopes, and the scopes don't imply one another. `src/config.ts` fixes the scopes each role's credential is issued with, and `src/machine.ts` narrows `ownerClient` to them. A call outside a role's scopes doesn't compile, and neither does using one role's client where another's scopes are expected. The server refuses either with `forbidden` anyway.

| Scope | Procedures |
| --- | --- |
| `read` | `instance`, `overview`, `policyHistory`, `strategy/get`, `autopilot/get`, `activity`, `unresolved`, `autopilot/evidence`, `autopilot/log`, `ledger`, `ledgerCsv` |
| `prepare` | `rebalance`, `externalPlan` |
| `execute-plan` | `executePlan` |
| `sweep` | `sweep` |

Nothing on this route signs owner actions or changes policy, grants, schedules or payments.

Two limits are the owner's to manage, not the route's:

- **An execute credential runs any eligible saved plan of this Treasury** within that plan's 5-minute life, not only the one you mean to approve. The gateway checks the credential's scope, not which plan it executes (the platform's `src/gateway/machine-auth.ts`). A plan is eligible only while the owner's live grant binds the strategy it was planned under, which the owner signs once per saved strategy; saving the strategy again, by the owner or an app, refuses its plans until the owner signs again (the platform's `src/planning/strategy-grant.ts`). Execute only the plan ID you mean, and issue execute credentials with a short lifetime.
- **An execute credential has no spending budget of its own.** Each plan runs exactly its saved actions, but the credential can execute any number of eligible plans. Autopilot's per-run `maxUsd` applies only to autopilot (the platform's `src/autopilot.ts`). Only the owner's policy and grants cap the total, and spending caps don't cap market exposure. The strategy-bound grant fixes which strategy plans run under, not how many.

## Run it on the simulated stack

Requires Node ≥ 24.22 and pnpm 12.15.

```sh
git clone https://github.com/MultiAgency/platform.git ../platform && git -C ../platform checkout 1a7fe98
(cd ../platform && pnpm install --frozen-lockfile && pnpm test:e2e:stack --no-browser --treasury)
```

The stack prints `Isolated stack ready: <run>/stack/state.json`. Its Treasury agent is `portfolio`, owned by `owner.near`, with 100 simulated USDC. In this repository:

```sh
pnpm install
pnpm stack:credential <run>/stack propose        # the owner issues a read + prepare credential into .env
export NODE_EXTRA_CA_CERTS=<run>/stack/environment/localhost.crt
pnpm treasury status
```

`stack:credential` acts as the owner through the stack's `machineCredential` control. It takes a role (`propose`, `execute` or `sweep`) and an optional lifetime in whole seconds from 60 to 86400 (default 3600), and prints the platform's error if issuing fails. It writes the token into `.env` through a new 0600 file renamed over it, so the token is never readable under another mode. Other lines, comments and blank lines are kept, and the token is never printed. Node reads `NODE_EXTRA_CA_CERTS` before it loads `.env`, so the stack's CA is exported in the shell instead.

## Commands

The agent proposes and the owner approves, each with its own credential:

| Command | Credential | Effect |
| --- | --- | --- |
| `status` | `TREASURY_PROPOSE_TOKEN` (`read`) | Reads `overview`, `unresolved` and `activity`. Moves nothing |
| `plan` | `TREASURY_PROPOSE_TOKEN` (`prepare`) | `rebalance`: quotes legs toward the owner's saved targets and saves a plan. Moves nothing |
| `plan swap <from> <to> <amount>` | `TREASURY_PROPOSE_TOKEN` (`prepare`) | `externalPlan`: quotes one chosen swap (atomic units of `<from>`) and saves a plan. Moves nothing |
| `execute <planId> [--yes]` | `TREASURY_EXECUTE_TOKEN` (`execute-plan`) | The owner's approval: executes a saved plan, which the executor claims at most once |
| `sweep [--execute [--yes]]` | `TREASURY_SWEEP_TOKEN` (`sweep`) | Previews, or shields, managed public balances |

`execute` and `sweep --execute` move funds only with `--yes` or a "y" answered at a terminal; otherwise they send nothing. Results print as JSON values, one after another (stream events as they arrive, then `{ outcome }`), decided by `kind`.

| Exit | Outcome | Meaning |
| --- | --- | --- |
| `0` | ok | Every leg (or shield) reported `SUCCESS`, or a read or proposal succeeded |
| `2` | `refused`, `forbidden`, `session`, `busy`, `unresolved`, `provider`, `unavailable` | Nothing was sent |
| `3` | `unknown` | An action may have taken effect: its answer was lost, or a leg's status isn't final |
| `4` | `partial` | At least one leg or shield was sent, and not every leg succeeded. Funds may have moved; read activity and unresolved before acting again. The outcome lists each leg's status and `correlationId` |

On the machine route, `forbidden` from the gateway (`source: "gateway"`) also covers a provider outage. The gateway re-checks the agent's identity with the provider on every call, and refuses with 403 when that check goes unanswered (the platform's `src/gateway/machine-authority.ts`). Nothing was sent either way.

`execute` and `sweep` are decided from the legs they report, not from how their stream ends. The executor can reject a plan before any leg or after earlier legs moved funds, and it ends normally after a leg that didn't succeed.
- A leg counts as sent unless its status is `NOT_SENT`, or if a shield before it was sent.
- `rejected` with nothing sent is `refused` (2).
- Anything sent, followed by `rejected` or a leg that isn't `SUCCESS`, is `partial` (4). `FAILED` and `REFUNDED` don't prove that nothing moved.
- A status other than `SUCCESS`, `FAILED`, `REFUNDED` or `NOT_SENT` hasn't settled, so the outcome is `unknown` (3).
- A throw after the stream's first event, including one in the CLI's own output, is `unknown` (3).
- A lost sweep preview (`sweep` without `--execute`) is `unavailable` (2), with no records read: a preview takes no money lock and returns before any send.

Arguments are checked before `.env` is read, so a usage error prints usage (exit 2) even without configuration.

After `unknown` or `partial`, the CLI reads `unresolved` and `activity` with the read credential and prints them as `{ recorded }`. It never sends the action again.

To issue the owner's approval credentials on the stack:

```sh
pnpm stack:credential <run>/stack execute 600
pnpm stack:credential <run>/stack sweep 600
```

On the stack, the simulator quotes a swap between any two listed tokens, so `rebalance` works against the stack's default targets (USDC 50%, wNEAR 25%, ETH 25%). The stack test sets the owner's targets with the stack's `setTargets` control, which saves them through `strategy/save` as the owner and turns autopilot off, then signs the owner's grant bound to that strategy with the `authorizeStrategy` control. This repository reaches the stack only through its state file and control files.

## Checks

```sh
pnpm typecheck
pnpm test                                  # unit tests
pnpm test:stack                            # the CLI end to end on a fresh stack it starts and stops
```

The stack test starts a fresh stack from `../platform` (or `TREASURY_PLATFORM`), which must be checked out at 1a7fe98 with its dependencies installed, and stops it afterwards. The stack's files go under the platform's `.test-artifacts/`, as its own runs' do. A run takes under a minute. It issues its own credentials, kept in memory and never written to `.env`, and covers:
- a proposed rebalance executed once with the owner's confirmation, and refused when executed again;
- a swap the agent refuses to plan (`refused`, exit 2);
- scope refusals;
- a sweep that shields a public balance (`fundPublic`);
- an outage of the agent's provider (`setUnavailable` on `portfolio`), which the gateway answers with `forbidden`;
- last, a lost swap reply (`dropSwapResponse`): `execute` exits 3, reads the records, and the swap was applied once and not resent. The operation stays unresolved until the owner's `recover`, which leaves that stack blocked; it's stopped afterwards anyway.

`test/commands.test.ts` covers the same outcomes with a faked client (`provider`, `unavailable`, `unknown`: their exit codes, and that `unknown` reads `unresolved` and `activity` and never resends). It also covers every row of the execution mapping above: rejected before any leg, rejected after a leg, `FAILED`/`REFUNDED` legs, unsettled legs and shields, sweep shields, a lost preview, a throw mid-stream, and usage errors. `test/stack-credential.test.ts` runs the credential script against a fake stack directory.

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

CI (`.github/workflows/ci.yml`) runs typecheck, the unit tests and the build for both packages on every pull request and push to `main`, then both stack tests on a stack from the platform at 1a7fe98. It needs `../platform` (or `TREASURY_PLATFORM`) at 1a7fe98 with its dependencies installed, as the CLI's stack test does.
