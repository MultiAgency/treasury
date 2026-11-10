// The mandate's diversification terms (A9.1, #221): which asset classes the owner allows, the cap on each class and on
// each venue, the volatile sleeves, how the stablecoins split, and what a real-world asset needs before it may be held.
// Pure; fails closed like the rest of the mandate: every problem is reported and nothing is repaired. A mandate without
// these terms is the two-asset mandate, unchanged, and its digest with it.
//
// The terms fit inside the profile, never around it: the sleeves add up to the profile's volatile weight, the volatile
// class and the account venue are capped at most at the profile's volatile ceiling, and the stablecoins are the ones the
// owner named as cash.

import { ASSET_CLASSES, ASSET_REGISTRY, assetBySymbol, proposable, VENUE_IDS, VENUES, type AssetClass, type AssetEntry } from "./assets.ts";
import { sleeveProblems, type SleeveBook, type SleeveTerms } from "./sleeves.ts";
import { splitProblems, type StableSplit } from "./stables.ts";
import { isNum, isPct, report } from "./validate.ts";

export type RwaEligibility = {
  /** The owner says the treasury may hold real-world assets at all (an issuer's eligibility rules, the jurisdiction). */
  eligible: boolean;
  /** The holder has passed the issuer's KYC: a product that requires it can't be held without. */
  kycVerified: boolean;
  /** The most of the treasury real-world assets may be, in percent. */
  maxPct: number;
  /** Days within which a real-world asset must redeem to count towards the cash floor (`runway.ts`). */
  cashHorizonDays: number;
};

export type DiversifiedTerms = {
  classes: AssetClass[];
  /** Percent of the treasury per class; a class not allowed must be 0 or left out. */
  classCapsPct: Partial<Record<AssetClass, number>>;
  /** Percent of the treasury per venue; every venue a sleeve's or a stablecoin's path crosses needs one. */
  venueCapsPct: Record<string, number>;
  sleeves: SleeveTerms[];
  /** Phase 2's switch: more than one coin splits the reserve and cash. */
  stableSplit: StableSplit;
  /** Phase 3's switch: real-world assets count only once eligible, verified, allowed and listed. */
  rwa: RwaEligibility;
};

/** What the terms are checked against: the mandate the compiler built from the profile. */
export type MandateFrame = {
  weights: { volatilePct: number };
  bounds: { volatileMinPct: number; volatileMaxPct: number };
  assets: { volatile: readonly string[]; stablecoins: readonly string[] };
  maxVenueExposurePct: number;
};

const MAX_HORIZON_DAYS = 365;
const has = (list: readonly string[], symbol: string) => list.some(x => x.toLowerCase() === symbol.toLowerCase());

