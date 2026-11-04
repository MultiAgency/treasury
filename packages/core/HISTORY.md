# Backtest price history (A8.2)

Until H5 names the price sources and supplies their data, the backtest runs on a **synthetic, seeded series**.

- `syntheticSeries(spec)` is a seeded random walk (`mulberry32`): each step multiplies the price by 1 + `driftPct`
  percent + a uniform draw in ±`stepVolPct` percent. The same spec always gives the same series; the seed is part of
  the spec.
- `warmupHistory(first, spanMs, stepMs, stepVolPct, seed)` builds the pre-history the 30-day EMA needs. It is a walk
  with **no drift** (it takes no `driftPct`) and a uniform draw in ±`stepVolPct` percent, run backwards from `first`
  (the series' first sample) with its own seed. It ends one step before `first` and starts `spanMs` before it, so the
  replay starts with a live EMA instead of 30 frozen days.
- `parseHistory(text)` loads real data later: `timestamp,price` lines, the timestamp in Unix ms (integer digits) or ISO
  8601 with `Z` or a ±hh:mm offset; a timestamp without a zone is refused, never read in the machine's own zone. Only a
  first row that is the `timestamp,price` header is skipped; any other row that can't be read fails the whole load, as
  do two prices at one instant, a gap over 6 hours, or a span under 12 months.
- `calibrationReport({ series, seedHistory, start, config })` runs the replay itself, with the replay's default regime
  (a regime function can't be digested, so a calibration takes none), and returns the data and a readable `summary`,
  or, when the replay refuses the run, `{ ok: false, problems }`.
  It lists every threshold used (`thresholds`, the whole config) and the starting portfolio, and carries a SHA-256
  digest of the inputs as canonical JSON: equal digests mean equal inputs.

Demo setup, rebuilt from this page alone:

```ts
import { calibrationReport, REPLAY_DEFAULTS, syntheticSeries, warmupHistory } from "@treasury/core";

const H = 3_600_000, DAY = 24 * H;
const series = syntheticSeries({ startAt: 1_800_000_000_000, startPrice: 100, count: 400 * 24, stepMs: H, stepVolPct: 1, driftPct: 0, seed: 3 });
const seedHistory = warmupHistory(series[0]!, 35 * DAY, H, 1, 5); // 35 days of hourly warm-up, seed 5
const start = { volatileUsd: 200_000, reserveUsd: 700_000, cashUsd: 100_000 };
const config = { ...REPLAY_DEFAULTS, policy: { ...REPLAY_DEFAULTS.policy, exposure: { ...REPLAY_DEFAULTS.policy.exposure, monthlySpendUsd: 10_000 } } };
const report = calibrationReport({ series, seedHistory, start, config });
if (!report.ok) throw new Error(report.problems.join("; ")); // a run the replay refuses has no numbers
```

The tests run the same setup on its first 60 days (`count: 60 * 24`).
