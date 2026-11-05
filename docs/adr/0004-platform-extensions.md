# 4. What Ballast asks the platform to add

**Status:** proposed, 2026-11-05, for agreement with the platform's maintainers before any issue is opened there (#62, step 3). This is H3's ADR-001: the contracts for #62's step 2.

Checked against SDK 0.5.2 and the platform at `ce5fec6`, the pin in CI; paths below are the platform's. The gaps come from `docs/sdk-report.md` sections 3.2 and 3.6. Each contract says who owns the change, what the owner signs, what an app sends and gets back, the refusal codes (named **new** where the platform has none), and how existing agents are left as they are.

Two owners matter. The **strategy** (`src/strategy-digest.ts`) is the platform's: its fields, digest and the grant label that binds it. The **policy** (`Policy`, imported from `@near-intents-agent-api/sdk`) is the provider's: synced to the provider, and `owner_approval` is the provider's own switch, which holds every action of the agent (`docs/enforcement.md`). A limit the platform can enforce alone belongs in the strategy; one in the policy needs the provider.

## Not asked

- **A freeze that takes effect at once.** ADR 3 settles A14: freeze is the red hand, and the owner's signature on the confirm page is acceptable. A DAO's vote can't pass inside the intent's window; that's MultiAgency/platform#20.
- **Typed rate limits.** SDK 0.5.2 reports the gateway's 429 as `rate_limited` with `Retry-After`, what platform#15 asked for (still open there for the per-deployment limit's visibility).
- **New procedures for DCA schedules, escalation or ledger export.** Ballast's band, DCA and whipsaw state stays in `packages/core` and reaches the platform as proposal legs (`legsFor`, #60). Escalation is Ballast's (ADR 3, H11), and the ledger is already an app read (`ledger`, `ledgerCsv`).

## 1. An amount ceiling on apps' unattended plans (platform, strategy)

**Need.** An app with `treasury-execute` runs `rebalance`, `externalPlan` and `executePlan` without a signature per swap. The strategy's `autopilot.maxUsd` bounds only the autopilot: `src/authorize.ts` checks the run ceiling only for purpose `autopilot`. An owner who sets `maxUsd: 0`, meaning "every swap is mine to approve", still lets an app with `treasury-execute` swap any amount within the policy and the cost limit.

**What has to change first.** The platform can't tell an app's unattended plan from the owner's own work today: `src/agent.ts` judges an approved proposal and an app's `executePlan` alike as purpose `treasury` (Run now is an autopilot pass, `autopilot`, already under `autopilot.maxUsd`). So the send needs to carry where it came from: an app plan under `treasury-execute` gets its own purpose (or a fact on the send), and only that is bounded. A proposal the owner signed stays outside this ceiling.

**Contract.** An optional field in the strategy:

```ts
Strategy = {
  …,
  autopilot: { everyMin: number; maxUsd: number },
  /** The largest plan, in USD, an app runs under `treasury-execute` without the owner; 0 leaves every swap to proposals. */
  plans?: { maxUsd: number },          // integer ≥ 0
}
```

- **Enforced** like the autopilot's ceiling, on app plans only: the plan's submitted swaps plus this one, valued as for the cost limit, may not pass `plans.maxUsd`.
- **Refused** with `plan_limit_exceeded` (**new**, as `autopilot_limit_exceeded` is), or `valuation_unavailable` when the value can't be read, so it fails closed.
- **Existing strategies are unchanged.** Absent, `plans` means today's behaviour, and the canonical form writes only the keys a strategy has, so no existing digest, grant label, plan in flight or signed proposal changes. An owner who sets it saves a new strategy and signs a new grant, as for any strategy change. (Reading an absent ceiling as `autopilot.maxUsd` would stop every app with `treasury-execute` on upgrade: the default strategy's `maxUsd` is 0.)

## 2. A payout hold above an amount (provider, then platform)

**Need.** `owner_approval` holds every payout or none. An owner can't say "payroll under $250 goes out; anything larger waits for me".

**Owner: the provider.** `owner_approval` is the provider's switch and holds every action of the agent. A hold above an amount is a provider policy feature first. The platform's part follows it.

**Contract, asked of the provider.** A new, separate policy field, so `owner_approval` stays a boolean everywhere it's read today (`!policy.owner_approval` in `src/authorize.ts`, `z.boolean()` in the SDK's outputs):

```ts
owner_approval_above_usd?: string   // a decimal string; with owner_approval false, a payout above it is held
```

- **Held** above the amount, at the provider's USD value at request time; a value it can't read holds the payout. At or below, sent within the caps. `owner_approval: true` still holds everything.
- **Answered** with the states `payouts/request` already has, `held` or `processing`. A malformed amount is refused at `policy_update`, with whatever code the platform gives other malformed policy changes.
- **Then the platform:** sync and show the field, sign it like any policy change (the owner's wallet on the confirm page, or the DAO's vote), and add it to the SDK's policy types as optional, so older apps still parse a policy that has it.

## 3. A DAO's vote on a held payout, through an app (platform)