/** What is wrong with the terms against the mandate they belong to, if anything. */
export function diversifiedProblems(t: DiversifiedTerms, m: MandateFrame, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): string[] {
  const r = report();
  try {
    const classes = new Set(t.classes);
    r.need(Array.isArray(t.classes) && t.classes.every(c => ASSET_CLASSES.includes(c)) && classes.size === t.classes.length, "classes must be volatile, stable or rwa, each once");
    r.need(classes.has("stable"), "stable must be allowed: the cash floor is held in stablecoins");
    r.need(t.sleeves.length === 0 || classes.has("volatile"), "volatile sleeves need the volatile class allowed");

    for (const c of ASSET_CLASSES) {
      const cap = t.classCapsPct[c];
      if (!classes.has(c)) r.need(cap === undefined || cap === 0, `${c} isn't allowed, so its cap must be 0`);
      else r.need(isPct(cap), `the ${c} class needs a cap above 0 and at most 100`);
    }
    r.need(!isNum(t.classCapsPct.volatile) || t.classCapsPct.volatile <= m.bounds.volatileMaxPct, `the volatile class cap can't be over the profile's ceiling of ${m.bounds.volatileMaxPct}%`);

    const book: SleeveBook = { sleeves: t.sleeves, volatileMaxPct: m.bounds.volatileMaxPct };
    for (const p of sleeveProblems(book)) r.need(false, p);
    const targets = t.sleeves.reduce((s, x) => s + (isNum(x.targetPct) ? x.targetPct : 0), 0);
    r.need(Math.abs(targets - m.weights.volatilePct) < 1e-9, `the sleeves' targets must add to the profile's volatile weight, ${m.weights.volatilePct}%`);
    const paths = new Set<string>();
    for (const s of t.sleeves) {
      const entry = registry[s.asset];
      r.need(entry?.class === "volatile", `sleeve ${s.asset} isn't a volatile asset in the registry`);
      // Fail closed on what the platform refuses: a sleeve the engine could never propose isn't a sleeve.
      r.need(entry === undefined || proposable(entry), `sleeve ${s.asset} isn't among the platform's proposal assets: it can't be traded until the platform lists it`);
      r.need(has(m.assets.volatile, s.asset), `sleeve ${s.asset} isn't among the mandate's volatile assets`);
      entry?.venues.forEach(v => paths.add(v));
    }
    for (const a of m.assets.volatile) r.need(t.sleeves.some(s => s.asset.toLowerCase() === a.toLowerCase()), `${a} is a volatile asset of the mandate with no sleeve`);

    for (const p of splitProblems(t.stableSplit, registry)) r.need(false, p);
    for (const coin of Object.keys(t.stableSplit ?? {})) {
      r.need(has(m.assets.stablecoins, coin), `${coin} isn't among the mandate's stablecoins`);
      const entry = registry[coin];
      r.need(entry === undefined || proposable(entry), `${coin} isn't among the platform's proposal assets: the reserve can't be split into it until the platform lists it`);
      registry[coin]?.venues.forEach(v => paths.add(v));
    }

    // A real-world asset also crosses venues: when the class is allowed, every RWA path in the registry needs a cap, so
    // a listed one can't later be held without the venue check refusing every order.
    if (classes.has("rwa")) for (const e of Object.values(registry)) if (e.class === "rwa") e.venues.forEach(v => paths.add(v));
    for (const [venue, cap] of Object.entries(t.venueCapsPct)) {
      r.need(VENUES[venue] !== undefined, `unknown venue ${venue}`);
      r.need(isPct(cap), `the ${venue} cap must be above 0 and at most 100`);
    }
    for (const venue of paths) r.need(t.venueCapsPct[venue] !== undefined, `${VENUES[venue]?.label ?? venue} is on a held asset's path and needs a cap`);
    const account = t.venueCapsPct[VENUE_IDS.intents];
    r.need(!isNum(account) || account <= m.maxVenueExposurePct, `the NEAR Intents account's cap can't be over the mandate's venue limit of ${m.maxVenueExposurePct}%`);

    const rwa = t.rwa;
    r.need(isNum(rwa.maxPct) && rwa.maxPct >= 0 && rwa.maxPct <= 100, "rwa.maxPct must be 0 to 100");
    r.need(isNum(rwa.cashHorizonDays) && rwa.cashHorizonDays >= 0 && rwa.cashHorizonDays <= MAX_HORIZON_DAYS, `rwa.cashHorizonDays must be 0 to ${MAX_HORIZON_DAYS}`);
    if (classes.has("rwa")) {
      r.need(rwa.eligible === true, "real-world assets are allowed only once the owner confirms the treasury is eligible to hold them");
      r.need(rwa.kycVerified === true, "real-world assets are allowed only once the holder has passed the issuer's KYC");
      r.need(isPct(rwa.maxPct), "allowed real-world assets need a cap above 0");
      r.need(!isNum(t.classCapsPct.rwa) || t.classCapsPct.rwa <= rwa.maxPct, "the rwa class cap can't be over rwa.maxPct");
    } else r.need(rwa.maxPct === 0, "real-world assets aren't allowed, so rwa.maxPct must be 0");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    r.need(false, `the diversification terms are missing a field (${error.message})`);
  }
  return r.problems;
}

/**
 * Each profile's cap on one bridge, in percent of the treasury: half its volatile ceiling, so no single bridge can carry
 * more than half of what the profile lets be at risk. A named default, like H6's venue cap, until #221's bridge risk
 * assessment gives each route its own.
 */
export const BRIDGE_CAP_PCT: Readonly<Record<"conservative" | "balanced" | "growth", number>> = { conservative: 15, balanced: 25, growth: 35 };

