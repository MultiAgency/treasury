// The hedge planner (#221): the moves that would put part of the treasury into gold and other chains' assets through NEAR
// Intents, and the moves that keep a stablecoin split on its peg, each marked executable now or blocked with every reason.
// Pure: holdings, prices and dry-run quotes in, a plan out. It sends nothing, builds no request and holds no key; the
// server turns an executable move into a proposal for the owner to approve, through the flow that already exists.
//
// What makes a move executable, all of it at once:
// - both assets are among the platform's proposal assets (`proposable`): the platform's list, not the registry, decides;
// - a fresh dry-run quote covers its size, and its whole cost (spread, impact and fee) is inside `maxCostBps`;
// - the buy leaves every venue on the asset's path and its class inside their caps (`checkBookExposure`), counted after
//   the sale that funds it, and inside the asset's liquidity limit;
// - a buy of a risk asset is funded from the reserve above the cash floor, and never while forward risk is raised
//   (Ballast buys nothing at L1 or above, and neither does this).
// A move that fails any of them is still listed, with each failure by code, so the owner sees what the book would do the
// day the platform lists the asset. Money logic fails closed: terms, caps, holdings or prices it can't read give no plan.

import { ASSET_REGISTRY, isRisk, proposable, type AssetEntry } from "./assets.ts";
import type { Intent } from "./bands.ts";
import { bookContext, checkBookExposure, type BookExposureLimits, type ValuedHolding } from "./exposure.ts";
import { quoteCostBps, quoteProblems, type DryQuote } from "./intents.ts";
import type { Level } from "./levels.ts";
import { isLevel } from "./levels.ts";
import { planStableMoves, STABLE_DEFAULTS, type StableLimits, type StableMove, type StableSplit } from "./stables.ts";
import { isNum, isPct, isPositive, report } from "./validate.ts";

/** An asset the owner wants some exposure to besides the two-asset book: its registry symbol, a target and a ceiling, in percent of the treasury. */
export type HedgeSleeve = { asset: string; targetPct: number; maxPct: number };

export type HedgeTerms = {
  sleeves: readonly HedgeSleeve[];
  /** The largest single move, in USD. */
  maxMoveUsd: number;
  /** A quote that costs more than this, in basis points of what is spent, blocks its move. */
  maxCostBps: number;
  /** A quote older than this, in ms, blocks its move. */
  maxQuoteAgeMs: number;
  /** Forward risk at or above this level moves volatile assets into the hedge sleeves, up to their ceilings. */
  hedgeAtLevel: 1 | 2 | 3;
  /** A hedge sleeve is topped up to its target only once it is this many points of the treasury under it. */
  driftPoints: number;
  /** One hedge move sells at most this percent of the volatile asset it sells. */
  maxSourceSharePct: number;
};

export const HEDGE_DEFAULTS: Omit<HedgeTerms, "sleeves"> = {
  maxMoveUsd: 25_000, maxCostBps: 100, maxQuoteAgeMs: 120_000, hedgeAtLevel: 2, driftPoints: 1, maxSourceSharePct: 50,
};

/** What is wrong with the terms, if anything. */
export function hedgeTermsProblems(t: HedgeTerms, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): string[] {
  const r = report();
  try {
    r.need(Array.isArray(t.sleeves) && t.sleeves.length >= 1 && t.sleeves.length <= 8, "a hedge needs one to eight sleeves");
    const seen = new Set<string>();
    for (const s of t.sleeves) {
      const entry = registry[s.asset];
      r.need(!seen.has(s.asset), `${s.asset} is a hedge sleeve twice`);
      seen.add(s.asset);
      r.need(entry !== undefined, `${s.asset} isn't in the asset registry`);
      r.need(entry === undefined || (isRisk(entry) && entry.id !== null), `${s.asset} isn't a risk asset NEAR Intents carries: a hedge sleeve is volatile, or a real-world asset that isn't cash`);
      r.need(isPct(s.targetPct) && isPct(s.maxPct) && s.targetPct <= s.maxPct, `${s.asset}: the target and ceiling must be percents above 0, the target at most the ceiling`);
    }
    r.need(isPositive(t.maxMoveUsd), "maxMoveUsd must be above zero");
    r.need(isNum(t.maxCostBps) && t.maxCostBps > 0 && t.maxCostBps <= 10_000, "maxCostBps must be above 0 and at most 10,000");
    r.need(isPositive(t.maxQuoteAgeMs), "maxQuoteAgeMs must be above zero");
    r.need(t.hedgeAtLevel === 1 || t.hedgeAtLevel === 2 || t.hedgeAtLevel === 3, "hedgeAtLevel must be 1, 2 or 3");
    r.need(isPct(t.driftPoints), "driftPoints must be above 0 and at most 100");
    r.need(isPct(t.maxSourceSharePct), "maxSourceSharePct must be above 0 and at most 100");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    r.need(false, `the hedge terms are missing a field (${error.message})`);
  }
  return r.problems;
}

