# Stabilization backtest (#220)

**Generated output:** `node scripts/stabilization-backtest.ts run`. Do not edit by hand; rerun the script. It is the
comparison the issue asks for: Ballast's bands alone against the stabilization agent, on the same hourly history.

> **The history here is a deterministic synthetic placeholder, not market history.** It is a seeded random walk with the
> issue's 50% six-hour crash laid over it (day 180), a month at the low and a two-month recovery, so the machinery and
> the report can be exercised before A8.2/H5 load real hourly NEAR-USD. No number below says what the agent would have done
> in a real market, and none is evidence of returns. `run --csv <file>` runs the same comparison on a real 12+ month
> `timestamp,price` series and labels it as such.

## Inputs

| | |
| --- | --- |
| History | deterministic synthetic placeholder: a seed-220 walk, 50% down over six hours at day 180, a month at the low, two months back up |
| Series SHA-256 | `7e66f105bbfa2be11e827a1caf9afcdc906ecc18eefc95c4a46b66a735b5f204` |
| Configuration SHA-256 | `535c217d66261a99cf8c706daf57f8e51f9e7806dd1beda34068c946b83ea911` |
| Inputs SHA-256 | `74798bbdc7f7ba4a381462ca854f3a40d0489f55e76ed21ed653be6d62c5d83a` |
| Arm start | $40,000 wNEAR, $35,000 reserve, $25,000 operating cash |
| Profile | balanced (40/35/25, trim 20/30/45, DCA −20/−30/−40, halt −50, 2% order / 10% turnover) |
| Spend terms | $2,000 a month, 6 months protected: a $12,000 cash floor |
| Projection | 200 paths, 7-day horizon, 14-day lookback, seed 220 |
| Risk thresholds | balanced profile defaults (12/16/24% drawdown steps) |

The projection's `paths` is 200 here, not the server's 500, so 300 days can be assessed every hour in a script; the
thresholds are the profile's own.

## The comparison

| Arm | First de-risk | First Ballast sell | Max drawdown | End value | Lowest stables | Lowest runway above the floor (months) | Hours at L1+ | Trades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ballast's bands alone | never | 2025-08-31 01:00 | 25.2% | $103,281 | $58,436 | 23.2 | 0 | 7 |
| With the stabilization agent | 2025-06-30 01:00 | 2025-08-31 01:00 | 23.2% | $98,534 | $60,000 | 24.0 | 44 | 11 |

- **Proposal timing:** the stabilization agent's first de-risk sell is at 2025-06-30 01:00 (day 180.0); Ballast's bands alone first sell at 2025-08-31 01:00 (day 242.0).
  The stabilization agent de-risks earlier, as the issue asks.
- **Drawdown:** the stabilization arm's deepest fall is 2.0% smaller. Its end value is $4,747 lower, because it sold before the recovery: the protection costs upside, which is the trade it makes.
- **Runway and the cash floor:** both arms keep the stables above the $12,000 floor for every hour; the lowest stables are $58,436 alone and $60,000 with the agent. Runway is the stables at plan spend, measured each hour; the replay harness doesn't model spending flows, so this is the balance's runway, not a cash-flow forecast.
- **How to read the assumption:** every de-risk is a proposal the owner signs. The backtest assumes the owner approves each one, which is what lets the swaps fill; the audit trail makes the same assessment replayable whether or not the owner did.

## What it does not show

- **Real history:** A8.2/H5 load it; until then this is a placeholder, and the thresholds are `RISK_PROFILE_DEFAULTS`, not calibrated values.
- **A depeg, a venue outage or an oracle outage:** the scenarios are assessed and recorded each hour, but this two-asset series has one volatile asset and no stablecoin price of its own, so their effect on the treasury isn't simulated here.
- **Spending:** no payouts are made; the spend rate only sets the floor and the runway.
- **A freeze:** the agent only ever recommends one. There is no freeze without the owner's signature (#95), and the backtest has no owner.