/** The profile's default for a cash horizon: a real-world asset must be cash within a month to count towards the floor. */
export const CASH_HORIZON_DAYS = 30;

/**
 * The terms a profile gives a mandate's volatile assets and stablecoins when the owner sets none (A9.1's questionnaire,
 * #221): volatile and stable allowed, real-world assets not; the volatile class and the account capped at the profile's
 * ceiling; each bridge a sleeve or coin crosses at `BRIDGE_CAP_PCT`; the profile's volatile weight and bounds split evenly
 * across the sleeves; the reserve in the proposable stablecoins, evenly. Defaults aren't checked here: the compiler checks
 * whatever it ends up with.
 */
export function diversificationDefaults(profile: keyof typeof BRIDGE_CAP_PCT, m: MandateFrame, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): DiversifiedTerms {
  const n = m.assets.volatile.length || 1;
  const sleeves = m.assets.volatile.map(asset => ({
    asset: assetBySymbol(asset, registry)?.symbol ?? asset, targetPct: m.weights.volatilePct / n, minPct: m.bounds.volatileMinPct / n, maxPct: m.bounds.volatileMaxPct / n,
  }));
  const coins = m.assets.stablecoins.map(c => assetBySymbol(c, registry)?.symbol ?? c).filter(c => registry[c] !== undefined && proposable(registry[c]!));
  const venueCapsPct: Record<string, number> = { [VENUE_IDS.intents]: m.maxVenueExposurePct };
  for (const symbol of [...sleeves.map(s => s.asset), ...coins])
    for (const v of registry[symbol]?.venues ?? []) if (v !== VENUE_IDS.intents) venueCapsPct[v] = BRIDGE_CAP_PCT[profile];
  return {
    classes: ["volatile", "stable"],
    classCapsPct: { volatile: m.bounds.volatileMaxPct, stable: 100 },
    venueCapsPct, sleeves,
    stableSplit: Object.fromEntries(coins.map(c => [c, 100 / coins.length])),
    rwa: { eligible: false, kycVerified: false, maxPct: 0, cashHorizonDays: CASH_HORIZON_DAYS },
  };
}

/** Whether phase 2 is on: the split names more than one coin. */
export const stableSplitOn = (t: DiversifiedTerms) => Object.keys(t.stableSplit).length > 1;
/** Whether phase 3 is on: the class is allowed and the owner's eligibility and KYC are confirmed. Listing is the asset's own test. */
export const rwaOn = (t: DiversifiedTerms) => t.classes.includes("rwa") && t.rwa.eligible && t.rwa.kycVerified && t.rwa.maxPct > 0;

/** The sleeves as the book engine takes them, under the profile's ceiling. */
export const sleeveBookOf = (t: DiversifiedTerms, volatileMaxPct: number): SleeveBook => ({ sleeves: t.sleeves, volatileMaxPct });

/** One phase of the strategy: whether it can run, and every reason it can't. Phase 1 is cross-chain majors, 2 stablecoins, 3 RWA. */
export type PhaseStatus = { phase: 1 | 2 | 3; title: string; on: boolean; reasons: string[] };
/** What the registry and the mandate allow of each phase, as the app server and the page report it. Reasons are never dropped. */
export type DiversificationStatus = { phases: [PhaseStatus, PhaseStatus, PhaseStatus] };

const names = (entries: readonly AssetEntry[]) => entries.map(e => e.symbol).join(", ");
/** Whether the registry's entry for a symbol may be proposed. An unknown symbol never may. */
const listed = (registry: Readonly<Record<string, AssetEntry>>, symbol: string) => {
  const entry = registry[symbol];
  return entry !== undefined && proposable(entry);
};

/**
 * What each phase can do with the terms the owner signed and the platform's proposal assets (#221), for the page and
 * the app server's read. The platform's list, not the registry, decides what can be proposed: an asset in the registry
 * that isn't proposable is named in the reasons, never traded. Phase 1 needs two cross-chain majors, so the ETH sleeve
 * alone isn't it: a native wNEAR sleeve doesn't count, and BTC can't until the platform lists it.
 */
