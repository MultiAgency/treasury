# 2. Move owner pages behind the Treasury app server

**Status:** accepted, 2026-11-05. The first steps landed in #118 (owner reads and a read-only portfolio through the app server). SDK 0.5.1 answers platform#17; the gaps below are as of 0.5.1.

Replaces the production destination in [ADR 1](0001-owner-session-and-app-server.md). Keep the existing owner-session build as the simulated-stack reference until its replacement passes equivalent workflows.

## Target architecture

The Treasury app server serves owner pages and proposals from one origin. Its existing wallet sign-in, session, per-agent ownership checks and DAO membership checks gate every API route. Only the server calls `/apps/v1`; deployment credentials never reach browser code. The browser uses the existing server session rather than the platform's `/gw/*` session.

Add explicit, schema-checked endpoints per supported workflow, each checking the required member permission and platform consent. Connecting an agent must not silently add consent scopes. The existing proposals connection requests only `read` and `treasury`, which covers funding (`deposit`) for wallet and DAO owners alike. Wallet owner actions need an explicit consent change for `owner`, which a DAO's consent can't include.

Wallet NEP-366 actions open the platform's confirm page and follow their status. DAO owner actions use the SDK's DAO preparation/vote flow. Neither uses the owner-session submit flow as a generic replacement. Actions and streams remain single-attempt; follow an interrupted action with observations rather than replaying it.

## Verified contract gaps

Run `pnpm --filter @treasury/web audit:app-access` to inventory current literal `.read`, `.act` and `.stream` call sites against the installed SDK's scope rules. This is a source inventory, not proof that every flow works; dynamic calls and gateway routes require separate review. A unit test tracks the unsupported procedure set so an SDK or UI change triggers a migration review.

At SDK 0.5.1, `reconcileBooks` is under `read`. Three procedures the owner UI uses are absent from every app scope, and a DAO's consent is refused three more:

| Procedure | Required treatment |
| --- | --- |
| `setup` | Read `account` (`read`): the agent's wallet, the grant its executor holds and any staged grant, matched by the token, never inferred from the grants list. Owner and signer come from `GET /apps/v1/agents/<agent>`. It adopts nothing: a staged grant takes effect once its owner action settles. |
| `recover` | Remove the manual trigger and follow `unresolved`, which the platform reconciles on its own (platform#14). After a lost reply, read the action's own record; never resend while it's unknown. |
| `treasury/fund` | `deposit` (`treasury`) for the address, then the SDK's `fundingTransaction()`: the owner's wallet sends it, or a DAO member files the same calls as one proposal. |
| `treasury/link`, `treasury/unlink`, `treasury/setConfidential` | Under `treasury` for wallet owners. Refused under a DAO's consent: a DAO agent's link is the DAO, fixed at setup, so its page hides the controls. |

Run now is `autopilot/tick` under `treasury`; offer it only when the held grant binds the saved strategy, or the tick swaps nothing. Suggested swaps come from Treasury's own agent through `proposals/create`; `steward/propose` stays off app access. Execution without per-swap signatures needs explicit `treasury-execute` consent. Creation uses app `setup` or `daoSetups`, followed by wallet confirmation or a DAO vote, rather than `/gw/agents`.

Sources checked on 2026-11-05: [platform#14 decision](https://github.com/MultiAgency/platform/issues/14), [platform#17](https://github.com/MultiAgency/platform/issues/17) as answered by SDK 0.5.1 (platform `2223d11`), and the installed SDK's exported scope definitions. The SDK is the executable contract.

## Implementation order and acceptance

1. Platform decisions, the SDK and this repository's SDK/stack pin: done with 0.5.1. The hosts answer these procedures only once the platform deploys that code.
2. Add explicit owner observation endpoints. Test ownership transfer, DAO roles, cross-organization isolation, missing consent and malformed upstream responses. Consolidate page reads to respect the deployment's shared 1,200-call hourly allowance.
3. Move browser discovery and owner reads to the server session. Preserve retained-record recovery and clear private caches when account or access changes.
4. Port owner actions, strategy and funding with consent review and wallet-confirm/DAO-vote outcomes. Required workflows must be supported before declaring the migration complete.
5. Finish rebalance, Runs, creation and the walkthrough against app access.
6. Run unit checks, both builds, server stack tests and browser stack tests. Require equivalent keyboard paths, accessibility checks, unknown-outcome handling and owner/DAO isolation before retiring the reference build.

Completion means these workflows pass through app access on the simulated stack. Deployment and live settlement verification are separate milestones.
