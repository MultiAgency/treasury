# 5. The stabilization agent: forward risk, and what it may do about it

**Status:** proposed by Harjaap for #220, 2026-11-10. It builds on [ADR 3](0003-engine-parameters.md)'s profiles, thresholds and replay, and on the app server's decision records (#54).

Ballast reacts to what already happened: the market-move and fault detectors, the levels L0–L4, the cash floor. #220 adds a second, pure engine beside it, in `packages/core`:

- `scenarios.ts` re-runs the book under the issue's tail events: each volatile asset down 30, 50 and 80% in a day; each stable at $0.95 and $0.90; each venue unavailable for 24 hours and 7 days; every price source stale for a day; spend at twice the plan.
- `projection.ts` carries the book forward on hourly returns drawn from its own recent history, 500 seeded paths over 7 days, and reports the projected drawdown, expected shortfall, probability of breaching the cash floor, and months of runway and to the floor.
- `stabilization.ts` turns a projection and the scenarios into an early warning (detections shaped as A6's, with a level) and into at most four recommendations, each carrying the projection that justified it: hold buys, de-risk, pause autopilot, recommend a freeze.

## What it may do

- **Early warning.** A projected metric at or past a threshold step raises that level, as a fault detection does. The detections join the same tick's regime and level (`regimeFrom`, `highestLevel`), once: buys hold at L1+, and every policy check sees the higher of the forward level and Ballast's own. Nothing is counted twice.
- **De-risk.** At L2 or more, and only on a projection that could be made, it sizes a sell of the largest volatile holding into the largest stable one, at the smallest of: the size that brings the projection back to `targetDrawdownPct`, one order (`maxOrderPctOfTreasury`), the day's turnover left (`maxDailyTurnoverPct`), the volatile floor (`volatileMinPct`), and what is held. The sell is then checked through the whole policy at `max(forward level, Ballast's level)`, with the same prices, decimals and slippage bound a Ballast proposal uses.
- **Hold buys, not widen the bands.** A raised level holds Ballast's buys (L1) or asks the owner for every order (L2, L3) through the same regime and level gate its own detections use. The agent doesn't edit the saved strategy's bands: those are the owner's, and a wider band would be a different mandate, not a safety action.
- **A proposal, never a trade.** A de-risk with a policy answer, no cooldown and legs becomes the tick's one proposal: stored before it is sent, under a `requestId` the audit log records, through the existing `requests`/`send` flow. In production the owner signs it. The backtest is the only place a de-risk fills without a human, and it says so.
- **Recommendations that are only recommendations.** Pausing autopilot and freezing are the owner's: the agent says when, with the projection, and does neither. It never builds a freeze request, because a freeze without the owner's signature is the platform gap in #95.

## Thresholds are mandate parameters

`RISK_PROFILE_DEFAULTS` holds one set per profile, as the bounds and limits are. A deployment may replace a mandate's whole set with `ballast.risk`; the watch file's `risk.projection` and `risk.scenarios` override the engine's own parameters. The values below are **profile defaults, not calibrations**: the backtest in [docs/stabilization-backtest.md](../stabilization-backtest.md) runs on a deterministic synthetic placeholder, and these are revisited when H5/A8.2 load real hourly history, as H9 did for the detectors.

| Profile | Drawdown / shortfall steps (L1/L2/L3) | Breach steps | Months to floor (L1/L2) | Freeze shortfall | Target drawdown |
| --- | --- | --- | --- | --- | --- |
| Conservative | 6 / 8 / 12% | 1 / 5 / 20% | 3 / 1 | 15% | 5% |
| Balanced | 12 / 16 / 24% | 1 / 5 / 20% | 3 / 1 | 30% | 10% |
| Growth | 18 / 24 / 36% | 1 / 5 / 20% | 3 / 1 | 45% | 15% |

Each profile's drawdown and shortfall steps scale with its volatile weight, so the same market raises the same level whatever the profile. The breach and runway steps are shared.

## Fail-closed rules

- **Unreadable inputs give the conservative answer, never an exception and never a trade.** A projection that can't be made is L1 with its reasons; the recommendation is to hold buys, nothing is sized, and the regime is `forward-risk`, which holds buys and lets Ballast's sells through. An unreadable assessment input is L1 with `risk-config`, the regime is `system-fault`, and the only recommendation is to hold buys.
- **Unreadable thresholds refuse.** `riskThresholdProblems` checks every step's range and order (and the target's relation to the drawdown steps); a set it refuses makes the forward detection `risk-config` and sizes nothing. The server validates `ballast.risk` with the same function at startup.
- **A scenario that leaves the stables under the floor is L1**, naming it: a plausible depeg, outage or spend overrun holds buys while nothing better can be sized.
- **Only a usable projection is sized.** The conservative stand-in (100% drawdown, no runway, a certain breach) is never a basis for a sell.
- **A trade outside the bands arms no band zone.** `nextState` records the de-risk's time and direction but no `disarmed` zone, so the state stays readable and the cooldown and reversal lock still apply.
- **A record that can't be appended stops the tick**, as a decision's does: nothing acts on an assessment that isn't in the log.

## Data and replay

The price history is the one Ballast already keeps (`<TREASURY_REQUESTS_FILE>.history`), trimmed to the projection's lookback; hourly wNEAR is enough for today's two-asset book. The assessment reads no platform data of its own: the overview, unresolved operations, autopilot and strategy reads are the tick's existing ones, so it adds no call to the platform's 1,200 an hour.

Each tick with a `risk` block records a `kind: "risk"` audit record **before anything acts on it**, holding the whole `RiskInput` (book, spend terms, history, thresholds, projection and scenario parameters, autopilot state, and the policy context, bounds, cooldown and pricing a de-risk would be checked under) and the whole `RiskAssessment` (level, detections, projection, every scenario, recommendations, and the policy's answer for the sized sell). A record whose de-risk passed and was proposed also names its `requestId`. `check:replay` verifies the chain and makes every recorded assessment again with `replayRiskLog`, naming the first that differs by its sequence number; an intent's or a recommendation's wording isn't compared, so rewording one leaves the record replaying the same.

`GET /api/agents/:agent/risk` answers the latest `risk` record for the agent from the log, with its time and sequence number. Nothing is computed on request, and no platform read is made.

## Open and blocked

- **A freeze without a signature is a platform gap (#95).** The agent can only recommend one; the owner signs on the platform's confirm page, and `docs/app-server.md` says what a DAO-owned agent can and can't do.
- **A stablecoin depeg needs a second source.** Today USDC's price is the platform's own overview reading; the scenarios project a depeg, but a live depeg detection on one source would be a single point of failure. ADR 3's second source is what closes it.
- **Real price history is H5/A8.2.** Until it loads, the backtest's history is a deterministic synthetic placeholder and the thresholds are uncalibrated defaults. The report says so in its first paragraph, and `run --csv` is the same comparison on a real series.
- **A second venue or volatile asset** needs no change here: scenarios come from the book, so each new asset and venue gets its own falls, depegs and outages. The server's book is still wNEAR and USDC only (#221 is the wider one).
- **A diversified book (ADR 6):** answered. The agent assesses the multi-sleeve book, and its de-risk sells the largest asset the swap can price (ADR 6's amendment); a watch entry may carry both `risk` and `diversification`.
- **The projection's parameters** (7-day horizon, 500 paths, 14-day lookback, a day's volatility half-life) are placeholders too: one asset and one year of synthetic history can't fit them, and live quotes are what will.

## Explicit assessment without watch (#250)

A signed-in owner or authorized DAO member can call `POST /api/agents/:agent/risk/assess` with the Ballast terms object (`profile`, `monthlySpendUsd`, `operatingCashMonths`, `destinations`, `approvers`, and optional diversification/risk terms). The request uses the existing fresh ownership, read-consent, agent-scope, JSON and same-origin checks. Agent tokens cannot invoke it.

The server reads current overview and autopilot status, validates the terms through the mandate compiler, and runs the same deterministic assessment with an explicit exit before proposal decisions. Missing, expired or future-dated prices refuse the request; an unsupported book or invalid mandate returns `assessment_unavailable`. Missing history is recorded honestly as an unusable projection with reasons. A successful response contains `risk` with its audit timestamp and sequence, and `proposed: false`.

The canonical audit writer returns the exact durable record it appended, so a concurrent watcher record cannot replace the response. Audit failure fails the request. The assessment has no proposal request ID; no platform mutation, proposal, grant, freeze, autopilot, watcher or schedule change occurs. Existing report, history, what-if and assistant reads use the same risk records.

When configured, history and engine state share the existing requests-file stores. Without a requests file, their paths are `<TREASURY_AUDIT_FILE>.assessment-history` and `.assessment-engine`. Only genuine observations populate history; a new installation cannot immediately produce a calibrated projection. Hosted numerical acceptance remains pending a real book and reviewed terms; do not fund an agent, enable watch or seed synthetic production records for this check.

Manual assessments admit one active request per owner organization and at most eight across the server. Additional requests return HTTP 429 with `assessment_busy` and start no platform reads. There is no waiting queue. Capacity is held until both platform reads settle and recording finishes, then released on success, refusal or failure.