export function diversificationPhases(terms: DiversifiedTerms | null, registry: Readonly<Record<string, AssetEntry>> = ASSET_REGISTRY): DiversificationStatus {
  const entries = Object.values(registry);
  const listedVolatile = entries.filter(e => e.class === "volatile" && proposable(e));
  const listedStable = entries.filter(e => e.class === "stable" && proposable(e));
  const listedCashRwa = entries.filter(e => e.class === "rwa" && e.rwa?.cashLike === true && proposable(e));
  const unlistedVolatile = entries.filter(e => e.class === "volatile" && !proposable(e));
  const unlistedStable = entries.filter(e => e.class === "stable" && !proposable(e));
  const unlistedRwa = entries.filter(e => e.class === "rwa" && !proposable(e));

  const missingTerms = "no diversification terms are configured for this agent: watch's ballast settings carry none";
  const phase1Reasons: string[] = [];
  const crossChain = terms === null ? 0 : terms.sleeves.filter(s => registry[s.asset] !== undefined && registry[s.asset]!.route !== "native").length;
  if (terms === null) phase1Reasons.push(missingTerms);
  else for (const s of terms.sleeves) {
    const entry = registry[s.asset];
    if (!entry) phase1Reasons.push(`${s.asset} isn't in the asset registry`);
    else if (!proposable(entry)) phase1Reasons.push(`${s.asset} isn't among the platform's proposal assets: the platform lists ${names(listedVolatile)}`);
  }
  // The platform's own gap is said whether or not terms are configured: it's why the phase can't run anyway.
  if (crossChain < 2) phase1Reasons.push(`phase 1 needs two cross-chain majors, and the mandate has ${crossChain}: wNEAR is native, and ${unlistedVolatile.length ? `${names(unlistedVolatile)} ${unlistedVolatile.length === 1 ? "isn't" : "aren't"} among the platform's proposal assets` : "no other major is in the registry"}`);
  const phase1On = terms !== null && crossChain >= 2 && terms.sleeves.every(s => listed(registry, s.asset));

  const phase2Reasons: string[] = [];
  const split = terms === null ? [] : Object.keys(terms.stableSplit);
  if (terms === null) phase2Reasons.push(missingTerms);
  else for (const coin of split) if (!listed(registry, coin)) phase2Reasons.push(`${coin} isn't among the platform's proposal assets: the platform lists ${names(listedStable)}`);
  if (split.length < 2) phase2Reasons.push(`the reserve is in ${split.join(", ") || "no stablecoin"}: a second stablecoin needs the platform to list one${unlistedStable.length ? ` (${names(unlistedStable)} ${unlistedStable.length === 1 ? "is" : "are"} in the registry but not among the proposal assets)` : ""}`);
  const phase2On = terms !== null && split.length >= 2 && split.every(c => listed(registry, c));

  const phase3Reasons: string[] = [];
  if (terms === null) phase3Reasons.push(missingTerms);
  else {
    if (!terms.classes.includes("rwa")) phase3Reasons.push("the mandate doesn't allow real-world assets");
    if (!terms.rwa.eligible) phase3Reasons.push("the owner hasn't confirmed the treasury is eligible to hold real-world assets");
    if (!terms.rwa.kycVerified) phase3Reasons.push("the holder hasn't passed the issuer's KYC");
    if (!(terms.rwa.maxPct > 0)) phase3Reasons.push("the real-world asset sleeve has no cap");
  }
  if (listedCashRwa.length === 0) phase3Reasons.push(`no tokenized T-bill is among the platform's proposal assets${unlistedRwa.length ? `: ${names(unlistedRwa)} ${unlistedRwa.length === 1 ? "is" : "are"} in the registry but not proposable` : ""}`);
  const phase3On = terms !== null && rwaOn(terms) && listedCashRwa.length > 0;

  return { phases: [
    { phase: 1, title: "Cross-chain majors through NEAR Intents", on: phase1On, reasons: phase1Reasons },
    { phase: 2, title: "Reserve split across stablecoins", on: phase2On, reasons: phase2Reasons },
    { phase: 3, title: "Tokenized treasuries as a reserve sleeve", on: phase3On, reasons: phase3Reasons },
  ] };
}
