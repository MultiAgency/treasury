# Proving a multi-day unattended run

**Status: not run.** This page is the plan and the checklist. Nothing here starts a run, moves funds or
authorizes either. A live run touches real funds on mainnet, so the owner has to say go, name the
account and set the limits; until then [multi-day unattended operation is not demonstrated](../README.md).

The question is the same as for the 24-hour observation in
[operations](operations.md#unattended-run-observing-the-treasury-autopilot): does the scheduler run on
its own, for several days, without missed ticks, duplicate execution, actions outside its schedule or
manual recovery? It does not show custody guarantees or economic benefit, and a longer window does not
make it. Read [enforcement](enforcement.md) for those claims.

## What exists and what a longer run adds

The scheduler records every tick itself (`.evidence/<agent id>.jsonl`), the gateway records every
operator call, and `pnpm run-report` judges them together. None of that depends on the window being a
day. Two things were added for runs of several days:

- `MIN_HOURS=72 pnpm run-report` states how long the run was supposed to be, and the report says whether
  the window was ("Window covers at least 72 h").
- The report has a "Coverage by day (UTC)" table: per day, scheduled ticks completed, operator-triggered,
  executed, no-op, refused, failed, skipped, incomplete, and gaps starting. A gap is counted on the day it
  starts. It counts; it does not judge. The criteria above it do.

`test/report.test.ts` runs the report on synthetic 72-hour evidence: a clean run, a gap on day two (and
one that crosses midnight), a build change, a failure on day three, an operator action, the same plan
leg executed on two days, and the minimum-length check. That shows the report judges a multi-day window
correctly. It does not show the agent runs for days.

## Before anything starts (the owner decides these)

1. **Authorization.** The owner states in writing that a live run may start, on which agent, for how long,
   and what it may spend. `pnpm test:live` and scheduled mainnet runs move real funds and are never
   started on their own.
2. **A low-value account.** Use the smallest balance that lets the strategy trade at its minimum leg
   (the strategy's `minLegUsd`). Signed limits stay low enough that losing the whole budget is acceptable:
   per-asset monthly caps and the cross-asset USD budget. Spending caps do not bound market exposure,
   so the balance is the bound.
3. **One executor.** The agent runs on one host; no second executor shares its state
   ([operations](operations.md#executor-migration-and-state-preservation)).
4. **A reviewed build.** Deploy from a reviewed snapshot and record the deployment id, image digest, and
   the digests of `src/`, `pnpm-lock.yaml` and `package.json`.
5. **Backups.** A stopped-writer backup of the state volume before the window, so a bad outcome can be
   examined and nothing is lost.
6. **The window.** At least 72 hours is the suggestion; the owner picks it. Use the same number for
   `MIN_HOURS` throughout.

## Starting the window

Follow the steps in the detailed procedure (linked from
[operations](operations.md#unattended-run-observing-the-treasury-autopilot)): confirm the autopilot is on and hourly and that the live
grant approves the strategy in force; wait for the first scheduled tick; its start line must match the
deployment id and the three digests; the window starts at that tick, in UTC.

## During the window

Do not press "Run now", force imbalances, raise limits or manufacture trades. A correct no-op or refusal
is a valid outcome. Any operator action, payment or approval is reported as an incident, never hidden.

A read-only progress report is safe at any time, once a day is plenty:

```sh
DASHBOARD_URL=https://<dashboard> REPORT_COOKIE_FILE=<0600 file> \
SINCE=<window start> MIN_HOURS=72 OUT=<outside the repo>/progress.md pnpm run-report
```

`UNTIL` defaults to now, so "Window covers at least" reads "no" until the window is long enough. That is
expected mid-run. In builds where reading the evidence is an operator call, the gateway records each read;
the report lists those apart from interventions.

Also once a day, read-only: `pnpm reconcile` lists any money action without a proven outcome. Nothing is
resent.

### When to stop

Stop the schedule (the owner, from the dashboard's schedule control) and write the incident up if any of
these happens. Stopping is itself an operator action and is reported as one.

- A confirmed or suspected duplicate execution.
- An operation unresolved and needing manual recovery.
- A tick that cannot read its book or mandate, repeatedly.
- The budget or caps being approached faster than the strategy should spend them.
- Anything that makes the owner unwilling to leave the funds there.

A run that stops early is a result, not a failure to hide. Report the window it did cover.

## Ending the window

```sh
DASHBOARD_URL=https://<dashboard> REPORT_COOKIE_FILE=<0600 file> \
SINCE=<window start> UNTIL=<window end> MIN_HOURS=72 OUT=<outside the repo>/report.md pnpm run-report
```

Then `pnpm reconcile` (and `pnpm reconcile --poll` only if something is open: status reads, nothing is
resent) and compare the books with the report's executions. Keep the full report, the evidence export and
any recordings outside the repository.

## What to write down

Add a section to [the mainnet log](mainnet-log.md), as its other entries do. Fill every field from the
report and the deployment record; leave a field out rather than guess it.

```markdown
## Multi-day unattended run, <start> → <end> UTC (<N> h)

Agent <name> on <host>, deployment <id>, image digest <digest>; source <sha256>, lockfile <sha256>,
package.json <sha256>. Policy revision <n> (<digest>), strategy <digest>, grant <id> "<label>".
Schedule: every <n> min, limit $<n>. Account funded with $<n>; caps <list>.

Result (from the report, `MIN_HOURS=<n>`):
- Window covers at least <n> h: <yes/no> (<h> h)
- Scheduled ticks completed without unexplained gaps: <yes/no> (<n> gaps)
- Every started tick recorded its end: <yes/no>
- No duplicate execution: <yes/no/suspected/cannot be established>
- No duplicate references, operator interventions, failed executions, unread books, unreadable lines: <each>
- <ticks> ticks: <executed> executed, <no-op> no-op, <refused> refused, <failed> failed, <skipped> skipped, <incomplete> incomplete.
- Per day: <one line each, or "see report">

Incidents: <each, with its tick time and what was done; "none recorded" only if the report says so>.
Unresolved operations: <listed, not hidden>. Books vs. report: <matched / differences>.

This shows <operation only>. It does not show atomic budgets, strict caps, the bought asset, exposure
bounds or savings. Report and recordings are held privately.
```

## What to change in the docs afterwards

Only after a run, and only to what it showed:

- If it met every criterion for the stated window: replace "Multi-day unattended operation is not
  demonstrated" in the README and "The agent has not yet run unattended for days" in
  [treasury](treasury.md) with "Operated unattended for <N> hours on <date>; see the mainnet log". Keep
  "Scheduling is not settlement evidence." and the custody and exposure caveats as they are.
- If it did not: say what it did show, which criterion failed and what was changed, and keep the gap
  listed. A shorter clean stretch is stated as that length, not rounded up.
- Update the "Unattended run" section in [operations](operations.md): the gap line, and the pointer to
  the entry.
