// Mandate (A9.1): the owner's signed rules as one versioned object, and a compiler from the seven questionnaire answers
// plus a profile. Pure; fails closed: any answer that is the wrong type, out of range or inconsistent rejects the whole
// compile with every reason, and nothing is guessed. H8 (ADR 3) confirms the seven questions, the three profiles and the
// sleeve labels (volatile wNEAR, a USDC reserve the DCA draws on, USDC operating cash). The weights are still not an
// approved allocation for any one owner: `weightsApproved` stays false until that owner signs the mandate built on them.

import { diversificationDefaults, diversifiedProblems, type DiversifiedTerms, type MandateFrame } from "./diversified.ts";
import type { ExposureLimits } from "./exposure.ts";
import { LEVEL_DEFAULTS, levelProblems, type Level } from "./levels.ts";
import { POLICY_DEFAULTS, policyLimitProblems, type PolicyLimits } from "./policy.ts";
import type { PolicyConfig } from "./check.ts";
import type { WeightBounds } from "./sizing.ts";
import { isNum, isPct, isPositive, isPositiveInt, report } from "./validate.ts";

export const MANDATE_VERSION = 1;
export type ProfileName = "conservative" | "balanced" | "growth";

/** Target shares of the treasury, in percent: volatile asset, DCA reserve, operating cash. Must add to 100. */
export type Weights = { volatilePct: number; reservePct: number; cashPct: number };

export type Profile = {
  weights: Weights;
  /** The volatile share may drift only inside these percents. */
  bounds: WeightBounds;
  limits: PolicyLimits;
  /** The fewest months of operating cash this profile accepts as a floor. */
  minCashMonths: number;
  /** Approvals needed for an order that calls for a human. */
  approvalsRequired: number;
  /** The level the mandate starts at: 0 acts within limits; 2 asks a human for every order. */
  startLevel: Level;
};

/** The three profiles (H8, ADR 3). Each profile's venue cap is its `bounds.volatileMaxPct` (H6). */
export const PROFILE_DEFAULTS: Readonly<Record<ProfileName, Profile>> = {
  conservative: {
    weights: { volatilePct: 20, reservePct: 30, cashPct: 50 }, bounds: { volatileMinPct: 5, volatileMaxPct: 30 },
    limits: { maxOrderPctOfTreasury: 1, maxDailyTurnoverPct: 5, maxOrdersPerHour: 5, maxSlippageBps: 30 },
    minCashMonths: 9, approvalsRequired: 2, startLevel: 2,
  },
  balanced: {
    weights: { volatilePct: 40, reservePct: 35, cashPct: 25 }, bounds: { volatileMinPct: 10, volatileMaxPct: 50 },
    limits: POLICY_DEFAULTS, minCashMonths: 6, approvalsRequired: 1, startLevel: 0,
  },
  growth: {
    weights: { volatilePct: 60, reservePct: 25, cashPct: 15 }, bounds: { volatileMinPct: 20, volatileMaxPct: 70 },
    limits: { maxOrderPctOfTreasury: 2, maxDailyTurnoverPct: 15, maxOrdersPerHour: 10, maxSlippageBps: 50 },
    minCashMonths: 6, approvalsRequired: 1, startLevel: 0,
  },
};

/** The seven answers (H8, ADR 3). */
export type Answers = {
  /** 1. Monthly operating spend, USD. */
  monthlySpendUsd: number;
  /** 2. Months of operating cash to protect. */
  operatingCashMonths: number;
  /** 3. Treasury value today, USD. */
  treasuryValueUsd: number;
  /** 4. Volatile assets the engine may trade (symbols). */
  volatileAssets: string[];
  /** 5. Stablecoins that count as cash (symbols). */
  stablecoins: string[];
  /** 6. NEAR accounts funds may be sent to. */
  destinations: string[];
  /** 7. NEAR accounts that approve orders. */
  approvers: string[];
  /**
   * 8 (#221). The asset classes the owner allows and the caps per class and per venue, the sleeves' targets, the
   * stablecoin split and what real-world assets need. Optional, and each part of it too: what's left out is the profile's
   * (`diversificationDefaults`). Asked only of an owner with more than one volatile asset, or who sets it; without it, and
   * with one volatile asset, the mandate is the two-asset one.
   */
  diversification?: Partial<DiversifiedTerms>;
};

