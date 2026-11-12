# Treasury and the MultiAgency SDK

**Final combined compatibility update, 12 November 2026:** this isolated branch repins to the exact combined SDK 0.5.9 artifact at platform source `252cba1`. See [current pins, fresh validation and limitations](sdk-final-compatibility.md). The [earlier development receipt](sdk-compatibility.md) remains historical; neither its pins nor the 0.5.5 review below describe this branch’s current dependencies.

What the Treasury app needs from `@multiagency/sdk` and the platform, how each need is handled today, and what remains to improve.

Rechecked on 10 November 2026 against SDK **0.5.5**, pinned platform [`2e7b1e6`](https://github.com/MultiAgency/platform/tree/2e7b1e6f231da5be62d077d67f7bc2686c57bdc9), and Treasury's current SDK integration. Run now recovery below also reflects the page-lifetime guard in `web/src/run-now-guard.ts`. This replaces the report's 0.5.0/0.5.1 snapshot and its partial 0.5.4 updates. Paths beginning `platform/` refer to that platform commit. Host availability and live settlement are operator checks, not guarantees from the SDK pin or simulated tests.

## Summary

Treasury pins `@multiagency/sdk` 0.5.5 in both the app server and web package (#235). It has one browser app, `web/src/`, which calls its own app server. The owner-session reference build was retired in #189; it is no longer held work awaiting an app-route migration ([ADR 2](adr/0002-owner-ui-app-access.md)).

The engines in `packages/core` do not use the SDK. Ballast already runs through `watch`, with persistent history and decision state, policy checks and proposal legs. SDK integration is the boundary between those decisions and the platform's consents, reads, owner actions, proposals and execution.

Three distinctions matter for the remaining work:

1. **App access is implemented.** The server uses `appClient` on `/apps/v1`; wallet owners sign exact texts or use the platform's confirm page, and DAO members file transactions for votes. New wallet-owner consents include `read`, `treasury` and `owner`; DAO consent excludes `owner`. Treasury asks for neither `payout` nor `treasury-execute`.
2. **The platform executor enforces a saved cash floor; venue exposure is app-side.** SDK 0.5.3 added `strategy.cashFloor`, checked by the executor rather than a provider policy field. Treasury carries the mandate's floor through adopted strategy proposals (#236), but `overview` still omits it, so matching allocations can prevent a floor-only proposal (3.2).
3. **Implementation, simulated acceptance and live readiness are different evidence.** Wallet and DAO flows run on the pinned simulated stack. Production availability remains host-specific. H9 used real NEAR history, while stabilization and diversified-book backtest reports remain synthetic and do not establish live performance (section 5).

## 1. How the app uses the SDK

| Part | Client | What it does through the SDK |
|---|---|---|
| Browser app (`web/src/`) | No SDK network client; same-origin `/api/` calls through `server-api.ts` | Parses app-server answers and uses SDK schemas, signing text and funding helpers; the wallet signs the reviewed text or transaction |
| App server (`apps/server/`) | `appClient` on `/apps/v1` with the deployment's `tap_` credential | Identity, setup, consents, owner reads/actions, strategy and autopilot, funding, proposals and their execution, DAO coordination |
| `watch` and Ballast integration | The server's platform wrapper over `appClient` | Reads the book and strategy, evaluates the engine, records decisions and creates proposals with exact raw-unit legs |
| Engines (`packages/core/`) | None | Pure oracle, bands, sizing, whipsaw, policy, levels, detectors, mandate, risk, multi-sleeve evaluation and replay logic |

## 2. SDK changes the app needed, and how each was resolved

Historical needs remain here to distinguish shipped support from remaining app protections.

| # | Need | Resolution | Status |
|---|---|---|---|
| 2.1 | SDK and simulated-platform compatibility | SDK 0.5.0 landed in #97; the current 0.5.5 package and platform pin landed together in #235 | Resolved at this pin |
| 2.2 | Asset fields such as `token`, `tokenIn` and `seed` were mistaken for credentials by the audit store | The audit store names credentials exactly (`sessionToken`, `accessToken`, `apiKey`, `mnemonic`, `seedPhrase`, …), preserving asset fields (#90) | Resolved in this app |
| 2.3 | Policy digest and owner signing for the mandate | The platform computes the mandate digest and prepares owner-signed policy edits. A9.1 compiles the mandate; its strategy floor is saved through adopted proposals (#236) | Implemented; floor visibility gap in 3.2 |
| 2.4 | A coded gateway signature refusal could appear as a lost answer | Since SDK 0.5.3, coded gateway 4xx denials such as `signature_invalid` are typed refusals. Treasury keeps local exact-text, account and NEP-413 verification before relaying (`apps/server/src/http.ts`) | SDK support shipped; local protection retained |
| 2.5 | A gateway 429 lacked its own result kind and backoff value (platform#15) | Since 0.5.2, the gateway's JSON 429 is `rate_limited`, with optional `retryAfterSeconds` from `Retry-After`. `watch` handles it and retains legacy HTTP-429 fallback. Uncoded proxy/transport failures can still be ambiguous; a mutation's unknown outcome is not a proven refusal | Resolved for typed gateway rate limits |
| 2.6 | Owners and `watch` share the server's credential allowance | The platform defaults to 1,200 requests/hour **per credential**, operator-adjustable up to 12,000. Treasury caches successful identity reads, rate-limits owner requests and limits watch's estimated load to half the default allowance | App safeguards; budget visibility remains missing |
| 2.7 | Organization ids cannot contain dots, but NEAR accounts do | The Organization is the owner's account with `.` written as `--` (`apps/server/src/consent.ts`) | Workaround in this app |
| 2.8 | The old browser needed an untyped `selfServiceTreasury` discovery flag | That consumer and `web/src/platform.ts` were retired in #189. SDK discovery now exposes `setupAreas` and `selfService`; the current app uses its server's setup routes | Historical workaround retired |
| 2.9 | The old browser classified gateway 401/403 before `ownerClient` | SDK gateway answers have `session`/`forbidden` kinds, and the current browser has no `ownerClient`. The app server maps SDK results to its own public contract | Historical workaround retired |
| 2.10 | Engine intents and platform proposals were both called proposal | The engine emits an `Intent` (#63); the server converts it into platform proposal legs | Resolved in this app |
| 2.11 | A consent signed before a wallet stop could be replayed afterwards | 0.5.5 adds platform-issued consent/setup nonces and `owner_stopped`; Treasury obtains a fresh nonce and asks for a new signature after that refusal (#235) | Implemented |
| 2.12 | Owner-action reads used different stage vocabularies | 0.5.5 adds optional `phase` to `owner/status`, `owner/pending` and `owner/actions`. Treasury prefers phase, falls back to legacy stage, and requires provider `SUCCESS` before claiming success (#237) | Implemented |

## 3. What the app still needs from the SDK or the platform

### 3.1 App-route versions and replacements for owner-session procedures

The app-route migration is complete. The aggregate owner RPC and hosted setup are different APIs; a missing owner RPC name does not necessarily mean an app workflow is missing.

| Procedure | Current app route or replacement | Remaining limitation |
|---|---|---|
| Owner RPC `setup` aggregate | The app uses identity and owner reads such as `account`, `overview` and `treasury/get`. `app.setup()` separately reserves a hosted agent | The aggregate itself is not an app procedure; current pages use the separate reads |
| `reconcileBooks` | App read since 0.5.1; used by Treasury | No missing app-route equivalent |
| `treasury/link`, `unlink` | App `treasury` procedures for wallet owners; used by the Funding page | A DAO agent's funding account is its DAO. `setConfidential` was removed in 0.5.5; `treasury/get` reads confidentiality from chain (platform#41) |
| `treasury/fund` | App `deposit` plus SDK `fundingTransaction`; the funding wallet or DAO sends the reviewed transaction | Funding-outcome recovery remains limited by the absence of a platform transfer record for this flow; see `web/PLATFORM-SESSION.md` |
| `autopilot/tick` | App `treasury` procedure since 0.5.1; used by Run now | No request/run id for recovering a particular attempt (3.5) |
| `steward/propose` | Removed from the platform and SDK in 0.5.5. An app's own agent proposes through `proposals/create`; `externalPlan` needs `treasury-execute` | Not a procedure awaiting an app-route version; Treasury uses signed proposals |
| `inbox/list`, `inbox/dismiss` | Remain owner-session procedures, absent from app scope lists | The current app derives Needs your decision from its available reads; it does not expose the prototype inbox |
| `/gw/agents`, `/gw/treasuries` | Hosted creation uses `/apps/v1/setup` or `/apps/v1/dao-setups`, followed by wallet confirmation or a DAO vote | Host enablement and app-specific end-to-end setup coverage are separate checks (3.2) |

### 3.2 Capabilities, remaining limits and deployment checks

| Capability or gap | Current evidence and remaining work | Reference |
|---|---|---|
| Approving a held withdrawal to a NEAR account | Shipped in SDK 0.5.5: the platform verifies `approval_vote` by recomputing the provider's request hash with `flow` `withdraw` and chain `near`; it refuses a different destination asset or fields outside those observed on mainnet (`platform/src/payment-approval.ts`). Offline- and stack-tested there, not mainnet-observed. Treasury makes no payouts and does not use it | #62, platform#42 |
| Emergency stop | ADR 3 accepts the owner's signed freeze for A14; Treasury exposes it. A DAO's freeze vote must still pass within the short intent window. Until then, stopping autopilot and Ballast does not freeze other apps | #95, platform#20 |
| Cash floor enforcement and visibility | Since 0.5.3, the platform executor checks the saved strategy's floor on plan-bound swaps (`platform/src/authorize.ts`); it is not a field in the provider's signed policy. Adopted mandate proposals carry it (#236), keeping the higher saved amount for the same asset set; different asset sets skip the proposal. `overview` omits `cashFloor`, so matching allocations can produce no proposal and install no floor. The editor preserves an existing floor; it is not a separate floor-setting control | #49, #62, platform#23; [ADR 4](adr/0004-platform-extensions.md) |
| Venue exposure | Enforced app-side. Treasury derives known-asset route/venue exposure from its registry and overview holdings (a holding counts at the account and at every bridge it crossed, including the Solana bridge); the platform does not supply a venue-balance breakdown or a signed portfolio-exposure cap | A10.1 (#60), #221 |
| Gold and other chains' assets as proposal assets | Not listed: `PROPOSAL_ASSETS` is wNEAR, USDC and ETH, so a proposal naming XAUT, BTC or SOL is refused. The hedge plan lists those moves blocked, with a live NEAR Intents quote, until the platform lists them | #221, #62 |
| Treasury setup and creation on the stack | The standard simulated app stack enables Treasury setup and supplies wallet/DAO Treasury agents. Treasury's dedicated hosted-wallet stack test now covers signed setup, readable NEP-413 creation, its owner signature and confirmed settlement, identity refresh and the separate connection consent. Browser recovery cases use intercepted creation routes. Full hosted DAO setup/creation remains covered upstream, while Treasury's DAO stack uses a precreated agent. A frontend demo host may narrow the allowed areas; none of these tests establish a live provider's signing form or live settlement | #12; `apps/server/test/hosted-setup.stack.e2e.ts`, `web/test/app.e2e.ts`, `platform/test/e2e/app-access.spec.mjs` |
| Staging access and production readiness | Staging access was recorded in #95. The pinned deployment configurations differ in enabled areas; neither the source configuration nor the SDK establishes a live host's current availability | #95; operator verification |
| Shared call-budget visibility | Typed 429 and `Retry-After` already exist. The remaining gap is the credential's available budget and coordination across owners, `watch` and server processes; a per-Organization limit is a separate request | platform#15, platform#59 |
| Consent capacity | Revoked and expired consents do **not** count toward the 1,024-live-consent cap (`platform/src/gateway/app-access.ts`). The old revoked-consent lockout claim is resolved; live-consent limits still apply | #20 threat model |
| Quote and policy-context reads | Ballast has no pre-proposal quote feed and passes no quoted-slippage value to its detector. Signed `minAmountOut` and platform quote/cost checks still constrain execution. Venue breakdown and richer rolling usage reads would reduce app-side derivation; execution-stream cost fields do not replace a quote-only read for this app | A10.1 (#60) |
| Provider-wide cumulative spending guarantees | The platform's own serialized-dispatch race tests pass offline. Atomic USD-budget and cumulative per-asset enforcement across other hosts or directly used grants still depend on unresolved provider evidence; they are not established by this app's tests | platform#6; `platform/docs/enforcement.md`, Spending limits under concurrency |

### 3.3 SDK capabilities now used

| Capability | Where Treasury uses it |
|---|---|
| `identity.signer`, `accessOf`, `mayCall` | Distinguishes wallet/DAO owners and gates member actions using the DAO policy the server reads from chain |
| `app.daoConsents`, `app.daoVotes`, `app.daoSetups` | Coordinates consent, proposal verdicts and setup through a member's transaction and the DAO's vote |
| `owner/prepare` with wallet or DAO signer | Prepares creation, freeze/unfreeze, grants/revocations and policy edits for the appropriate signing flow |
| Owner-action `phase` and provider status | Shared server/UI holds and polling; submitted actions stay held past signing expiry, while settlement alone never claims success (#237) |
| `consents.nonce()` | Consent and wallet setup text use a platform nonce; a stop invalidates an older nonce (#235) |
| `strategy/save`, `strategy/get`, `autopilot/*` | Saves the reviewed strategy, retains its floor, binds authorization to its digest, and controls the schedule/Run now |
| `appClient(...).stream` for `sweep` | Treasury follows the sweep's AG-UI events; it does not request `treasury-execute` for `rebalance` or `executePlan` |

### 3.4 Gaps and limits in DAO coordination

| Gap or limit | Effect today | Possible SDK improvement |
|---|---|---|
| Filing has no caller request id | A lost filing reply can leave an orphan platform request. SDK 0.5.5 documents retry as safe: only the returned transaction can be filed by a member, so a lost reply does not itself put a vote on chain. Orphans still consume request capacity; Treasury conservatively records filing uncertainty | Idempotency keys on consent/setup/vote filing to avoid orphan requests |
| No list of pending DAO requests | The app persists known ids to follow open votes. `reservations()` lists hosted agents, not DAO requests | Lists by Organization, agent and proposal |
| `mayCall` has no named rule for app-level filing or consent revocation | Treasury maps filing permissions to the relevant owner action; DAO-member disconnect is not offered. `permits` and `mayCall` already have distinct documented roles, rather than a naming ambiguity | Named app-level permission rules |
| Reading a request's state can relay it | Consent state can store consent, setup state can reserve an agent, and proposal-vote state can relay the verdict. Treasury audits the result of that settling read | Separate effectless read and relay operations |
| Refusal types are broad | `AppRouteResult` already has failure kinds, typed rate limits and optional refusal codes. Codes/statuses are not endpoint-specific exhaustive unions, so the app still maps them to its public contract | Endpoint-specific refusal unions where useful; preserve uncertainty for unproven mutation outcomes |
| Some terminal state answers omit the request | Signed consent and reserved setup answers omit `request`; the app keeps its copy. DAO filing transaction parameters remain loose, although owner-preparation transactions have fuller types | Complete typed state/request and transaction payloads |
| No typed voter check URL | The platform embeds its check URL in transaction descriptions; Treasury constructs the link from the validated host/hash | A `checkUrl` field |
| No SDK DAO-policy network reader | `DaoPolicy`, `accessOf` and `permits` are pure helpers. Treasury calls `get_policy` through its own RPC (`apps/server/src/dao.ts`) | A policy-reader helper if it would remove duplicated app code |

### 3.5 Prototype findings and current recovery limits

#104 was prototype work, not a second UI still waiting to ship. Its owner-session build was retired in #189. The current app's remaining recovery limits should be read separately from those historical pages.

| Finding | Current behavior and limit |
|---|---|
| `autopilot/tick` takes no input and returns a summary without an attempt/run id | Treasury claims a per-agent hold before sending. A lost, unavailable or unreadable reply retains it across navigation in the loaded app; a validated tick summary or proven refusal releases it. Turn off remains available while a tick is pending or unknown. The warning links to the agent's runs. No read can correlate this particular attempt, so refreshing reads or stopping the schedule does not clear an unknown hold. Reloads and other tabs do not retain it; durable recovery still needs a caller request id and returned run id (`web/src/run-now-guard.ts`) |
| The old steward and inbox pages lacked app-route equivalents | `steward/propose` is removed in 0.5.5; the current app's proposers use `proposals/create`. Inbox procedures remain owner-session-only, while the app derives its own decision list (3.1) |
| A funding transaction can lose its wallet answer | No platform funding-transfer record identifies that attempt. The current page retains its hold while loaded and explains the limit in `web/PLATFORM-SESSION.md` |
| The platform does not expose unsigned wallet-intent bytes for rereading | Treasury retains immutable creation-review bytes in a bounded memory cache and rechecks current identity, setup key and open action after the wallet connects. Cache loss after a server restart requires waiting for that unsigned intent's signing window to expire before preparing another; it does not release durable submitted holds or permit resubmission |

### 3.6 The plan's proposed procedures (#62)

The four procedure needs recorded in #62, assessed against SDK 0.5.5 and the app's current scopes:

| Plan's procedure | What already meets it | Remaining boundary |
|---|---|---|
| Adaptive DCA strategy schemas | Ballast's bands, DCA units and whipsaw state live in `packages/core`; `watch` sends their exact legs through `proposals/create`. The platform saves target weights, minimum leg, cost limit, autopilot settings and optional cash floor | No new procedure is needed for the current proposal flow. Signing a DCA schedule itself would be a different requirement |
| Escalation and approval gates | Ballast evaluates levels, records decisions and proposes through owner-approved swaps; DAO-owned proposals use votes. Autopilot runs under its binding grant and `maxUsd` ceiling | The ceiling applies only to autopilot, not `treasury-execute` plans. Treasury does not request that scope. For payout agents, an amount-only hold and a DAO's app-route vote on a held payout remain separate gaps |
| Emergency-stop orchestration | Stop autopilot immediately; a freeze refuses new sends once the signed freeze takes effect, after wallet confirmation or the DAO's vote. This meets the wallet-owner interpretation accepted in ADR 3 | A DAO still needs its vote within the intent's minutes (platform#20); stopping app access alone does not freeze the agent |
| Ledger export | `ledger`, `ledgerCsv`, `reconcileBooks`, `activity` and `paymentHistory` are app reads | No new procedure |

[ADR 4](adr/0004-platform-extensions.md) records the decision: no new procedures or contracts for these needs. The cash floor shipped in 0.5.3 and Treasury carries it through mandate proposals; overview visibility remains a follow-up. Approval of a held NEAR withdrawal shipped in 0.5.5 (platform#42), with the evidence limits in 3.2. The two remaining payout gaps concern payout agents, not Treasury.

## 4. Remaining follow-ups

These separate current app/platform work from requests already satisfied. They do not reopen ADR 3 or ADR 4's accepted scope decisions.

1. **Expose `cashFloor` in `overview`.** Compare targets, cost and floor in the existing proposer read, including an agent whose allocations already match. A separate owner floor-setting control is still future design work (3.2).
2. **Prevent duplicate pending owner actions on the platform.** At this pin, creation has a guard, but other kinds can be prepared again while submitted or awaiting a DAO vote (`platform/src/owner-intents.ts`). Treasury's phase-based guard holds another of the same kind, makes freeze/unfreeze hold each other, and lets unsigned wallet preparations expire without delaying an emergency stop. Platform enforcement would cover other apps too.
3. **Expose and coordinate the shared credential budget.** Keep the existing typed 429/backoff behavior; add visibility or shared limiting rather than claiming those signals are missing. Per-Organization limits are tracked separately (platform#59).
4. **Improve DAO request recovery and types.** Idempotent filing, request lists, complete state payloads, typed check URLs and an effectless read would remove app bookkeeping (3.4).
5. **Identify Run now attempts for durable recovery.** The loaded app retains a per-agent pending/unknown hold across navigation, with Turn off available. A caller request id and returned run id are still needed to recover an unknown attempt across reloads and tabs; schedule timestamps and nearby runs do not prove its outcome (3.5).
6. **Supply read-only quote and venue/usage context where needed.** Ballast already converts intents with `legsFor`; a new proposal-leg procedure is not required. Richer reads could improve detectors without granting `treasury-execute` (3.2).
7. **Distinguish test support from simulator completeness.** 0.5.5 supplies `@multiagency/sdk/testing`'s `payoutDouble` and more stack controls, including payee signing and failed/refunded withdrawals. The double models payouts, not Treasury owner workflows, and neither it nor the simulator proves provider budget concurrency. Treasury still needs its own fakes and stack scenarios; no local platform patch is required for the documented tests.

## 5. Delivery boundaries

Issue status and acceptance evidence belong on the issues; this report describes the code at its stated pin.

- **Ballast integration is implemented.** The deployment's validated watch configuration enables it; the server persists price history and band/whipsaw/DCA state beside its request records, evaluates policy and creates proposals. #60 and #61 were component slices, not outstanding integration blockers.
- **Mandate defaults, sleeve labels and price-source choices are recorded in ADR 3.** An individual owner's allocation still needs adoption/signing; accepted defaults do not authorize an agent to trade. Profiles set no number of approvals: more than one comes from DAO ownership (ADR 3, H8).
- **Price and backtest evidence differ.** H9 calibrated detectors using real Coinbase hourly NEAR history (data digest and results in ADR 3). The three independent live price fetchers remain unfinished; `watch` still has an explicit single-source mode. `docs/stabilization-backtest.md` and `docs/diversified-backtest.md` remain synthetic reports with their own limitations, rather than proof of risk thresholds or multi-asset performance (#220, #221).
- **Risk and diversification have remaining acceptance work.** Real-history risk validation, a full stack crash-to-approved-execution scenario and additional asset/price support remain distinct tasks. The stabilization agent now assesses the multi-sleeve book, so a watch entry may carry both `risk` and `diversification` (ADR 6).
- **NEAR Intents is read live, never traded through directly.** The hedge plan (#221) reads NEAR Intents' public token list and dry-run quotes (keyless, no account of the treasury's sent, each call hashed into the audit log) and checks the registry against them. Executing still goes only through platform proposals, so gold (XAUT), BTC and SOL are planned and blocked until the platform lists them: adding them to `PROPOSAL_ASSETS` and the SDK is the platform's change. PAXG isn't on NEAR Intents' list (read 2026-11-10); XAUT is the only gold.
- **Audit/replay are implemented; anchoring is configured.** The server uses a hash-chained audit store and records Ballast/risk inputs for `check:replay`. FastData KV anchoring runs when its account/key are configured; it is not an unconditional property of every server (#54, #55).
- **Setup and live acceptance are separate.** Treasury's own pinned-stack acceptance now covers hosted wallet setup through readable creation, confirmed settlement and connection; browser recovery tests intercept creation routes. Full hosted DAO setup/creation remains upstream coverage rather than a Treasury-owned acceptance scenario. Operator host access, the live provider's signing form, live settlement and production readiness are separate milestones.

## Appendix: running the app locally

Follow the current README and `web/PLATFORM-SESSION.md` for the one browser app, app server and their unit/stack commands. Both SDK pins are 0.5.5; the simulated platform pin is `2e7b1e6`. Use the supplied simulated wallet/signing controls and the stack's own CA as documented. No local platform patch is required. These tests simulate external systems and do not establish deployed host availability or mainnet outcomes.
