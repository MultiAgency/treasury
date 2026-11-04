# Backtest price history (A8.2)

Until H5 names the price sources and supplies their data, the backtest runs on a **synthetic, seeded series**.

- `syntheticSeries(spec)` is a seeded random walk (`mulberry32`): each step moves by a uniform draw in ±`stepVolPct`
  percent plus `driftPct`. The same spec always gives the same series; the seed is part of the spec.
- `warmupHistory(first, spanMs, stepMs, stepVolPct, seed)` builds the pre-history the 30-day EMA needs. It is the same
  kind of walk run backwards from the first price of the series, so the replay starts with a live EMA instead of 30
  frozen days. Pass it to `replay(..., seedHistory)`.
- `parseHistory(text)` loads real data later: `timestamp,price` lines (Unix ms or ISO). It fails the whole load on a bad
  row, two prices at one instant, a gap over 6 hours, or a span under 12 months.
- `calibrationReport(...)` returns the data and a readable `summary`; it lists every threshold used and an input digest.

Demo setup: 400 days of hourly samples, `stepVolPct` 1, `driftPct` 0, seed 3, 35 days of warm-up, start portfolio
200,000 volatile / 700,000 reserve / 100,000 cash, monthly spend 10,000.
