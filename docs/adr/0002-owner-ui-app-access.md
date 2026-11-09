# 2. Move owner pages behind the Treasury app server

**Status:** accepted, 2026-11-05; completed: the owner pages run through the app server (#128), and the owner-session reference build was retired (#189). SDK 0.5.1 answers platform#17; the gaps below were checked at 0.5.1.

Replaces the production destination in [ADR 1](0001-owner-session-and-app-server.md). The owner-session build was kept as the simulated-stack reference until its replacement passed equivalent workflows, then retired (#189).

## Target architecture

The Treasury app server serves owner pages and proposals from one origin. Its existing wallet sign-in, session, per-agent ownership checks and DAO membership checks gate every API route. Only the server calls `/apps/v1`; deployment credentials never reach browser code. The browser uses the existing server session rather than the platform's `/gw/*` session.

Add explicit, schema-checked endpoints per supported workflow, each checking the required member permission and platform consent. Connecting an agent must not silently add consent scopes. The existing proposals connection requests only `read` and `treasury`, which covers funding (`deposit`) for wallet and DAO owners alike. Wallet owner actions need an explicit consent change for `owner`, which a DAO's consent can't include.

Wallet NEP-366 actions open the platform's confirm page and follow their status. DAO owner actions use the SDK's DAO preparation/vote flow. Neither uses the owner-session submit flow as a generic replacement. Actions and streams remain single-attempt; follow an interrupted action with observations rather than replaying it.

## Verified contract gaps

At SDK 0.5.1, `reconcileBooks` is under `read`. Three procedures the owner UI uses are absent from every app scope, and a DAO's consent is refused three more:

| Procedure | Required treatment |
| --- | --- |
| `setup` | Read `account` (`read`): the agent's wallet, the grant its executor holds and any staged grant, matched by the token, never inferred from the grants list. Owner and signer come from `GET /apps/v1/agents/<agent>`. It adopts nothing: a staged grant takes effect once its owner action settles. |
| `recover` | Remove the manual trigger and follow `unresolved`, which the platform reconciles on its own (platform#14). After a lost reply, read the action's own record; never resend while it's unknown. |
| `treasury/fund` | `deposit` (`treasury`) for the address, then the SDK's `fundingTransaction()`: the owner's wallet sends it, or a DAO member files the same calls as one proposal. |
| `treasury/link`, `treasury/unlink`, `treasury/setConfidential` | Under `treasury` for wallet owners. Refused under a DAO's consent: a DAO agent's link is the DAO, fixed at setup, so its page hides the controls. (`treasury/setConfidential` is no longer used: the platform reads confidentiality from chain, #223.) |

Run now is `autopilot/tick` under `treasury`; offer it only when the held grant binds the saved strategy, or the tick swaps nothing. Suggested swaps come from Treasury's own agent through `proposals/create`; `steward/propose` stays off app access. Execution without per-swap signatures needs explicit `treasury-execute` consent. Creation uses app `setup` or `daoSetups`, followed by wallet confirmation or a DAO vote, rather than `/gw/agents`.

Sources checked on 2026-11-05: [platform#14 decision](https://github.com/MultiAgency/platform/issues/14), [platform#17](https://github.com/MultiAgency/platform/issues/17) as answered by SDK 0.5.1 (platform `2223d11`), and the installed SDK's exported scope definitions. The SDK is the executable contract.

## Acceptance

Met on the simulated stack before the reference build was retired (#189): the workflows run through app access, with equivalent keyboard paths, accessibility checks, unknown-outcome handling and owner/DAO isolation. Deployment and live settlement verification are separate milestones.

## What would reopen it

- **The shared allowance can't carry the pages.** Every owner read goes through the deployment's one credential, 1,200 calls an hour shared by all of its owners (MultiAgency/platform#15).
- **The platform offers owners a browser route of their own** with the procedures the pages use, so the server would no longer need to relay owner reads.
- **An owner workflow app access can't carry,** neither through the confirm page nor a DAO's vote.
