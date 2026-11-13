# 3. The engine's parameters: price sources, rules map, profiles, calibration and escalation

**Status:** accepted, 2026-11-06 (#156); proposed by Harjaap, owner of H5, H6, H8, H9 and H11. It answers the placeholders those tasks left in `packages/core`, and A14's question on #95. **H11 amended** 2026-11-09 (#231): the level is worked out on every tick, and the owner's approval and the freeze are the human controls ([H11](#h11-escalation-and-alerting)). **H8 amended** 2026-11-11: profiles set no number of approvals, since more than one comes from DAO ownership ([H8](#h8-questionnaire-profiles-and-sleeves)). Harjaap may reopen either.

Every value below is either changed in this PR (marked **changed**) or kept as it already is in code (marked **kept**), so the code and this page agree. Anything not decided here is listed under [Open](#open).

## A14: what the red hand must do (#95)

A14's wording, from the plan and its task card: at L4, **no new sends**. One action freezes the agent, Ballast's queued proposals stop, the state is snapshotted and the roster is told; release takes two approvals.

- **Freeze is the answer.** A frozen agent is refused every send at the platform and at the provider, so approved proposals, Run now, other apps' `executePlan` and autopilot all stop. A stop of every app's access without a signature is **not** required, so no new platform request is raised.
- **The owner's signature is acceptable.** The freeze takes effect once the owner signs on the platform's confirm page. H16's under-60-second target is measured from that signature to the platform confirming the freeze, not from the level reaching L4.
- **Gaps we accept and track:** a wallet owner freezes from the app's pages (#133), but a DAO owner's vote must pass within the intent's minutes, which most DAOs can't do (MultiAgency/platform#20). Until that's fixed, a DAO-owned agent's red hand is `autopilot/stop` plus Ballast proposing nothing at L4. That stops Ballast, not other apps, and the README says so.
- **Revoking grants** isn't needed for "no new sends" once frozen; it stays the owner's choice.
- **Release is the owner's unfreeze** (**kept**), the platform's action, under its `unfreeze_available_at` cooldown. Ballast's level has no release of its own: it is worked out on every tick (H11), and once the agent is unfrozen each Ballast proposal still waits for the owner's approval. The plan's two-approval release is dropped (H11).

## H5: assets and price sources

- **Volatile asset: wNEAR** (`nep141:wrap.near`). **Reserve and operating cash: USDC**, the reserve held confidential (`treasury/setConfidential`; that procedure only labeled the linked account and never held a balance confidential, and it's gone since SDK 0.5.5). There's no tokenized T-bill among the platform's proposal assets, so the "risk-free yield" profile is dropped.
- **The three price sources**, each public, keyless and quoted in USD rather than USDT, and each independent of the platform's own price (the NEAR Intents token list, `price_updated_at`):

| Source | Read | History |
| --- | --- | --- |
| Coinbase Exchange `NEAR-USD` | `GET api.exchange.coinbase.com/products/NEAR-USD/ticker` (`price`, `time`) | Hourly candles, `…/candles?granularity=3600` (300 a request) |
| Kraken `NEARUSD` | `GET api.kraken.com/0/public/Ticker?pair=NEARUSD` (last trade `c[0]`); it carries no timestamp, so the read time is used and the skew limit covers it | `…/OHLC?pair=NEARUSD&interval=60` (last 720 hours) |
| Pyth `Crypto.NEAR/USD` | `GET hermes.pyth.network/v2/updates/price/latest?ids[]=c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750` (`price × 10^expo`, `publish_time`) | Not needed: the history comes from Coinbase |

- **History:** the oracle stores **one median an hour** (the first reading in each UTC hour). The EMA warm-up is seeded from Coinbase's hourly candles. The chop detector and H9's calibration both assume hourly samples.
- **One source until the fetchers are built (kept):** `watch` reads prices from the platform's `overview` (#47). One source can't meet the oracle's three, so `watch` uses an explicit single-source setting that is named, logged and removed when the fetchers ship. That holds back nothing the owner doesn't see: every Ballast trade is still a proposal the owner signs.

### Threat-model entries (to add to #20's table)

| What can go wrong | What stops it |
| --- | --- |
| One price source is wrong, manipulated or compromised | The median of three ignores one outlier. A spread over 2% between fresh sources freezes the reading (L2, `source-disagreement`), and so does a source older than 5 minutes or dated more than 5 seconds ahead. Residual: two sources wrong in the same direction within 2% move the median. A proposal's `minAmountOut` then sits off the market, and the platform refuses it when it's above the quote. It's never a worse swap than the owner signed. |
| A source is down, rate-limits or changes its format | Fewer than three fresh, parseable quotes freezes the reading: hold, never trade. The response is parsed against a strict schema; anything else counts as no quote. Each source is read at most once a tick, under its documented public limits. |
| A source is reached over a spoofed network | HTTPS only, with certificate checks left on. No redirect is followed to another host. |
| A leaked price-source credential | None exists: all three are public and keyless. If one later needs a key, it gets its own entry first (CONTRIBUTING). |
| The stored hourly history is edited or corrupted | It's an owner-only file written atomically, like the request store. An unreadable file, a gap over an hour inside the TWAP window, or a span under 30 days freezes the reading (`warming-up`) until it's re-seeded from Coinbase. |

## H6: rules-to-policy map

Each rule is enforced in one or more places. The platform's signed policy always has the last word. Ballast's checks only hold back (CONTRIBUTING).

| Rule | Ballast check (`packages/core`) | Signed platform policy | Human |
| --- | --- | --- | --- |
| One order ≤ 2% of the treasury | `ORDER_SIZE` | `limits.per_transaction` per asset, set at signing from the treasury's value | — |
| Daily turnover ≤ 10% | `DAILY_TURNOVER`, gross over a rolling 24 hours | `budget.daily_usd`, set at signing to 10% of the value | — |
| ≤ 10 orders an hour | `ORDER_RATE` | `max_actions_per_hour: 10` | — |
| Slippage ≤ 50 bps | `SLIPPAGE`, quote against the oracle median | The proposal's `minAmountOut` (`legsFor`), enforced at execution | — |
| Venue exposure | `VENUE_EXPOSURE` (see below) | — | — |
| Six-month cash floor | `CASH_FLOOR` | The strategy's `cashFloor` (SDK 0.5.3), set from the mandate by Ballast's strategy proposals once the owner adopts one (ADR 4) | — |
| Assets and actions | Mandate `assets` | `assets: [wNEAR, USDC]`, `actions: ["swap"]` for trading (payroll adds `transfer`) | — |
| Destinations | Mandate `destinations` | `destinations.mode: "only"` with the mandate's list | — |
| Levels L1–L3 | `LEVEL` | — | L2 and L3 trades are proposals the owner approves |
| L4 | `LEVEL` refuses everything | `frozen` (A14) | The owner signs the freeze |
| Every Ballast trade | — | — | Every trade is a proposal the owner signs (`proposalText`) |

- **Venue (changed):** a venue is where the agent's assets are held and settle. Today that's one place, the agent's NEAR Intents account. So the venue cap is the profile's volatile ceiling (`bounds.volatileMaxPct`): conservative 30%, balanced 50%, growth 70%. The default is 50%. With a 25% cap, the backtest's 581 rejections were all this rule: buying stopped once wNEAR passed a quarter of the treasury, whatever the profile allowed.
- **Cash (kept):** stablecoins only, with no valuation haircut on USDC. The depeg detector (L2 at 1%, L3 at 3%) covers USDC losing its peg.
- **Six-month floor against the three-month buffer (kept):** the six-month floor wins. The three-month withdrawal buffer isn't a separate rule, and nothing may spend below the floor.
- **Spend rate (kept):** the owner's answer to question 1, with no default. An unset rate rejects every buy.

## H8: questionnaire, profiles and sleeves

- **The seven questions (kept),** in order: monthly operating spend (USD); months of operating cash to protect; treasury value today (USD); volatile assets the engine may trade; stablecoins that count as cash; NEAR accounts funds may be sent to; and NEAR accounts that approve orders.
- **Sleeves:** volatile = wNEAR, reserve = USDC the DCA buys draw on, operating cash = USDC protected by the floor. The DCA never draws on operating cash. These labels are confirmed. The weights become an approved allocation only when an owner signs a mandate on them, so `weightsApproved` stays false in code.
- **Profiles (kept, plus the venue cap above):**

| Profile | Volatile / reserve / cash | Volatile bounds | Order / turnover / orders an hour / slippage | Min months | Starts at |
| --- | --- | --- | --- | --- | --- |
| Conservative | 20 / 30 / 50 | 5–30% | 1% / 5% / 5 / 30 bps | 9 | L2 |
| Balanced | 40 / 35 / 25 | 10–50% | 2% / 10% / 10 / 50 bps | 6 | L0 |
| Growth | 60 / 25 / 15 | 20–70% | 2% / 15% / 10 / 50 bps | 6 | L0 |

- **Approvals (removed):** profiles no longer set a number of approvals. The conservative profile's 2 was checked against the number of `governance.approvers` and enforced nowhere: a proposal executes on the owner's signature, or the DAO's vote. More than one approval comes from DAO ownership, under the DAO's own voting policy. `approvers` (question 7) stays, used only in the text of strategy proposals (`apps/server/src/strategy-proposals.ts`).

## H9: calibration

**Method.** `node scripts/calibrate.ts fetch near-usd-1h.csv`, then `… run near-usd-1h.csv`.

- **Data:** Coinbase's hourly NEAR-USD closes from 2025-09-25 to 2026-11-05, 9,735 rows with a longest gap of 6 hours. CSV SHA-256 `aee22540964679dc6857105c50e9e8301320655825a8651356d63ebea54ea4b2`.
- **Run:** the first 35 days warm the EMA up, and the replay runs on the remaining 8,900 hours. The setup is the balanced profile at 100,000 USD (40/35/25), spending 2,000 a month, with the replay's simulated 5–15 bps fills.
- **Checks:** each candidate was also run on each half-year, to see whether a result held in both or was luck in one.

| Run (year, then each half) | End value | Max drawdown | Trades |
| --- | --- | --- | --- |
| Buy-and-hold | 129.6k (82.6k / 183.2k) | 33.0% (33.0% / 30.2%) | — |
| Plan bands (±15/25/40, halt −45), venue 25%, chop 6/2 | 110.7k | 28.6% | 7 buys, 41 sells; every later buy rejected by the venue cap |
| Plan bands, venue 50%, chop 14/1 | 105.1k (86.4k / 135.9k) | 30.1% (30.1% / 15.9%) | 6 buys, 41 sells |
| **Chosen: trim 20/30/45, DCA −20/−30/−40, halt −50, venue 50%, chop 14/1** | **110.9k (86.5k / 135.8k)** | **30.1% (30.1% / 14.0%)** | **9 buys, 35 sells** |
| Trim 20/35/50, same DCA | 111.5k (86.5k / 139.3k) | 30.1% (30.1% / 13.9%) | 9 buys, 33 sells |

- **Bands (changed):** trim at +20/+30/+45%, DCA at −20/−30/−40%, buying halts at −50%. On NEAR, the TWAP sat outside the plan's ±15% for 43% of the year, so the bands acted on ordinary moves. With ±20%, it's 33%. The wider bands made more buys and ended higher in both halves. Trim 20/35/50 did slightly better again, but the difference is within one year's noise, so the middle setting was chosen.
- **Chop (changed):** 14 reversals with at most 1% net move in a day, on hourly samples. The plan-era 6 and 2% fired in 37% of hours and held trading for a third of the year; 14/1 fires in 4.7%.
- **Kept as they are**, each checked in the same run:
  - **Oracle:** 3 sources, 2% disagreement, 5 minutes stale, 5 seconds future skew. These are plan values, and the backtest's single series can't test them, so they're revisited once the fetchers have a week of live quotes.
  - **Smoothing:** 30-day EMA, 15-minute TWAP, a 1-hour largest gap.
  - **Whipsaw:** 1-hour cooldown, 24-hour reversal lock, 2-point hysteresis. A 6-hour cooldown changed nothing; 24 hours with a 72-hour reversal lock made 8 fewer trades and a higher drawdown (29.5% against 28.6%).
  - **Sizing:** DCA budget 20% of the reserve in 10 units. A 40% budget traded 10% more USD for the same end value and drawdown.
  - **Fast move** at 10% and 20% an hour, **crash** at 30% and **parabolic** at 40%. The parabolic detector fired twice in the year; crash and the fast-move detectors never fired.
- **What this calibration is not:** one asset and one year, which rose 74% end to end. The strategy trails buy-and-hold in the rising half (135.8k against 183.2k) and halves its drawdown there (14.0% against 30.2%), which is the trade it exists to make. It isn't evidence of returns.

## H11: escalation and alerting

**Levels (kept):** L1 halves the per-order cap. L2 asks a human for every order. L3 allows only risk-reducing sells, each approved. L4 is no new sends.

**How the level moves (kept):** Ballast works it out on every tick, as the highest of the market and fault detections and the profile's `startLevel` (`apps/server/src/ballast.ts`). It falls back as soon as the detection that raised it clears. Nothing stores, acknowledges or lowers it. Each trade's policy check in the audit log records the level it was made at, and each tick's `watch` log line names it.

The plan also had a raised level held until a human lowers it one step at a time, an unacknowledged L2 or L3 rise further (60 and 15 minutes), two approvers release L4, and a roster be told and paged. That is dropped, because the human controls it would add are already in place:

- **Every Ballast trade is a proposal the owner approves,** and the platform enforces the owner's signed policy when it executes. The level changes what Ballast proposes, never what executes. Autopilot runs on the platform and doesn't read it.
- **The red hand is the freeze** (A14, #133), which the platform holds until the owner unfreezes.
- **Holding the level would cost more than it guards.** Approvers who aren't the owner would need their own access to the app server, from a list the operator writes (`approvers` in the watch file) and the owner never signs. Paging needs a new credential (#20). And the windows are shorter than a Ballast agent's tick, which may be an hour.

**Who is told (kept):** nobody. No notice is sent when the level changes (see Open).

## Open

- **A notice when the level rises,** through `watch`'s `notify`, asking the owner to freeze at L4: the part of H11's alerting worth keeping, as its own small change.
- **The three price fetchers (H5)** aren't built, and no issue tracks them. Until they are, `watch` runs the oracle on the platform's `overview` alone.
- **Agent malfunction (H9):** Ballast leaves this detector out (`NOT_JUDGED_HERE`), since its step has no reconciliation. `reconcileBooks` is an app read the server already wraps (`platform.books`), and unknown outcomes are effectively zero whenever Ballast runs, since `watch` holds while any are unresolved. Whether to feed the detector from it, at one more read a tick, is open.
- **DCA budget replenishment** isn't specified. The replay never refills the 10 units, so buying stopped once they were spent. The proposal is to refill one unit for each trim sale's proceeds returned to the reserve, capped at 10 units. It needs its own change to sizing state, with tests.
- **Oracle numbers against live quotes:** revisit 2%, 5 minutes and 5 seconds after a week of the three fetchers' readings.
- **A second venue,** if one is ever added, brings back a real per-venue cap below the volatile ceiling.

## Independent live feeds (#252)

Ballast and explicit assessments obtain each asset's three public USD tickers from the asset registry. The platform overview remains the source for holding values and proposal pricing; it is not counted as an independent oracle source. Stablecoin fault detection now also uses the independent three-source median. Missing, stale or disagreeing stablecoin quotes become an unknown price, which the existing fault detector treats as a fault; no overview fallback is used.

Each venue request uses HTTPS, rejects redirects, carries no credentials, times out after five seconds, and consumes at most 100,000 decoded response bytes before JSON parsing. Oversized streams are cancelled even when Content-Length is absent or false. Successful reads are cached for 30 seconds and concurrent readers share an in-flight request. Failures are not cached. Venue timestamps are used where supplied; undated tickers are dated at receipt, which establishes fetch freshness rather than trade freshness. The oracle still requires three fresh distinct sources and enforces its five-minute age, five-second future skew and two-percent disagreement bounds.

Price history is retained across the source change; old observations are not relabelled as independent evidence. Existing replay records preserve their original inputs. A mixed-source warm-up history remains a limitation until enough genuine independent samples have accumulated. This change adds no platform API reads; exchange requests are separate and bounded by the shared cache. Deployment and any live source activation require a separate reviewed release; this work does not enable watch, grants or trading.

## Reconciliation malfunction evidence (#253)

Watch reads reconciliation evidence at most hourly after a successful read. It caches raw public drift and confidential unattributed amounts, not USD values. Every tick revalues those amounts against that tick's overview prices; missing, expired or future-dated price observations make a nonzero difference unknown. Failed reconciliation reads are not cached and are retried on the next eligible tick. The conservative request budget includes that retry on every Ballast tick (four base reads rather than three), even though successful cached evidence costs fewer calls.

Absolute differences are summed across assets and across public/confidential evidence, so a surplus cannot cancel a shortfall. Unreadable amounts, unusable prices, invalid decimals or nonfinite valuation are unknown. Unknown reconciliation or mismatch strictly over 0.1% of the current book raises the existing L3 agent-malfunction fault and holds Ballast trades. Exactly 0.1% is within the configured tolerance. This compares the platform's reported balances with its records; it does not establish independent provider custody or settlement.

The manual assessment-only API has no reconciliation-read capability; absent reconciliation remains unknown and creates no trade. Its assessment-only exit and no-proposal guarantee remain intact. Production activation and detector changes require a reviewed release; this branch does not enable watch or modify production state. The original agent-malfunction checkpoint remains preserved.
