# The hedge and NEAR Intents (#221)

The owner's Strategy page shows **Hedge into gold and other chains**: NEAR Intents' live prices against the asset registry, and the moves that would put part of the treasury into gold or another chain's assets. Reading it proposes nothing; an executable move is proposed by its own button, which plans it again on the server and puts it on the Proposals page for the owner's signature (or the DAO's vote).

- **Core:** `packages/core/src/hedge.ts` (the planner), `intents.ts` (the token list and quotes as untrusted data, `registryDrift`), `legs.ts` (`swapLegsFor`).
- **Server:** `apps/server/src/intents.ts` (the NEAR Intents client and its stub), `hedge.ts` (the read and the legs), `hedge-tool.ts` (the same read as one assistant tool).
- **Routes:** `GET /api/agents/:agent/hedge`, `POST /api/agents/:agent/hedge/propose`. See [app-server.md](app-server.md).
- **Page:** `web/src/proposals/hedge.tsx` and `hedge-view.ts`.

## What NEAR Intents is asked, and what is sent

Two calls to `https://1click.chaindefuser.com`: `GET /v0/tokens` (the list, cached a minute) and `POST /v0/quote` with `dry: true` (a price; it reserves no deposit address and moves nothing). Both are public and keyless. A dry quote needs a sender, refund and recipient: the server sends a fixed placeholder account (`treasury-dry-run.near`) for all three, so the API learns neither which treasury is asking nor any account of its. Each call is limited (`INTENTS_CALLS_PER_HOUR`, 120 by default, for the whole deployment), times out after 10 seconds, refuses an answer over 2 MB and a redirect, and is recorded in the audit log as `intents-read`, its attempt before it goes out and its result after, by the SHA-256 of the request and of the answer. A call that can't be recorded isn't made. The answers are untrusted: parsed by the core's checks, dropped entry by entry when malformed, and never repeated as an instruction.

A quote's cost is NEAR Intents' own USD valuation of what goes in less what comes out, in basis points: spread, price impact and the service's fee together. The planner blocks a move whose quote costs more than `maxCostBps` (100 by default; a USDC-to-gold quote on 2026-11-10 cost about 31).

**What it doesn't do:** sign anything, hold a key, or trade outside a platform proposal. The platform's list of proposal assets decides what can be proposed, and today that is wNEAR, USDC and ETH. Gold (`XAUT`, the only gold on NEAR Intents' list; `PAXG` isn't on it), BTC and SOL are planned and **blocked with `not_listed`** until the platform lists them, shown with their live price and quote so the owner sees what the book would do. Nothing in this repo claims support the platform doesn't have.

## What makes a move executable

All at once (`planHedge`):

1. Both assets are among the platform's proposal assets.
2. A quote taken at least as large as the move, younger than `maxQuoteAgeMs` (2 minutes), costs at most `maxCostBps`.
3. The buy leaves every venue on the asset's path (the account, and each bridge it crossed) and its class inside their caps, **counted after the sale that funds it**; a class with no cap isn't allowed (gold needs the owner's `classCapsPct.rwa`), and a venue with no cap refuses (a bridge with none set gets the profile's `BRIDGE_CAP_PCT`, said in the plan's notes).
4. A buy of new risk is funded from the reserve above the cash floor, and holds while forward risk is at L1 or above, as Ballast's buys do. A hedge from a volatile asset into the sleeve is risk-neutral, so it runs at the hedge level (`hedgeAtLevel`, L2 by default).
5. Its swap can be built (`swapLegsFor`, at the mandate's slippage and the platform's prices; the list's price for an asset the book doesn't hold).

A move that fails any is listed `blocked` with each failure by code: `not_listed`, `no_quote`, `stale_quote`, `quote_size`, `quote_cost`, `risk_level`, `venue_cap`, `class_cap`, `order_size`, `no_cap`, `cash_floor`, `invalid`. A move the book refuses on a cap isn't quoted (no call is spent on it). These checks are app-side and only hold back: the platform's signed policy has the last word.

## Configuration

An agent's `ballast.hedge` block in the watch file (checked at load by the planner's own checks; no part of the mandate, so its digest is unchanged):

```json
{
  "sleeves": [{ "asset": "XAUT", "targetPct": 5, "maxPct": 10 }, { "asset": "ETH", "targetPct": 10, "maxPct": 20 }],
  "classCapsPct": { "rwa": 10 },
  "venueCapsPct": { "omft-ethereum": 20 }
}
```

Optional limits: `maxMoveUsd` (25,000), `maxCostBps` (100), `maxQuoteAgeMs` (120,000), `hedgeAtLevel` (2), `driftPoints` (1), `maxSourceSharePct` (50). Server: `INTENTS_PROVIDER` (`live` by default, `stub` for a deterministic list and quotes that send nothing, `off`), `INTENTS_CALLS_PER_HOUR`.

## The stabilization agent on the same book

A watch entry may carry `risk` beside `diversification` (ADR 6): the agent assesses every holding with the bridges it crossed, so a bridge outage is a scenario of its own, and a de-risk sell is the largest asset the swap can price. The hedge plan reads its latest level from the audit log.

## Not built

`watch` doesn't act on a hedge by itself: the owner proposes a move from the page. The three-independent-source price oracle (H5) isn't built; the dry quote is one more source, not a replacement for it. Real-history backtests of the hedge's drawdown benefit (#221's "Done when") need H5's history and are not claimed: `docs/diversified-backtest.md` is synthetic.
