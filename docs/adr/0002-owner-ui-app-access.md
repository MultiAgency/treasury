# 2. Move owner pages behind the Treasury app server

**Status:** accepted, 2026-11-05. The first steps landed in #118 (owner reads and a read-only portfolio through the app server). SDK 0.5.1 settles platform#17: the table below is the 0.5.0 inventory, and the upgrade rewrites it.

Replaces the production destination in [ADR 1](0001-owner-session-and-app-server.md). Keep the existing owner-session build as the simulated-stack reference until its replacement passes equivalent workflows.

## Target architecture

The Treasury app server serves owner pages and proposals from one origin. Its existing wallet sign-in, session, per-agent ownership checks and DAO membership checks gate every API route. Only the server calls `/apps/v1`; deployment credentials never reach browser code. The browser uses the existing server session rather than the platform's `/gw/*` session.

Add explicit, schema-checked endpoints per supported workflow, each checking the required member permission and platform consent. Connecting an agent must not silently add consent scopes. The existing proposals connection requests only `read` and `treasury`; wallet owner actions need an explicit consent change for `owner`, and deposit needs `payout`. DAO consent cannot include those scopes in SDK 0.5.0. SDK 0.5.1 puts `deposit` in the `treasury` scope, so funding needs no `payout` consent, for wallet and DAO owners alike.

Wallet NEP-366 actions open the platform's confirm page and follow their status. DAO owner actions use the SDK's DAO preparation/vote flow. Neither uses the owner-session submit flow as a generic replacement. Actions and streams remain single-attempt; follow an interrupted action with observations rather than replaying it.

## Verified contract gaps

Run `pnpm --filter @treasury/web audit:app-access` to inventory current literal `.read`, `.act` and `.stream` call sites against the installed SDK's scope rules. This is a source inventory, not proof that every flow works; dynamic calls and gateway routes require separate review. A unit test tracks the unsupported procedure set so an SDK or UI change triggers a migration review.

At SDK 0.5.0, seven procedures used by the owner UI are absent from every app scope:

| Procedure | Required treatment |
| --- | --- |
| `setup` | Replace with identity, instance and overview after the missing agent wallet and executor-held grant ID have a supported observation. Never infer the held grant from the grants list. Grant adoption is also a platform concern. |
| `recover` | Replace the manual trigger in the app-access UI with reads of `unresolved` while the platform reconciles automatically, as decided in platform#14. |
| `reconcileBooks` | Await the platform's read-scope decision; ledger records cannot substitute for independent reconciliation evidence. |
| `treasury/link`, `treasury/unlink`, `treasury/setConfidential`, `treasury/fund` | Await explicit scope and DAO authorization decisions. |

The planned Runs/manual-rebalance/steward work additionally needs decisions for `autopilot/tick` and `steward/propose`, and explicit `treasury-execute` consent for execution without per-swap signatures. Creation uses app `setup` or `daoSetups`, followed by wallet confirmation or a DAO vote, rather than `/gw/agents`.

Sources checked on 2026-11-04: [platform#14 decision](https://github.com/MultiAgency/platform/issues/14), [platform#17 open contract decisions](https://github.com/MultiAgency/platform/issues/17), and the installed SDK's exported scope definitions. The SDK is the executable contract.

## Implementation order and acceptance

1. Resolve frame observations and scope decisions in the platform; publish the SDK and update this repository's SDK/stack pin together.
2. Add explicit owner observation endpoints. Test ownership transfer, DAO roles, cross-organization isolation, missing consent and malformed upstream responses. Consolidate page reads to respect the deployment's shared 1,200-call hourly allowance.
3. Move browser discovery and owner reads to the server session. Preserve retained-record recovery and clear private caches when account or access changes.
4. Port owner actions, strategy and funding with consent review and wallet-confirm/DAO-vote outcomes. Required workflows must be supported before declaring the migration complete.
5. Finish rebalance, Runs, creation and the walkthrough against app access.
6. Run unit checks, both builds, server stack tests and browser stack tests. Require equivalent keyboard paths, accessibility checks, unknown-outcome handling and owner/DAO isolation before retiring the reference build.

Completion means these workflows pass through app access on the simulated stack. Deployment and live settlement verification are separate milestones.
