# Treasury and the MultiAgency SDK

What the Treasury app needs from `@multiagency/sdk` and the platform, how each need is handled today, and what would improve the SDK from here.

Reviewed against SDK 0.5.0 and platform `6ba0831` on 4 November 2026, describing merged Treasury work through #109; held work from #104 is identified separately. Sections 3.1, 3.2, 3.3, 3.5 and 3.6 were rechecked on 5 November 2026 against SDK 0.5.1 (pinned since #119), the platform at `c671872`, and merged work through #143. On 9 November 2026 three rows of 3.2 were brought up to date (emergency stop, the floor in the signed policy, staging access); the rest isn't rechecked against SDK 0.5.4. Host availability is an operator check, not a guarantee from this SDK pin.

## Summary

The Treasury app (owner UI in `web/`, app server in `apps/server/`, engines in `packages/core/`) runs on `@multiagency/sdk` 0.5.1 (#119). Upgrading from 0.4.1 to 0.5.0 needed no code changes beyond the version and the platform pin (PR #97).

The engines in `packages/core` don't use the SDK at all. They are pure decision logic: oracle, bands, sizing, anti-whipsaw, policy, levels, detectors, replay and mandate. The SDK matters where those decisions meet the platform: proposals, owner signatures, consents, reads and execution.

**Three things decide where the app can go next:**

1. **Owner UIs are moving to the app route.** The platform answered on platform#14: owner UIs move to `/apps/v1`, and the owner session gets no production host. Several procedures the owner UI uses have no app-route version yet (section 3.1).
2. **DAO-owned treasuries.** 0.5.0 adds DAO consents, votes and setups. The app server now supports DAO-owned agents (#20) against the SDK types, with the implementation merged in #109 and simulated-stack coverage. Confirm deployment availability with the operator; the file calls have no idempotency key (section 3.4).
3. **Limits the signed policy can't express.** Venue exposure and the cash floor are enforced app-side only. They can refuse a trade the platform would allow, but nothing outside this app enforces them.

Against the plan's four proposed procedures, the app route already has ledger export, and partly has DCA schedules, approval gates and an emergency stop (section 3.6).

## 1. How the app uses the SDK

| Part | Client | What it does through the SDK |
|---|---|---|
| Owner UI (`web/`) | `ownerClient` on the owner session (`/gw`) | Session and access, reads (overview, holdings, strategy, activity, inbox), owner actions prepared for the wallet to sign, plan execution streams |
| Proposals page (`web/src/proposals`) | none (calls the app server only) | Shows the owner's proposals; signs the exact `proposalText` in the wallet |
| App server (`apps/server/`) | `appClient` on `/apps/v1` with the deployment's `tap_` credential | Identity, consents, proposals (create, read, list, approve, reject, execute), the `watch` proposer, DAO consents and votes |
| Engines (`packages/core/`) | none | Pure logic; #60 supplies raw-unit proposal legs. Calling the engine from watch also needs prices, history, state and policy-context integration |

## 2. SDK changes the app needed, and how each was resolved

| # | Need | Resolution | Status |
|---|---|---|---|
| 2.1 | SDK 0.5.0 (DAO flows, fixes) | Upgraded in PR #97 with the platform pin moved to `6ba0831`. Typecheck and all tests pass. | Resolved |
| 2.2 | "token" means an asset in the SDK (`PROPOSAL_TOKENS`, `tokenAmount`), but the audit store refused any field named like `token` as a credential | The audit store now names credentials exactly (`sessionToken`, `accessToken`, `apiKey`, `mnemonic`, `seedPhrase`, …), so `token`, `tokenIn` and `seed` record (#90) | Resolved in this app |
| 2.3 | Platform policy digest and owner signing for the mandate | The platform computes the mandate digest; the owner signs policy edits in the wallet (#59 closed as covered by the platform). A9.1 compiles answers to that policy plus app-side limits | Resolved by the platform |
| 2.4 | A bad NEP-413 signature reaches the SDK as a lost answer (the gateway's 400 isn't a typed refusal) | The app server verifies NEP-413 locally before relaying (`apps/server/src/http.ts`) and classifies refusals by status | Workaround in this app |
| 2.5 | A gateway 4xx comes back from the SDK as `unknown`; 429 isn't its own kind (platform#15) | `watch` treats `unknown` with HTTP 429 as a rate limit and backs off; other 4xx are treated as bugs and stop the agent | Workaround in this app |
| 2.6 | 1,200 calls an hour per deployment, shared by every owner and `watch` | Identity answers cached 60 s; `watch` refuses to start past half the budget; owner requests rate-limited per account | Workaround in this app |
| 2.7 | Organization ids can't contain dots, but NEAR accounts do | The Organization is the owner's account with `.` written as `--` (`apps/server/src/consent.ts`) | Workaround in this app |
| 2.8 | `selfServiceTreasury` isn't in `gatewayDiscovery` | Read as a local extension of the discovery answer (`web/src/platform.ts`) | Workaround in this app |
| 2.9 | Gateway 401/403 denials need classifying before `ownerClient` sees them | Classified in `web/src/platform.ts` | Workaround in this app |
| 2.10 | Engine intents and platform proposals both called "proposal" | The engine's output is now an `Intent` (#63); a platform proposal stays a proposal | Resolved in this app |

## 3. What the app still needs from the SDK or the platform

### 3.1 App-route versions of owner-session procedures

Owner UIs move to `/apps/v1` (platform#14). The procedures below need an app-route equivalent or an explicit replacement; platform#17 tracks that decision. Hosted creation already has a different app-route API.

| Procedure | Used by | Today |
|---|---|---|
| `setup` (identity, instance, overview fields) | owner UI frame | owner session only |
| `reconcileBooks` | portfolio | On the app route since 0.5.1 (`read`); the app server reads it |
| `treasury/link`, `unlink` | funding page | On the app route since 0.5.1 (`treasury`, wallet owners only); the proposals page uses them (#121). `setConfidential` is gone in 0.5.5: `treasury/get` reads it from chain (platform#41) |
| `treasury/fund` | funding page | Owner session only; on the app route, `deposit` and the SDK's `fundingTransaction` fund the agent instead (#121) |
| `autopilot/tick` ("Run now") | automations (#7) | On the app route since 0.5.1 (`treasury`); the proposals page's Run now uses it (#126) |
| `steward/propose` | steward page (#7) | owner session only |
| `inbox/list`, `inbox/dismiss` | attention inbox (#7) | owner session only |
| `/gw/agents`, `/gw/treasuries` | Treasury creation (#12) | Replaced: creation runs on `/apps/v1/setup` and `/apps/v1/dao-setups` (#117) |

### 3.2 Needs to confirm against the platform and deployment

| Gap | Why the app needs it | Issue |
|---|---|---|
| Approving a held withdrawal to a NEAR account | Still reject-only at `c671872`: "approving a held withdrawal isn't available yet: its approval can't be verified" (the platform's `src/payment-approval.ts`). A candidate for #62's contracts | #62 |
| Emergency-stop requirements | Settled by ADR 3: the freeze meets A14. A wallet owner freezes from the app (#133); a DAO's freeze vote must pass within the intent's minutes | #95, platform#20 |
| Venue exposure and cash floor in the signed policy | Venue exposure is enforced app-side only; the platform would allow a trade it refuses. The cash floor is the platform's since SDK 0.5.3, in the strategy (`cashFloor`), and this app doesn't set it yet | #49, #62, platform#23 |
| Treasury setup on production and the simulated stack | Creation runs through the app server (#117), but at `c671872` only staging offers the `treasury` area; production and the stack offer payables only | #12 |
| Staging access and production readiness | Staging is granted (#95): its host, the `multiagency-treasury` deployment and its network. Production readiness is still to confirm; SDK support does not establish access | #95 |
| Budget visibility, `Retry-After`, and typed 429 | A shared deployment limit already exists (1,200 calls/hour); explicit budget and backoff signals are missing | platform#15 |
| The consent cap counts revoked consents | A user who reconnects often can be locked out | #20 threat model |
| Venue holdings and quoted slippage in reads | The policy needs venue exposure and slippage against the oracle median | A10.1 (#60) |

### 3.3 New in 0.5.0 and now used

| 0.5.0 feature | Where the app uses it |
|---|---|
| `identity.signer` | The app server tells a DAO-owned agent from a wallet-owned one and routes each to its own flow (#20) |
| `accessOf`, `mayCall` | Members are gated by role against the DAO's on-chain policy, read and cached by the server |
| `app.daoConsents` | The server files the DAO's consent and follows it by state until the vote passes |
| `app.daoVotes` | Approve and reject become DAO votes, with the platform's `/confirm/dao/<hash>` link for voters |
| `app.daoSetups`, `owner/prepare` with `signer: "dao"` | A DAO's setup is filed for its vote and completed when it passes (#117); production and the stack don't offer the `treasury` area yet |
| `appClient(...).stream` for `sweep`, `rebalance`, `executePlan` | `sweep` on the proposals page, answered as its AG-UI run (#122); `rebalance` and `executePlan` aren't used: they need `treasury-execute` |

### 3.4 Gaps found while building DAO agents

| Gap | Effect today | Suggested SDK change |
|---|---|---|
| `daoConsents.file` and `daoVotes.file` take no request id | A lost file reply can leave a request whose id is unknown. #109 persists known requests and blocks uncertain filing; it does not make blind retries safe | An idempotency key on `file`, as `proposals/create` has |
| No list of an app's DAO requests | The server must persist every request id itself, or a restart forgets open votes | `daoConsents.list` and `daoVotes.list` by organization, agent and proposal |
| `mayCall` has no entry for filing a consent or vote, or for revoking an app's consent | #109 records the explicit member permission mapping; DAO-member disconnect is not offered | Named rules for these app-level actions |
| The skill text names `permits`, the example uses `mayCall` | Ambiguity about which to use | One name in docs and code |
| Reading a DAO request's state is also what relays it | The audit rule "record before the platform is asked" doesn't fit; the relay is recorded only as a result | A separate relay call, or a state read without side effects |
| DAO answers' HTTP statuses (404, 409, 410; 403, 409, 429 on file) are documented in prose only | The app maps them to gone, ended, expired by guesswork | Typed refusal kinds for DAO answers |
| `daoConsents.state` returns no `request` when `signed`; transaction actions are typed as loose `params` | The server answers from its own copy, and casts actions for the wallet | Complete, typed wire types |
| The voter check link is only inside `description` | The server rebuilds it from host and hash; the page refuses any other link | A typed `checkUrl` field |
| No DAO policy reader in the SDK | Each app calls the DAO's `get_policy` through its own RPC | A `daoPolicy(account)` read |
| Deployment availability | #109 includes simulated-stack coverage; a real deployment and network still need operator confirmation | Staging verification |

### 3.5 Findings from the held owner-UI work in #104

| Gap | Effect today |
|---|---|
| `autopilot/tick` takes no input and returns no id | After a lost answer nothing links the attempt to a recorded run, so Run now is only held back for as long as the page is open, plus while a run or unresolved operation is visible. The merged proposals page's Run now (#126) has the same limit: a lost answer is never sent again from there |
| `steward/propose` and `inbox/*` exist only on the owner session (`autopilot/tick` reached the app route in 0.5.1); `rebalance` and `executePlan` reach the app route only under `treasury-execute` | Moving owner UIs to `/apps/v1` (platform#14) means reworking the steward, runs and attention pages |

### 3.6 The plan's proposed procedures (#62)

The plan proposes new procedures for four needs, as #62 quotes it; the task card itself (Ballast's `docs/TASKS.md`) hasn't been received. Each against SDK 0.5.1 on the app route and the platform at `c671872`:

| Plan's procedure | What the app route offers | Status | What's left |
|---|---|---|---|
| Adaptive DCA strategy schemas | `strategy/save` takes target weights, a minimum leg, a cost limit, and the autopilot's interval and auto-execute ceiling (the platform's `src/strategy-digest.ts`); nothing for bands, DCA units or anti-whipsaw. The app can carry its own: `proposals/create` takes the app's legs, and `externalPlan` (with `treasury-execute`) runs an app-built plan within the policy, the cost limit and a grant binding the strategy | Partly | Ballast's band, DCA and whipsaw state stays in `packages/core` and reaches the platform as proposal legs (#60's `legsFor`). A new procedure is needed only if the owner must sign the DCA schedule itself |
| Escalation and approval gates | A proposal's swaps run only after the owner's wallet signs its exact text, or the DAO votes. The autopilot executes alone only up to the strategy's `autopilot.maxUsd`, under a grant binding it; 0 leaves every autopilot swap to the owner. A payout is held for a wallet owner's vote (`approval_vote`) when the policy sets `owner_approval` | Partly | The `maxUsd` ceiling applies to autopilot runs only: with `treasury-execute`, an app's `rebalance`, `externalPlan` and `executePlan` swap without a signature and without an amount ceiling, within the policy and the cost limit (the platform's `src/authorize.ts`). `owner_approval` holds every payout or none (`src/policy.ts`), so a hold only above an amount can't be expressed. A DAO can't vote on a held payout through an app (`DAO_APP_ACTIONS` has no `approval_vote`). Telling the owner a decision waits is the app's job (#131) |
| Emergency-stop orchestration | `autopilot/stop` at once, with no signature. Freeze through `owner/prepare`, effective once the owner's wallet signs on the confirm page, or the DAO's vote passes, before the intent expires. The DAO stop page, done by the DAO's vote, ends every app's consent and turns autopilot off | Partly | **Wallet owner:** after `autopilot/stop`, swaps still go out through Run now, autopilot turned on again, another app's `executePlan`, and approved proposals; freeze stops every send, once signed within minutes (#133). **DAO:** the stop ends those app paths but doesn't freeze or revoke the grant, and a freeze needs the DAO's vote within the same minutes, impractical for most DAOs (platform#20). Details in #95; section 4, item 7 |
| Ledger export | `ledger`, `ledgerCsv`, `reconcileBooks`, `activity` and `paymentHistory`, app-route reads under `read` | Have | Nothing new |

[ADR 4](adr/0004-platform-extensions.md) settles these: no new procedures or contracts, and one refinement to the cash floor already planned on MultiAgency/platform#23. The payout gaps (a hold above an amount, a DAO's vote on a held payout, approving a held withdrawal) are real for payout agents, not for a Treasury agent, which makes no payouts.

## 4. Improvements to the SDK going forward

Ordered by how much they would remove from this app.

1. **Typed refusals everywhere.** Return every gateway 4xx as a refused result with a stable code (bad signature, expired, rate limited with `Retry-After`) instead of `unknown`. That removes this app's local NEP-413 check and its status-code guessing (2.4, 2.5).
2. **One owner surface.** Publish the app-route procedures in 3.1, or state which ones won't come, so owner UIs can move to `/apps/v1` without losing pages.
3. **Policy fields for app-side limits.** Venue exposure caps and a cash floor in the signed owner policy. The platform would then refuse what Ballast refuses, and the app-side checks become a second line instead of the only one.
4. **A budget-aware client.** Expose the deployment's remaining call budget, or a client-side limiter that shares it across processes, instead of each app estimating it.
5. **Reads the engines need.** Venue-level holdings, quoted slippage, rolling 24 h turnover and orders in the last hour as typed reads. These would feed the policy engine without app-side counters.
6. **Proposal legs from intents.** A helper that turns a sized intent (asset, side, USD size) into proposal legs in raw units with the token's decimals. This would make A10.1 a thin mapping.
7. **Emergency stop.** A freeze that takes effect at once and is confirmed afterwards, with its own audit event.
8. **Discovery flags in the schema.** Move `selfServiceTreasury` and similar flags into `gatewayDiscovery`'s typed answer.
9. **Organization ids that accept NEAR accounts.** Allow dots, or ship the mapping, so every app maps owners the same way.
10. **Idempotent, listable DAO requests.** A request id on `daoConsents.file` and `daoVotes.file`, a list by organization, agent and proposal, and a state read that doesn't relay (3.4).
11. **Run ids for `autopilot/tick`.** Accept a request id and return the run it started, so a lost answer can be followed instead of guessed (3.5).
12. **Test fixtures.** Publish the simulated stack's controls (fund, drop a response, sign as owner) as a supported package, with a documented way to let a developer's own wallet key own a local agent. Today that needs a local patch to the platform's test provider.

## 5. Delivery boundaries

Issue status and acceptance evidence belong on the issues, rather than in a snapshot of #104's branch.

- #60 is the pure conversion from an engine intent to exact raw-unit proposal legs. #61 adds owner reads and request recovery. Neither alone wires the Ballast engine into watch.
- Engine integration still needs decisions about oracle sources and history, persistent band/whipsaw/DCA state, policy context, and where the owner selects Ballast.
- The running server records through the hash-chained audit store, and anchors its head hourly on FastData KV (#55), with the decision and the key's threat model on #55. Every Ballast decision is recorded there with its inputs, and `check:replay` replays them (#54).
- Owner-UI additions from #104 remain held while the app-route decision is settled. Creation (#12) should use the existing app setup API, with Treasury support added to the stack for end-to-end coverage.
- History examples remain synthetic until H5 supplies data; mandate defaults and sleeve labels remain unapproved pending H8/H6.

## Appendix: running the app locally

Follow the current README and `web/PLATFORM-SESSION.md` for the pinned platform stack, owner UI and proposals page. Use the stack's supplied owner wallet; signing in with another real wallet is not a supported fixture at this pin. No local platform patch is required for the documented tests.
