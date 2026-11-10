// The hedge, as the owner's page and the assistant read it (#221): NEAR Intents' token list against the registry, and the
// plan into gold and other chains' assets that the core's `planHedge` makes from the agent's book, the live prices and
// dry-run quotes. This module reads (one platform `overview`, the audit log's latest risk record, and NEAR Intents) and
// plans; it proposes nothing. A move becomes a proposal only when the owner asks for that one move, and then the route
// plans again and builds the legs here (`legsFor` below), so the owner never sends legs the server didn't just make.
//
// Everything fails closed and says so: a list or quote that can't be read blocks the moves it would price, a book the
// registry doesn't know or can't value gives no plan, and a cap that is missing refuses its move.

import { PROPOSAL_TOKENS, type OwnerOutput } from "@multiagency/sdk";
import {
  assetById, assetBySymbol, ASSET_REGISTRY, BRIDGE_CAP_PCT, centsDown, hedgeQuoteRequests, livePrices, planHedge, proposable, registryDrift,
  swapLegsFor, VENUE_IDS, compileMandate, type DryQuote, type HedgeMove, type IntentsToken, type Leg, type Level, type ProfileName,
} from "../../../packages/core/src/index.ts";
import { decimalOf, hedgeTermsOf, mandateAnswersOf, type BallastSettings } from "./ballast.ts";
import type { HedgeRead } from "./contract.ts";
import { termsOf } from "./diversification.ts";
import type { Intents } from "./intents.ts";
import type { LatestRisk } from "./risk.ts";

type Overview = OwnerOutput<"overview">;
/** The most dry quotes one plan asks for: each is a call against NEAR Intents' hourly budget. */
const MAX_QUOTES = 6;

export type HedgeDeps = { intents?: Intents; latestRisk?: LatestRisk; now?: () => number };
export type HedgeBuilt = { read: HedgeRead; legs: ReadonlyMap<string, Leg> };

const entryOf = (row: Overview["book"][number]) => assetById(row.asset) ?? assetBySymbol(row.symbol);

/**
 * The read for one agent, and the legs of each move that can be proposed. One overview read is the caller's; this asks
 * NEAR Intents for its list once (cached) and for at most `MAX_QUOTES` quotes, and the audit log for the latest risk level.
 */