export type Mandate = {
  version: typeof MANDATE_VERSION;
  profile: ProfileName;
  assets: { volatile: string[]; stablecoins: string[] };
  destinations: string[];
  limits: { policy: PolicyLimits; exposure: ExposureLimits; l1OrderCapFactor: number };
  governance: { approvers: string[]; approvalsRequired: number; startLevel: Level };
  weights: Weights;
  bounds: WeightBounds;
  /** Always false here: the owner hasn't yet signed these weights (H8). */
  weightsApproved: false;
  /** The diversified book's terms (#221); absent from a two-asset mandate, so its shape and digest are unchanged. */
  diversification?: DiversifiedTerms;
};

export type CompileResult = { ok: true; mandate: Mandate; cashFloorUsd: number } | { ok: false; problems: string[] };

const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// A NEAR account id: lowercase parts joined by one of - _ . (2 to 64 characters), or a 64-character hex implicit account.
const NEAR_ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
const MAX_CASH_MONTHS = 36;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const hasOwn = (x: object, key: string) => Object.prototype.hasOwnProperty.call(x, key);
/** A field the object holds itself: nothing inherited, and `undefined` for anything that isn't an object. */
const own = (x: unknown, key: string): unknown => isRecord(x) && hasOwn(x, key) ? x[key] : undefined;
/** Holds exactly `expected`'s fields and values, as a copy of it would. */
const sameAs = (x: unknown, expected: object) =>
  isRecord(x) && Object.keys(x).length === Object.keys(expected).length && Object.entries(expected).every(([k, v]) => own(x, k) === v);
/** A value for a message; never throws, even for an object without a prototype. */
const show = (x: unknown) => (typeof x === "object" && x !== null || typeof x === "function" ? typeof x : String(x)).slice(0, 40);
const profileOf = (name: unknown) => typeof name === "string" && hasOwn(PROFILE_DEFAULTS, name) ? PROFILE_DEFAULTS[name as ProfileName] : undefined;

