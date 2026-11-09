# 6. A diversified book: assets, sleeves, venues and what the platform must list

**Status:** proposed by Harjaap, 2026-11-10, for review in this PR. It answers #221's phases and records what #221 can't finish without the platform.

## Why

The book is two assets in one place. wNEAR and USDC sit in the agent's NEAR Intents account, so the treasury carries NEAR's price, USDC's peg and one venue's risk together. NEAR Intents already settles assets from other chains (`nep141:eth.omft.near`), and the registry and the engine can describe a diversified book now. What the treasury may *trade* is the platform's choice: `PROPOSAL_ASSETS` is wNEAR, USDC and ETH, and a proposal naming anything else is refused at execution. So this ADR builds the machinery, runs phase 1 as far as the platform allows, and says exactly what remains blocked.

ADR 3 dropped the "risk-free yield" profile because no tokenized T-bill was among the platform's proposal assets. Phase 3 needs the platform to list one; until then the RWA sleeve is off and the cash floor counts stablecoins only.

## The registry (`packages/core/src/assets.ts`)

One entry per asset the treasury could hold:

- **Class:** `volatile` (traded by the bands), `stable` (reserve and operating cash), or `rwa` (a reserve sleeve, cash-like only when it is a claim on dollars and can be redeemed in time).
- **Chain and route:** `native` (issued on NEAR), `omft` (NEAR Intents' own bridge, `*.omft.near`) or `bridged` (another bridge).
- **Venues:** every venue its holding depends on, the agent's NEAR Intents account first and the bridge after it. Today the account, the Ethereum omft bridge and the Bitcoin omft bridge.
- **Three independent price sources:** the H5 shape (Coinbase, Kraken, Pyth for wNEAR and ETH; Kraken, Gemini, Pyth for USDC; the matching pairs for the rest). Naming them is not fetching them: `watch` still reads the platform's `overview`, one source per asset (`OVERVIEW_ORACLE`), until H5's fetchers ship.
- **Liquidity:** the largest order the engine proposes in that asset. A named default, awaiting live quotes, and `0` where the platform doesn't list the asset at all.
- **RWA terms:** issuer, underlying, whether it's cash-like, notice and settlement days, minimum redemption, fee, NAV source and cadence, and whether the holder must pass KYC.

**Proposability is the platform's list, not the registry's.** `proposable(entry)` is true only when its NEAR Intents id is one of `PROPOSAL_ASSETS` (held equal to the SDK's by a server test). Today that is wNEAR, USDC and ETH. The registry also carries BTC (`nep141:btc.omft.near`), USDT, USDC.e and XAUT with their real ids, and a `TBILL` slot with no id because no tokenized T-bill is on the token list. Every one of them is declared, with its class, chain, venues and sources, and **none is tradable until the platform lists it**. A test holds the tradable set to exactly `{wNEAR, USDC, ETH}`.

## Venues and caps

A venue is where assets are held and settle. The account is one venue; each bridge an asset arrived through is another, and a holding counts at **every** venue on its path, so ETH counts at the account and at the Ethereum bridge, and a bridged stablecoin still counts at its bridge.

- **Per class:** a cap in percent of the treasury for volatile, stable and RWA.
- **Per venue:** a cap in percent of the treasury. Each venue on a traded asset's path must have one; a missing cap is `INVALID_INPUT`, never "uncapped".
- **Per asset:** its liquidity limit, as `ORDER_SIZE`.
- **Cash floor, per runway:** the cash the floor counts is only what can be turned into dollars in time (`runway.ts`). Stablecoins count in full. A cash-like RWA counts only when the RWA phase is on, the platform lists it, its notice plus settlement fit the horizon, and the holding meets its minimum redemption; then at its value less the fee. Volatile assets and gold never count.

The checks are in `checkBookExposure` and only ever **hold back**. The platform's signed policy has the last word (CONTRIBUTING); nothing here claims the platform enforces a class or venue cap.

The bridge caps are named defaults (`BRIDGE_CAP_PCT`): half the profile's volatile ceiling — 15/25/35% for conservative/balanced/growth. #221's bridge risk assessment, when it has numbers, replaces them.

## Sleeves (`packages/core/src/sleeves.ts`)

A volatile sleeve is one asset with its own target, bounds, optional band thresholds, DCA units and anti-whipsaw state, all in percent of the whole book.

- The reserve is split across sleeves by target, so their buys together never spend more than it.
- The other sleeves' weight lowers a sleeve's ceiling; room they already use isn't room it may buy into. The class and venue caps still check the whole book, so the two limits together can't be walked past.
- Sells come before buys, and every sleeve's decision is an ordinary `decide` record, so `replayDecisions` replays it.
- A book of one sleeve is exactly the two-sleeve book: the same input, trades and equity, held by a test.

## The mandate's terms (`packages/core/src/diversified.ts`)

The owner's answers gain an optional eighth part: the classes allowed; a cap per class and per venue; the sleeves; the stablecoin split; and the RWA eligibility, KYC and cash horizon. The compiler fills what the owner leaves out from the profile, then the whole is checked as one:

- the sleeves' targets add to the profile's volatile weight;
- the volatile class and the account are capped at most at the profile's ceiling;
- every sleeve is a volatile registry asset **the platform can propose**;
- every stablecoin in the split is a stablecoin **the platform can propose**, and the split adds to 100;
- every venue on a held asset's path has a cap;
- RWA needs the class allowed, the owner's eligibility, the holder's KYC, a cap, and `rwa.maxPct` at least the class cap.

A mandate with more than one volatile asset and no terms is refused on read-back, because the compiler always writes them. A mandate without the terms is the two-asset mandate, unchanged, digest included. The thresholds and caps are mandate parameters in ADR 3's sense: defaults are named, every one is validated, and nothing is repaired.

## Stablecoins (`packages/core/src/stables.ts`)

Phase 2's rules are written and tested, each coin with its own peg monitor (L2 at 1%, L3 at 3%, no price is L3). A depeg moves that coin's holding, at most `maxMoveUsd` a move, into the coins on peg by their targets; with every coin on peg, the most overweight is moved into the most underweight once both are five points off. A coin the platform can't propose is **blocked with the reason**, never traded. Today USDC is the only proposable stablecoin, so every plan is empty or blocked. A second stablecoin also needs a second price source in `watch`: the `overview` row for that coin is the only price it would have.

## Real-world assets (`packages/core/src/runway.ts`)

Phase 3's rules are written and tested with a stand-in listed T-bill: only a cash-like RWA counts towards the floor, only when the sleeve is on and the platform lists it, only inside the horizon, and only above its minimum redemption, less its fee. Gold (XAUT) is a price exposure, never cash. A listed T-bill also needs the issuer's KYC, which an agent account may not be able to pass: #221 leaves that open, and the terms refuse `kycVerified: false`.

## `watch` and the app

An agent's watch config may carry a `diversification` block: sleeves, class and venue caps, the stable split and the RWA terms. It is validated at load by compiling it against a treasury that can hold the floor and checking the compiled terms — a non-proposable sleeve, a missing bridge cap or a split that doesn't add to 100 refuses the file. With the block, `watch` runs the multi-sleeve path: per-sleeve oracle histories (`PriceHistory` already keys by asset), `evaluateSleeves`, the policy and `checkBookExposure`, then at most one proposal a tick through the same stored-request/send flow, with a `decision` audit record that carries the book check. Without it, the two-asset path is unchanged. A sleeve the agent doesn't hold has no `overview` row and so no platform price: it holds with that reason until it is funded, rather than being guessed at.

`GET /api/agents/:agent/diversification` reports the book from one `overview` read: per holding its class, chain, route, venues, USD and proposability; per venue its exposure and cap with the cap's source (the configured mandate terms, the profile's defaults, or absent); the stablecoin split with each coin's peg level; and each phase with its reasons. The Strategy page shows it in the asset colours (#193). The caps are said to be app-side.

## Phases: what runs, and what is blocked

| Phase | State now | What must happen |
| --- | --- | --- |
| 1. Cross-chain majors | **Partly.** ETH is a second volatile sleeve and `watch` can trade it under per-venue caps; the backtest shows the two-sleeve book. But ETH is the only cross-chain major among the proposal assets, so "two cross-chain majors" isn't met. | Add BTC (`nep141:btc.omft.near`) and any further majors to `PROPOSAL_ASSETS`, with the provider's price. |
| 2. Stablecoin split | **Blocked.** The core plans and checks a split, and a depeg moves a coin into the others, but only USDC is a proposal asset. | List a second stablecoin (USDT, USDC.e) and give `watch` a second price source for each coin in the split. |
| 3. Real-world assets | **Blocked.** The RWA terms, the runway rule and the refusal paths are built and tested against a stand-in. | List a tokenized T-bill (or fund) with NAV pricing and redemption terms; decide whether an agent account can pass the issuer's KYC; then set `eligible` and `kycVerified`. |

## What else the platform must add

- **BTC (and the rest of the majors) as proposal assets,** so a cross-chain sleeve can be proposed.
- **A second stablecoin as a proposal asset,** and a price feed for it beyond the platform's own `overview`.
- **A tokenized T-bill as a proposal asset,** with its NAV source and redemption terms published.
- **RWA eligibility and KYC** for an agent-held account, or an explicit answer that the agent can't hold one.
- **Bridge risk numbers** for each route, so the venue caps are assessed rather than named defaults.
- **The H5 fetchers,** so a sleeve's oracle has three independent sources instead of `OVERVIEW_ORACLE`'s one.

## Rejected

- **Trading BTC now.** The registry can describe it, but a proposal naming it is refused. Adding it to `PROPOSAL_ASSETS` here would fake platform support.
- **A per-chain account per venue.** The platform gives the agent one NEAR Intents account; a bridge is a risk path, not a second balance.
- **Turning on the stable split with USDC alone.** It would be a one-coin "split" and would claim a phase that isn't running.
- **Counting a hinted T-bill as cash before it is listed.** The runway rule refuses it; the UI shows the RWA phase off with the reason.
- **Claiming the caps are enforced by the platform.** They are app-side; the signed policy still has the last word.

## Consequences

- The two-asset book and its digest are unchanged for an owner who doesn't configure the block.
- A diversified agent's state grows a per-sleeve section; the old two-asset state still parses and still works.
- The backtest (`docs/diversified-backtest.md`) is deterministic and synthetic: it shows the harness and the caps, not returns. A real-data run is a separate step.

## Open

- A listed RWA's exact NAV and redemption terms, and whether an agent can hold it.
- The second stablecoin's price source, and the first one that isn't the platform's own quote.
- Bridge risk numbers to replace `BRIDGE_CAP_PCT`.
- A stablecoin-to-stablecoin leg: `legsFor` builds volatile ↔ reserve swaps, so a split move needs either a second leg shape or two proposals.