export async function buildHedge(deps: HedgeDeps, { who, organization, agent, overview, settings }: {
  who: string; organization: string; agent: string; overview: Overview; settings: BallastSettings | undefined;
}): Promise<HedgeBuilt> {
  const at = (deps.now ?? Date.now)();
  const legs = new Map<string, Leg>();

  // NEAR Intents' list: what the registry is checked against, and the only source of a price for an asset the book doesn't hold.
  const listed = deps.intents ? await deps.intents.tokens(who) : undefined;
  const tokens: readonly IntentsToken[] = listed?.ok ? listed.value.tokens : [];
  const intentsRead: HedgeRead["intents"] = !deps.intents || !listed
    ? { source: "off", status: "off", fetchedAt: null, detail: "NEAR Intents isn't connected on this server: no live prices or quotes", rejected: 0 }
    : listed.ok ? { source: deps.intents.source, status: listed.stale ? "stale" : "ok", fetchedAt: listed.fetchedAt, detail: listed.stale ? "NEAR Intents couldn't be reached: this is the last list it gave" : null, rejected: listed.value.rejected }
      : { source: deps.intents.source, status: "unavailable", fetchedAt: null, detail: listed.detail, rejected: 0 };
  const drift = listed?.ok ? registryDrift(tokens, at) : [];
  const prices = listed?.ok ? livePrices(tokens, at) : {};
  const heldUsd = (symbol: string) => overview.book.reduce((sum, row) => sum + (entryOf(row)?.symbol === symbol ? (row.usd ?? 0) : 0), 0);

  const registry: HedgeRead["registry"] = Object.values(ASSET_REGISTRY).map(entry => ({
    symbol: entry.symbol, id: entry.id, class: entry.class, chain: entry.chain, route: entry.route, venues: [...entry.venues],
    proposable: proposable(entry),
    listed: listed?.ok ? entry.id !== null && tokens.some(t => t.assetId === entry.id) : null,
    priceUsd: prices[entry.symbol] ?? null, heldUsd: heldUsd(entry.symbol),
    drift: drift.filter(d => d.asset === entry.symbol).map(({ kind, detail }) => ({ kind, detail })),
  }));
  const base = { at, intents: intentsRead, registry, configured: Boolean(settings?.hedge), level: null as number | null };
  const none = (problems: string[], extra: Partial<HedgeRead> = {}): HedgeBuilt => ({ read: { ...base, plan: null, problems, ...extra }, legs });

  const hedge = settings?.hedge;
  if (!settings || !hedge) return none(["this agent's watch config has no hedge block: there are no hedge sleeves to plan"]);

  // The book, by registry symbol: an asset the registry doesn't know, or one without a value, can't be counted at any venue.
  const holdings: { asset: string; usd: number }[] = [];
  for (const row of overview.book) {
    const entry = entryOf(row);
    if (!entry) return none([`the book holds ${row.symbol}, which isn't in the asset registry: its venue exposure can't be counted`]);
    if (row.usd === null || !(row.usd >= 0)) return none([`${row.symbol} has no USD value: the book can't be valued`]);
    holdings.push({ asset: entry.symbol, usd: row.usd });
  }
  const total = holdings.reduce((sum, h) => sum + h.usd, 0);
  if (!(total > 0)) return none(["the book is worth nothing"]);

  // Caps: the mandate's (or the profile's defaults), the hedge block's over them, and a named default for a bridge a hedge
  // asset crosses that neither sets. A class with no cap isn't allowed: gold needs the owner's `classCapsPct.rwa`.
  const notes: string[] = [];
  const mandate = termsOf(settings, total);
  notes.push(...mandate.notes);
  const venueCapsPct: Record<string, number> = { ...(mandate.terms?.venueCapsPct ?? {}), ...(hedge.venueCapsPct ?? {}) };
  const classCapsPct = { ...(mandate.terms?.classCapsPct ?? {}), ...(hedge.classCapsPct ?? {}) };
  if (classCapsPct.stable === undefined) classCapsPct.stable = 100;
  for (const sleeve of hedge.sleeves) for (const venue of ASSET_REGISTRY[sleeve.asset]?.venues ?? []) {
    if (venueCapsPct[venue] !== undefined || venue === VENUE_IDS.intents) continue;
    venueCapsPct[venue] = BRIDGE_CAP_PCT[settings.profile as ProfileName];
    notes.push(`${venue}: no cap is set, so the ${settings.profile} profile's bridge default of ${venueCapsPct[venue]}% applies`);
  }

  const risk = deps.latestRisk ? await deps.latestRisk(organization, agent).catch(() => null) : null;
  const level = (risk?.entry.assessment.level ?? 0) as Level;
  const read = { ...base, level: risk ? level : null };
  if (!risk) notes.push("no stabilization assessment is recorded for this agent: the plan assumes forward risk is calm");

  const stablePrices: Record<string, number | null> = {};
  for (const entry of Object.values(ASSET_REGISTRY)) if (entry.class === "stable") {
    const row = overview.book.find(r => entryOf(r)?.symbol === entry.symbol);
    stablePrices[entry.symbol] = row?.price ?? prices[entry.symbol] ?? null;
  }
  const split = mandate.terms?.stableSplit;
  const input = {
    at, holdings, terms: hedgeTermsOf(hedge), caps: { venueCapsPct, classCapsPct }, cashFloorUsd: settings.monthlySpendUsd * settings.operatingCashMonths, level,
    ...(split !== undefined && Object.keys(split).length > 0 && { stable: { split, prices: stablePrices } }),
  };

  // Plan once to size the moves, ask NEAR Intents what each would cost, and plan again with the answers.
  const first = planHedge({ ...input, quotes: [] });
  if (!first.ok) return { read: { ...read, plan: null, problems: first.problems }, legs };
  const quotes: DryQuote[] = [];
  if (deps.intents && listed?.ok) {
    const asked = hedgeQuoteRequests(first).slice(0, MAX_QUOTES);
    if (hedgeQuoteRequests(first).length > asked.length) notes.push(`only ${MAX_QUOTES} quotes are asked for at once: the other moves are blocked for want of one`);
    const answers = await Promise.all(asked.map(request => deps.intents!.quote(who, request, tokens)));
    answers.forEach((answer, i) => answer.ok ? quotes.push(answer.value) : notes.push(`quote for ${asked[i]!.from} to ${asked[i]!.to}: ${answer.detail}`));
  }
  // Planned at the time the quotes were taken, not before the asking: a quote is judged by its age, never by a clock that ran ahead of it.
  const plan = planHedge({ ...input, at: (deps.now ?? Date.now)(), quotes });
  if (!plan.ok) return { read: { ...read, plan: null, problems: plan.problems }, legs };

  // The swap each executable move would propose, at the platform's own prices (the list's, for an asset the book doesn't hold).
  const compiled = compileMandate(mandateAnswersOf(settings, total), settings.profile as ProfileName);
  const slippageBps = compiled.ok ? compiled.mandate.limits.policy.maxSlippageBps : null;
  if (!compiled.ok) notes.push(`the mandate doesn't compile against this book, so no swap can be built for a proposal: ${compiled.problems.join("; ")}`);
  const decimals = Object.fromEntries(Object.entries(PROPOSAL_TOKENS).map(([id, token]) => [id, token.decimals]));
  const priceOf = (symbol: string): string | undefined => {
    const row = overview.book.find(r => entryOf(r)?.symbol === symbol);
    const price = row?.price ?? prices[symbol];
    return price !== undefined && price !== null && price > 0 ? decimalOf(price) : undefined;
  };
  // An executable move whose swap can't be built isn't executable: the page offers a proposal only for a move that has one.
  const moves = plan.moves.map((move): HedgeMove => {
    if (move.status !== "executable") return move;
    const unbuilt = (reason: string): HedgeMove => ({ ...move, status: "blocked", blocked: [{ code: "invalid", reason }] });
    if (slippageBps === null) return unbuilt("the mandate doesn't compile against this book, so no swap can be built");
    const from = ASSET_REGISTRY[move.from]!, to = ASSET_REGISTRY[move.to]!, size = centsDown(move.sizeUsd);
    const [fromPrice, toPrice] = [priceOf(move.from), priceOf(move.to)];
    if (size === undefined || fromPrice === undefined || toPrice === undefined || from.id === null || to.id === null) return unbuilt("the move is under a cent, or an asset has no usable price to size its swap");
    const built = swapLegsFor({ from: from.id, to: to.id, sizeUsd: size, prices: { [from.id]: fromPrice, [to.id]: toPrice }, decimals, maxSlippageBps: slippageBps });
    if (!built.ok) return unbuilt(`no swap could be built (${built.code})`);
    legs.set(move.id, built.legs[0]);
    return move;
  });
  return { read: { ...read, plan: { moves: moves.map(m => moveRead(m, legs.has(m.id))), notes: [...notes, ...plan.notes] }, problems: [] }, legs };
}

const moveRead = (m: HedgeMove, canPropose: boolean): NonNullable<HedgeRead["plan"]>["moves"][number] => ({
  id: m.id, kind: m.kind, shape: m.shape, from: m.from, to: m.to, sizeUsd: m.sizeUsd, reason: m.reason, status: m.status,
  blocked: m.blocked, quote: m.quote, canPropose,
});
