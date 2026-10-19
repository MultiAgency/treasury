# PnL data needs

Treasury does not report profit and loss. The overview shows holdings, allocation against targets,
budget headroom and recorded operations. A change in book value between two observations is not
profit: it mixes price movement, deposits, withdrawals, payouts, fees and operations sent by other
clients. This note lists what a performance figure would need. Nothing here is implemented.

## Definition to agree first

- **Period:** start and end instants (UTC), and whether open operations at either end are excluded.
- **Valuation source:** which price at which instant values each asset, and what happens when a price
  is stale or missing. `src/valuation.ts` treats stale or unverifiable prices as unknown. A PnL figure
  must keep that behaviour, not substitute zero or the last price.
- **Reporting currency:** USD as quoted by the provider's token prices, or another reference.
- **Method:** simple value change net of flows, time-weighted return (independent of flow timing) or
  money-weighted return (depends on flow timing). These answer different questions.
- **Scope:** public and confidential balances together or separately, and whether unmanaged assets count.

## Data required, and what exists

| Need | Exists today | Gap |
|---|---|---|
| Opening and closing balances per asset | Live provider balances (`overview`) | No retained balance snapshot at an arbitrary past instant |
| Prices at both instants | Live provider token prices with freshness | No retained price history; past prices cannot be reconstructed from current reads |
| External flows (deposits, withdrawals, payouts) | Ledger rows from provider history; `kind` is null for actions this server did not send | Deposits have no recorded USD value at arrival; flows from other clients are not attributed |
| Swaps and their costs | Journal operations with request amounts, `usdIn` at send, plan ID and provider status; ledger rows from provider history with `amountIn`/`amountOut` | No USD value of the output at execution, so realised cost per swap is not recorded; floors and quotes are not fills |
| Fees | Not separated | Provider and network fees need a source |
| Unexplained differences | Books compare balances with outside records | A difference stays unexplained, so a figure over that period has an unknown component |

## Consequences for the demo

The strategy demo shows the plan's recorded operations and the simulator's balances. The simulator
uses fixed prices and instant settlement, so any "return" it showed would be an artefact of the
fixture. Present balances, budget headroom and operation outcomes only.
