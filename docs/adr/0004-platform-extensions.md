# 4. What Ballast asks the platform to add

**Status:** proposed, 2026-11-06. #62's step 2: H3's ADR-001.

**Decision: no new procedures and no new contracts. One refinement to a planning question already open: the cash floor, MultiAgency/platform#23.** Everything else the gap tables raised (`docs/sdk-report.md` sections 3.2 and 3.6) is either already there, settled elsewhere, or not this app's to ask. This page records what was checked, at SDK 0.5.2 and the platform at `ce5fec6` (the pin in CI; paths below are the platform's), and why.

## What the Treasury app is

These facts decide every item below:

- **Its consent:** `read` and `treasury`, plus `owner` for a wallet owner who keeps it (#135). Never `payout`, never `treasury-execute` (`apps/server/src/consent.ts`).
- **Its agent:** a Treasury agent is created under the platform's `treasuryPolicy`: `actions: ["swap"]`, `owner_approval: false` (`src/policy.ts`). It makes no transfers, so it never has a held payout. Held payouts belong to payout agents, under the `transfer` template with `owner_approval: true`.
- **Its swaps:**
  - **Proposals:** they run only once the owner signs their exact text, or the DAO votes.
  - **The autopilot, turned on or run now from this app:** it swaps without a signature each time, but only under the grant that binds the saved strategy and within `autopilot.maxUsd`. Its plan moves value from the most over-weight asset to the most under-weight one and never past an asset's target (`src/treasury.ts`).
- **What binds every send:** the provider's signed policy (per-transaction caps, the USD budget, actions an hour), whoever asks.

## The one ask: the cash floor (platform#23)

**Why it's needed even with signed proposals.** The autopilot sells whatever is over-weight. With a USDC target below the six-month floor, its runs spend USDC below the floor, and Ballast never sees them. ADR 3 puts the floor in Ballast only, which holds back Ballast's own proposals and nothing else.

**What's agreed in planning.** The platform's answer on #23: not in the provider's policy, which has no balance floor and rejects unknown fields. Instead, in the strategy, `cashFloor: { usd, assets }`, bound by the grant, checked in `authorize.ts` on every send path, refused with `cash_floor_exceeded`. Not built yet.

**The refinement.** #23's check keeps cash at or above the floor after the swap. Read literally, that refuses a buy of USDC while cash is under the floor: the swap that restores it. Ballast's own check (`packages/core/src/exposure.ts`) refuses only a swap that lowers cash and would leave it under the floor. The platform's should work the same way, so a book already under its floor can always be brought back.

**Open:** whether the floor should also hold a payout. That's moot for a Treasury agent, which makes none, and stays with #23.

## Checked and not asked

| Candidate | Why it isn't asked |
| --- | --- |
| A new procedure for adaptive DCA schedules | Ballast's band, DCA and whipsaw state stays in `packages/core` and reaches the platform as proposal legs (`legsFor`, #60), which `proposals/create` accepts |
| Escalation | Ballast's (ADR 3, H11), on `watch`'s `notify` |
| Ledger export | Already an app read: `ledger`, `ledgerCsv`, `reconcileBooks` |
| A freeze that takes effect at once | Settled by ADR 3: freeze meets A14, and the owner's signature on the confirm page is acceptable. A DAO's window is platform#20 |
| Typed rate limits | SDK 0.5.2 reports the gateway's 429 as `rate_limited` with `Retry-After` (platform#15) |
| Venue exposure, or a cap on an asset's share | Enforced in Ballast (ADR 3). Nothing else moves the book past it: proposals are signed, the autopilot never passes its targets, and no app reaches `treasury-execute` unless the owner grants it |
| An amount ceiling on `treasury-execute` plans | This app never asks for `treasury-execute`. An app that does runs plans only under the owner's grant for the strategy, within the policy's caps and budget and the cost limit. A mismatch worth one line in the platform's docs: `autopilot.maxUsd: 0` doesn't stop such an app's plans, since the ceiling binds only the autopilot (`src/authorize.ts`) |
| A payout hold above an amount | A payout feature, and the provider's: `owner_approval` is its switch and holds every action. A Treasury agent makes no payouts |
| A DAO's vote on a held payout through an app | A payout feature. A wallet owner can already approve a held transfer through an app under `owner`; a DAO can't, since `approval_vote` isn't in `DAO_APP_ACTIONS`. For payout agents, not this app |
| Approving a held withdrawal to a NEAR account | A payout feature. The provider's approval carries a `request_hash` that could be verified as a transfer's is, except that it doesn't cover `destination_asset`; verifying it isn't built (`src/payment-approval.ts`, `docs/enforcement.md`). For payout agents, not this app |

The three payout gaps are real for payout agents. They're recorded here so Payables can take them up; they're not asked under A23.

## After agreement

When #23's floor lands and is published, this app sets `cashFloor` from the mandate's six months of spend, and moves the floor from "Ballast only" to "Ballast and the platform" in ADR 3's rules map.