export type HedgeInput = {
  at: number;
  /** The book by registry symbol. */
  holdings: readonly ValuedHolding[];
  terms: HedgeTerms;
  caps: BookExposureLimits;
  /** The protected operating cash, in USD: stablecoins above it are the reserve a buy may spend. */
  cashFloorUsd: number;
  /** The forward level, with the level the rest of the system is at: buys of new risk hold from L1. */
  level: Level;
  /** Dry-run quotes taken for this plan's moves (`hedgeQuoteRequests` names them). */
  quotes: readonly DryQuote[];
  /** The reserve's split and the peg checks, when the plan should also keep the stablecoins on their peg. */
  stable?: { split: StableSplit; prices: Readonly<Record<string, number | null>>; limits?: StableLimits };
};

export type BlockCode =
  | "not_listed" | "no_quote" | "stale_quote" | "quote_size" | "quote_cost"
  | "risk_level" | "venue_cap" | "class_cap" | "order_size" | "no_cap" | "cash_floor" | "invalid";
/** Blockers that say the asset or its quote isn't ready, not that the book can't take the move: the move still counts when it plans the rest. */
const READINESS: ReadonlySet<BlockCode> = new Set<BlockCode>(["not_listed", "no_quote", "stale_quote", "quote_size", "quote_cost"]);

export type HedgeKind = "hedge" | "rebalance" | "trim" | "depeg-exit";
/** The leg shape a move needs: `legsFor` builds only volatile against the reserve; the rest are `swapLegsFor`'s. */
export type HedgeShape = "stable-to-risk" | "risk-to-stable" | "risk-to-risk" | "stable-to-stable";
export type HedgeBlock = { code: BlockCode; reason: string };

export type HedgeMove = {
  id: string;
  kind: HedgeKind;
  shape: HedgeShape;
  /** Registry symbols. */
  from: string; to: string;
  sizeUsd: number;
  reason: string;
  status: "executable" | "blocked";
  blocked: HedgeBlock[];
  /** The quote the move was judged on: its cost and age, or null when none covers it. */
  quote: { costBps: number; ageMs: number } | null;
};