/** Checks a list and returns its valid entries; `trim` (answers only) forgives surrounding spaces, a stored list must not need it. */
function list(r: ReturnType<typeof report>, name: string, value: unknown, valid: RegExp, what: string, fold: boolean, trim: boolean): string[] {
  if (!Array.isArray(value) || value.length === 0) { r.need(false, `${name} must be a list with at least one entry`); return []; }
  const out: string[] = [], seen = new Set<string>();
  for (const v of value) {
    const clean = typeof v === "string" && trim ? v.trim() : v;
    if (typeof clean !== "string" || !valid.test(clean)) { r.need(false, `${name}: "${show(v)}" is not a valid ${what}`); continue; }
    const key = fold ? clean.toLowerCase() : clean;
    if (seen.has(key)) { r.need(false, `${name}: "${clean}" is listed twice`); continue; }
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * What is wrong with a mandate as a whole, if anything. Used by the compiler and for any mandate read back, of any shape:
 * it passes only if `compileMandate` could have produced it. The answers' parts (spend, months, lists) pass the compiler's
 * checks; everything the compiler copies from the profile or the defaults must equal it, since no answer changes those.
 */
export function mandateProblems(m: unknown): string[] {
  if (!isRecord(m)) return ["a mandate must be an object"];
  const r = report();
  r.need(own(m, "version") === MANDATE_VERSION, `version must be ${MANDATE_VERSION}`);
  const name = own(m, "profile"), profile = profileOf(name);
  r.need(profile !== undefined, "unknown profile");
  const assets = own(m, "assets"), limits = own(m, "limits"), exposure = own(limits, "exposure"), governance = own(m, "governance");

  const volatile = list(r, "assets.volatile", own(assets, "volatile"), SYMBOL, "asset symbol", true, false);
  const stable = new Set(list(r, "assets.stablecoins", own(assets, "stablecoins"), SYMBOL, "asset symbol", true, false).map(s => s.toLowerCase()));
  r.need(!volatile.some(a => stable.has(a.toLowerCase())), "an asset cannot be both volatile and a stablecoin");
  list(r, "destinations", own(m, "destinations"), NEAR_ACCOUNT, "NEAR account", false, false);
  const approvers = list(r, "governance.approvers", own(governance, "approvers"), NEAR_ACCOUNT, "NEAR account", false, false);

  const spend = own(exposure, "monthlySpendUsd"), months = own(exposure, "operatingCashMonths");
  r.need(isPositive(spend), "the spend rate must be above zero (a zero spend would switch the cash floor off)");
  r.need(isPositive(months) && months <= MAX_CASH_MONTHS, `operatingCashMonths must be above 0 and at most ${MAX_CASH_MONTHS}`);
  r.need(sameAs(exposure, { maxVenueExposurePct: profile?.bounds.volatileMaxPct, operatingCashMonths: months, monthlySpendUsd: spend }), "the venue exposure limit must be the profile's volatile ceiling");
  r.need(own(limits, "l1OrderCapFactor") === LEVEL_DEFAULTS.l1OrderCapFactor, "the L1 order cap factor must be the default");
  r.need(own(m, "weightsApproved") === false, "weights are unconfirmed and cannot be marked approved");
  if (!profile) return r.problems;

  const p = name as string;
  r.need(!isNum(months) || months >= profile.minCashMonths, `the ${p} profile needs at least ${profile.minCashMonths} months of operating cash, not ${show(months)}`);
  r.need(approvers.length >= profile.approvalsRequired, `the ${p} profile needs ${profile.approvalsRequired} approver(s), not ${approvers.length}`);
  r.need(sameAs(own(m, "weights"), profile.weights), `the weights must be the ${p} profile's`);
  r.need(sameAs(own(m, "bounds"), profile.bounds), `the volatile bounds must be the ${p} profile's`);
  r.need(sameAs(own(limits, "policy"), profile.limits), `the policy limits must be the ${p} profile's`);
  r.need(own(governance, "approvalsRequired") === profile.approvalsRequired && own(governance, "startLevel") === profile.startLevel, `the approvals required and start level must be the ${p} profile's`);

  // The profile itself must be usable: a placeholder number that is out of range fails every mandate built on it.
  const w = profile.weights, b = profile.bounds;
  r.need(isPct(w.volatilePct) && isPct(w.reservePct) && isPct(w.cashPct) && Math.abs(w.volatilePct + w.reservePct + w.cashPct - 100) < 1e-9, "weights must each be above 0 and add to 100");
  r.need(b.volatileMinPct >= 0 && b.volatileMaxPct <= 100 && b.volatileMinPct <= b.volatileMaxPct && w.volatilePct >= b.volatileMinPct && w.volatilePct <= b.volatileMaxPct, "the volatile weight must sit inside its bounds");
  for (const problem of [...policyLimitProblems(profile.limits), ...levelProblems({ l1OrderCapFactor: LEVEL_DEFAULTS.l1OrderCapFactor, maxOrderPctOfTreasury: profile.limits.maxOrderPctOfTreasury })]) r.need(false, problem);
  r.need(isPositiveInt(profile.approvalsRequired), "approvalsRequired must be a whole number of at least 1");

  // The diversified book's terms, read back as the compiler checks them: inside the profile, and only what's proposable.
  // More than one volatile asset can only come from the compiler with its terms, so a mandate missing them isn't one
  // the compiler could have produced: it is refused rather than read as a two-asset book it isn't.
  if (volatile.length > 1 && !hasOwn(m, "diversification")) r.need(false, "a mandate with more than one volatile asset needs its diversification terms");
  if (hasOwn(m, "diversification")) {
    const terms = own(m, "diversification");
    if (!isRecord(terms)) r.need(false, "diversification must be an object");
    else for (const problem of diversifiedProblems(terms as DiversifiedTerms, {
      weights: profile.weights, bounds: profile.bounds,
      assets: { volatile, stablecoins: [...stable] }, maxVenueExposurePct: profile.bounds.volatileMaxPct,
    })) r.need(false, `diversification: ${problem}`);
  }
  return r.problems;
}

/**
 * Compiles the seven answers and a profile into a validated mandate. Every problem is reported, none is repaired.
 * Beyond type and range checks it rejects inconsistent answers: a cash floor below the profile's minimum months, a floor
 * the profile's cash weight can't hold (floor ÷ treasury over the cash share), fewer approvers than the profile needs,
 * and an asset listed as both volatile and a stablecoin.
 */
export function compileMandate(answers: unknown, profileName: unknown): CompileResult {
  const r = report();
  const profile = profileOf(profileName);
  if (!profile) r.need(false, `unknown profile "${show(profileName)}"`);
  if (!isRecord(answers)) return { ok: false, problems: [...r.problems, "answers must be an object"] };

  const spend = own(answers, "monthlySpendUsd"), months = own(answers, "operatingCashMonths"), treasury = own(answers, "treasuryValueUsd");
  r.need(isNum(spend) && isPositive(spend), "monthlySpendUsd must be a number above zero (a zero spend would switch the cash floor off)");
  r.need(isNum(months) && isPositive(months) && months <= MAX_CASH_MONTHS, `operatingCashMonths must be above 0 and at most ${MAX_CASH_MONTHS}`);
  r.need(isNum(treasury) && isPositive(treasury), "treasuryValueUsd must be a number above zero");
  const volatile = list(r, "volatileAssets", own(answers, "volatileAssets"), SYMBOL, "asset symbol", true, true);
  const stablecoins = list(r, "stablecoins", own(answers, "stablecoins"), SYMBOL, "asset symbol", true, true);
  const destinations = list(r, "destinations", own(answers, "destinations"), NEAR_ACCOUNT, "NEAR account", false, true);
  const approvers = list(r, "approvers", own(answers, "approvers"), NEAR_ACCOUNT, "NEAR account", false, true);
  const stable = new Set(stablecoins.map(s => s.toLowerCase()));
  for (const a of volatile) r.need(!stable.has(a.toLowerCase()), `${a} cannot be both volatile and a stablecoin`);

  let floor = 0;
  if (profile) {
    r.need(approvers.length >= profile.approvalsRequired, `the ${profileName as string} profile needs ${profile.approvalsRequired} approver(s), not ${approvers.length}`);
    if (isNum(months)) r.need(months >= profile.minCashMonths, `the ${profileName as string} profile needs at least ${profile.minCashMonths} months of operating cash, not ${months}`);
  }
  if (profile && isNum(spend) && isNum(months) && isNum(treasury) && spend > 0 && months > 0 && treasury > 0) {
    floor = spend * months;
    r.need(floor * 100 <= treasury * profile.weights.cashPct, `a cash floor of ${floor} USD is over the ${profile.weights.cashPct}% cash share of a ${treasury} USD treasury: the ${profileName as string} profile can't meet it`);
  }
  if (r.problems.length > 0 || !profile || !isNum(spend) || !isNum(months)) return { ok: false, problems: r.problems };

  const exposure: ExposureLimits = { maxVenueExposurePct: profile.bounds.volatileMaxPct, operatingCashMonths: months, monthlySpendUsd: spend };
  const asked = own(answers, "diversification");
  if (asked !== undefined && !isRecord(asked)) return { ok: false, problems: ["diversification must be an object"] };
  // More than one volatile asset needs the diversified book's terms; the owner's own, part by part, over the profile's.
  const diversification = asked !== undefined || volatile.length > 1
    ? { ...diversificationDefaults(profileName as ProfileName, { weights: profile.weights, bounds: profile.bounds, assets: { volatile, stablecoins }, maxVenueExposurePct: exposure.maxVenueExposurePct }), ...(asked as Partial<DiversifiedTerms> | undefined) }
    : undefined;
  const mandate: Mandate = {
    version: MANDATE_VERSION, profile: profileName as ProfileName,
    assets: { volatile, stablecoins }, destinations,
    limits: { policy: { ...profile.limits }, exposure, l1OrderCapFactor: LEVEL_DEFAULTS.l1OrderCapFactor },
    governance: { approvers, approvalsRequired: profile.approvalsRequired, startLevel: profile.startLevel },
    weights: { ...profile.weights }, bounds: { ...profile.bounds }, weightsApproved: false,
    ...(diversification && { diversification }),
  };
  const inconsistent = mandateProblems(mandate);
  if (inconsistent.length > 0) return { ok: false, problems: inconsistent };
  return { ok: true, mandate, cashFloorUsd: floor };
}

/** The policy engine's configuration from a mandate (feeds `checkPolicy`). */
export const policyConfigOf = (m: Mandate): PolicyConfig => ({ limits: m.limits.policy, exposure: m.limits.exposure, l1OrderCapFactor: m.limits.l1OrderCapFactor });

/** The volatile weight bounds from a mandate (feeds the sizing step). */
export const weightBoundsOf = (m: Mandate): WeightBounds => m.bounds;

/** What the diversification terms are checked against, from a mandate the compiler built: the frame `diversifiedProblems` takes. */
export const mandateFrameOf = (m: Mandate): MandateFrame => ({
  weights: m.weights, bounds: m.bounds, assets: m.assets, maxVenueExposurePct: m.limits.exposure.maxVenueExposurePct,
});