**Need.** A DAO-owned agent whose policy holds payouts has no way, through any app, to approve them. `DAO_APP_ACTIONS` is `grant_issue`, `grant_revoke`, `policy_update`, `agent_freeze` and `agent_unfreeze`; `approval_vote` isn't among them.

**Contract.**

- **Consent:** `payout` joins `DAO_CONSENT_SCOPES` (today `read`, `treasury` and `treasury-execute`), and `approval_vote` joins `DAO_APP_ACTIONS` gated on it. A DAO consent with `treasury` alone doesn't reach it.
- **Prepared** with `owner/prepare`, `signer: "dao"` and the input `approval_vote` already takes: `approvalId`, `verdict`, `correlationId`. The DAO's proposal names the approval and the request's hash. **It's public:** a DAO proposal on chain shows the payee and the amount it approves, and the app must say so before anyone files it.
- **Relayed** when the vote passes, as other DAO actions are.
- **Refused** with `approval_not_found` (no such held payout) and `approval_ended` (paid, rejected or expired meanwhile), both **new**. A member whose role can't file it is refused by the app before anything is prepared, as for the DAO's other actions.
- **The window:** the held approval lasts about a day, but the vote relays a signed owner intent, whose minutes-long window a DAO's vote can't meet today. That's platform#20; this contract waits on its answer, rather than offering a vote that can't pass.

## 4. Approving a held withdrawal to a NEAR account (platform)

**Need.** A held withdrawal can be rejected but not approved: "approving a held withdrawal isn't available yet: its approval can't be verified" (`src/payment-approval.ts`). Under the payout template, which holds every payout, a withdrawal to a NEAR account is paid only once the owner turns owner approval off.

**What exists.** The provider's approval for a confidential withdrawal to NEAR was observed on mainnet with a `request_hash` equal to sha256 of the canonical `{ amount, chain, flow: "withdraw", kind: "confidential", to, token }`, as a transfer's is (`docs/enforcement.md`). So it can be proven like a transfer's, with one hole: the hash doesn't cover `destination_asset`.

**Contract.**

- **Verified** like a transfer's approval: the platform recomputes the hash from the stored payout request and relays the vote only when it matches. The input is the existing `approval_vote` (`approvalId`, `verdict`, `correlationId`); no new fields.
- **`destination_asset`:** the approval's must equal the stored request's, checked separately since the hash doesn't cover it.
- **`authorize`:** the approval purpose today accepts USDC transfers to agreed payees; it also accepts a withdrawal to an agreed withdrawal recipient.
- **Refused** with `approval_unverifiable` (**new**) when the hash or `destination_asset` doesn't match.

## 5. A cash floor and asset share (platform, strategy)

**Need.** ADR 3's rules map has no platform enforcement for the six-month cash floor or venue exposure. Ballast refuses them, but the platform would send a swap they refuse: they hold back an honest app, not a mistaken or compromised one.

**Where it stands.** MultiAgency/platform#23 asked this for the cash floor, and the platform's planning answer is the strategy: `cashFloor: { usd, assets }`, checked in `authorize.ts` on every send path (scheduled autopilot, Run now, `executePlan`, any app's proposals), refused with `cash_floor_exceeded`, not built yet. The policy can't carry it: the provider's has no balance floor and rejects unknown fields. This contract takes #23's design and adds two things to it.

**Contract.** #23's field, and one more beside it:

```ts
cashFloor?: { usd: string; assets: string[] }   // #23: the least USD value the named stablecoins may fall to
shareMaxBps?: { [asset: string]: number }       // integer 0–10 000: the most of the book's USD value an asset may reach
```

- **Only against the limit, never against the way back.** #23's check keeps cash at or above the floor after the swap; read literally, that refuses a buy of USDC while cash is under the floor, the swap that restores it. As Ballast's own checks (`packages/core/src/exposure.ts`): a swap that lowers cash is refused if cash would end under the floor, and a swap that raises an asset's share is refused if the share would end above its cap. A swap back toward a limit already passed, a buy of USDC under the floor or a trim sell after a rally, is never refused by these, so ADR 3's L3 risk-reducing sells stay possible.
- **Asset share is new to #23,** which left venue exposure until a venue was defined. ADR 3 now defines it: while the agent has one venue, the venue cap is the profile's volatile ceiling (30, 50 or 70%), so it's `shareMaxBps` on wNEAR.
- **Refused** with #23's `cash_floor_exceeded` and `asset_share_exceeded` (**new**), or `valuation_unavailable` when the book can't be valued, so it fails closed.
- **Swaps only,** as #23's check is. Whether the floor should also hold a payout is open below.
- **Existing strategies are unchanged:** absent fields mean today's behaviour and leave the digest as it is.

## After agreement

One issue for each agreed contract: in MultiAgency/platform for 1, 3 and 4, contract 5 on platform#23, and with the provider for 2, linked here and on #62. When one lands and is published, this app moves the matching check from "Ballast only" to "Ballast and the platform" in ADR 3's rules map, and `docs/sdk-report.md` marks it resolved.

## Open

- **The cash floor and payouts:** whether `cashFloor` should also hold a payout that would cross it. ADR 3 says "nothing may spend below the floor"; contract 5 binds swaps only until that's decided.
- **Contract 3's window,** once platform#20 has an answer.