export type HedgePlan =
  | { ok: true; moves: HedgeMove[]; notes: string[] }
  | { ok: false; problems: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;
const shapeOf = (from: AssetEntry, to: AssetEntry): HedgeShape =>
  `${isRisk(from) ? "risk" : "stable"}-to-${isRisk(to) ? "risk" : "stable"}` as HedgeShape;

/** The quote covering a move: the newest for its pair taken at a size at least the move's (a smaller quote says nothing of a larger one). */
function quoteFor(quotes: readonly DryQuote[], from: string, to: string): DryQuote | undefined {
  return quotes.filter(q => q.from === from && q.to === to && quoteProblems(q).length === 0).sort((a, b) => b.at - a.at)[0];
}

/**
 * The quotes a plan needs: one per distinct move in its sizing pass (a plan made with no quotes lists each move with
 * `no_quote`), so the server asks for those and plans again with the answers. `sizeUsd` is rounded up to a whole dollar,
 * so a quote covers the cents the move's size is cut to.
 */
export function hedgeQuoteRequests(plan: HedgePlan): { from: string; to: string; sizeUsd: number }[] {
  if (!plan.ok) return [];
  const out = new Map<string, { from: string; to: string; sizeUsd: number }>();
  for (const m of plan.moves) {
    if (m.blocked.some(b => !READINESS.has(b.code))) continue;
    const key = `${m.from}>${m.to}`, size = Math.ceil(m.sizeUsd);
    const had = out.get(key);
    if (!had || had.sizeUsd < size) out.set(key, { from: m.from, to: m.to, sizeUsd: size });
  }
  return [...out.values()];
}

/**
 * The plan: for each hedge sleeve, trim it back to its target when it is over its ceiling, move volatile assets into it
 * when forward risk reaches `hedgeAtLevel`, and top it up from the reserve when it is under its target and risk is calm;
 * then the stablecoin moves, when a split is given. Moves are made in that order against a working copy of the book, so a
 * later move sees the sale and the buy of the earlier ones. A readable plan can be empty: nothing to do is a plan.
 */
export function planHedge(input: HedgeInput, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): HedgePlan {
  const r = report();
  try {
    for (const p of hedgeTermsProblems(input.terms, registry)) r.need(false, p);
    r.need(isNum(input.at), "at must be a time");
    r.need(isNum(input.cashFloorUsd) && input.cashFloorUsd >= 0, "cashFloorUsd must be zero or more");
    r.need(isLevel(input.level), "level must be an escalation level");
    r.need(Array.isArray(input.holdings) && Array.isArray(input.quotes), "holdings and quotes must be lists");
    const seen = new Set<string>();
    for (const h of input.holdings) {
      r.need(registry[h.asset] !== undefined && isNum(h.usd) && h.usd >= 0 && !seen.has(h.asset), `${h.asset}: not a registry asset with a usable value, listed once`);
      seen.add(h.asset);
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    r.need(false, `the hedge input is missing a field (${error.message})`);
  }
  if (r.problems.length > 0) return { ok: false, problems: r.problems };

  const { at, terms, caps, cashFloorUsd, level, quotes } = input;
  const work = new Map<string, number>(input.holdings.map(h => [h.asset, h.usd]));
  const usdOf = (symbol: string) => work.get(symbol) ?? 0;
  const total = [...work.values()].reduce((sum, x) => sum + x, 0);
  if (!(total > 0)) return { ok: false, problems: ["the book is worth nothing"] };
  const pct = (p: number) => (p * total) / 100;
  const holdingsNow = (): ValuedHolding[] => [...work.entries()].map(([asset, usd]) => ({ asset, usd }));
  const hedgeAssets = new Set(terms.sleeves.map(s => s.asset));
  const stableCoins = Object.values(registry).filter(e => e.class === "stable");
  const reserveUsd = () => Math.max(0, stableCoins.reduce((sum, e) => sum + usdOf(e.symbol), 0) - cashFloorUsd);
  const moves: HedgeMove[] = [], notes: string[] = [];

  /** Judges one move against the book as it stands, adds it, and applies it to the working copy when the book can take it. */
  const add = (kind: HedgeKind, from: AssetEntry, to: AssetEntry, wanted: number, reason: string) => {
    // New risk is bought from the reserve above the cash floor, never from the floor itself.
    const funds = shapeOf(from, to) === "stable-to-risk" ? reserveUsd() : Number.POSITIVE_INFINITY;
    const size = round2(Math.min(wanted, terms.maxMoveUsd, usdOf(from.symbol), funds, from.liquidity.maxOrderUsd, to.liquidity.maxOrderUsd));
    if (!(size > 0)) return;
    const blocked: HedgeBlock[] = [];
    for (const e of [from, to]) if (!proposable(e)) blocked.push({ code: "not_listed", reason: `${e.symbol} isn't among the platform's proposal assets: it can't be traded until the platform lists it` });
    // The book after the sale that funds the buy, so the buy is judged on what it would leave, not on what is there now.
    // The caps bound risk exposure, so they judge a buy of a risk asset only: a move into a stablecoin (a trim, a depeg
    // exit) only lowers it, and is never refused for a cap.
    const after = holdingsNow().map(h => h.asset === from.symbol ? { ...h, usd: Math.max(0, h.usd - size) } : h);
    const ctx = to.class === "stable" ? undefined : bookContext(to.symbol, after, total, registry);
    if (ctx === null) blocked.push({ code: "invalid", reason: "the book's venue exposure can't be read" });
    else if (ctx !== undefined) {
      // The platform's list is judged above; here only the caps, so a move shows both its listing and its cap failures.
      const intent: Intent = { id: "hedge", zone: "hold", action: "buy-volatile", sizeUsd: size, dcaUnits: 0, reason, at };
      const verdict = checkBookExposure(intent, { ...ctx, asset: { ...ctx.asset, proposable: true } }, caps);
      if (verdict.ok === false) for (const rule of verdict.failed) blocked.push({
        code: rule === "VENUE_EXPOSURE" ? "venue_cap" : rule === "CLASS_EXPOSURE" ? "class_cap" : rule === "ORDER_SIZE" ? "order_size" : /no cap set/.test(verdict.detail) ? "no_cap" : "invalid",
        reason: rule === "CLASS_EXPOSURE" && caps.classCapsPct[to.class] === undefined ? `the mandate doesn't allow ${to.class} assets: it sets no ${to.class} cap` : verdict.detail,
      });
    }
    // A buy of new risk from stablecoins is funded from the reserve above the floor, and holds while forward risk is raised.
    if (shapeOf(from, to) === "stable-to-risk") {
      if (level >= 1) blocked.push({ code: "risk_level", reason: `forward risk is at L${level}: Ballast buys nothing at L1 or above, and neither does the hedge` });
      if (size > reserveUsd() + 1e-9) blocked.push({ code: "cash_floor", reason: `${size} USD would take the stablecoins under the ${cashFloorUsd} USD cash floor` });
    }
    const quote = quoteFor(quotes, from.symbol, to.symbol);
    let judged: HedgeMove["quote"] = null;
    if (!quote) blocked.push({ code: "no_quote", reason: `no live NEAR Intents quote for ${from.symbol} to ${to.symbol}` });
    else {
      const ageMs = at - quote.at, cost = quoteCostBps(quote);
      judged = { costBps: cost === null ? Number.NaN : Math.round(cost * 10) / 10, ageMs };
      if (!(ageMs >= 0) || ageMs > terms.maxQuoteAgeMs) blocked.push({ code: "stale_quote", reason: `the quote is ${Math.round(ageMs / 1000)} s old, over the ${Math.round(terms.maxQuoteAgeMs / 1000)} s allowed` });
      else if (quote.amountInUsd + 1e-9 < size * 0.99) blocked.push({ code: "quote_size", reason: `the quote covers ${round2(quote.amountInUsd)} USD, under the ${size} USD move` });
      else if (cost === null || cost > terms.maxCostBps) blocked.push({ code: "quote_cost", reason: `the quote costs ${cost === null ? "an unreadable amount" : `${cost.toFixed(1)} bps`}, over the ${terms.maxCostBps} bps allowed` });
    }
    moves.push({ id: `${kind}:${from.symbol}>${to.symbol}`, kind, shape: shapeOf(from, to), from: from.symbol, to: to.symbol, sizeUsd: size, reason,
      status: blocked.length === 0 ? "executable" : "blocked", blocked, quote: judged });
    if (blocked.every(b => READINESS.has(b.code))) {
      work.set(from.symbol, usdOf(from.symbol) - size);
      work.set(to.symbol, usdOf(to.symbol) + size);
    }
  };

  /** The reserve coin a sale goes into, or a buy comes out of: the largest holding, a proposable coin before any other. */
  const reserveCoin = (): AssetEntry | undefined => [...stableCoins].sort((a, b) =>
    Number(proposable(b)) - Number(proposable(a)) || usdOf(b.symbol) - usdOf(a.symbol) || (a.symbol < b.symbol ? -1 : 1))[0];

  for (const sleeve of terms.sleeves) {
    const entry = registry[sleeve.asset]!, cash = reserveCoin();
    const cur = usdOf(sleeve.asset), targetUsd = pct(sleeve.targetPct), maxUsd = pct(sleeve.maxPct);
    if (cur > maxUsd + 1e-9) {
      if (cash) add("trim", entry, cash, cur - targetUsd, `${sleeve.asset} is ${round2((cur / total) * 100)}% of the treasury, over its ${sleeve.maxPct}% ceiling: trim to its ${sleeve.targetPct}% target`);
      continue;
    }
    if (level >= terms.hedgeAtLevel) {
      const sources = [...work.entries()].map(([symbol, usd]) => ({ entry: registry[symbol]!, usd }))
        .filter(s => s.entry.class === "volatile" && !hedgeAssets.has(s.entry.symbol) && s.usd > 0)
        .sort((a, b) => b.usd - a.usd || (a.entry.symbol < b.entry.symbol ? -1 : 1));
      const room = maxUsd - cur;
      if (sources[0] && room > 0)
        add("hedge", sources[0].entry, entry, Math.min(room, (sources[0].usd * terms.maxSourceSharePct) / 100),
          `forward risk is at L${level}: move ${sources[0].entry.symbol} into ${sleeve.asset}, which holds ${round2((cur / total) * 100)}% against a ${sleeve.maxPct}% ceiling`);
      else if (!sources[0]) notes.push(`${sleeve.asset}: forward risk is at L${level}, but no volatile asset is held to move into it`);
      continue;
    }
    if (targetUsd - cur >= pct(terms.driftPoints) && cash)
      add("rebalance", cash, entry, targetUsd - cur, `${sleeve.asset} is ${round2((cur / total) * 100)}% of the treasury, under its ${sleeve.targetPct}% target: top up from the reserve`);
  }

  if (input.stable) {
    const held = stableCoins.filter(e => usdOf(e.symbol) > 0 || input.stable!.split[e.symbol] !== undefined).map(e => ({ asset: e.symbol, usd: usdOf(e.symbol), price: input.stable!.prices[e.symbol] ?? null }));
    const plan = planStableMoves(held, input.stable.split, input.stable.limits ?? STABLE_DEFAULTS, registry);
    if ("problems" in plan) notes.push(`the stablecoin split can't be planned: ${plan.problems.join("; ")}`);
    else {
      const wanted: StableMove[] = [...plan.moves, ...plan.blocked.flatMap(b => b.move ? [b.move] : [])];
      const unique = new Map(wanted.map(m => [`${m.from}>${m.to}`, m]));
      for (const m of unique.values()) {
        const depeg = /off its peg/.test(m.reason);
        add(depeg ? "depeg-exit" : "rebalance", registry[m.from]!, registry[m.to]!, m.sizeUsd, m.reason);
      }
      for (const b of plan.blocked) if (!b.move) notes.push(`${b.asset}: ${b.reason}`);
    }
  }
  return { ok: true, moves, notes };
}
