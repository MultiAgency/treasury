// Mandate (A9.1): the owner's signed rules as one versioned object, and a compiler from the seven questionnaire answers
// plus a profile. Pure; fails closed: any answer that is the wrong type, out of range or inconsistent rejects the whole
// compile with every reason, and nothing is guessed. The questions, the profiles and the sleeve labels are NOT confirmed
// (H8, H6): every number below is a placeholder default, and the weights must not be presented as an approved allocation
// (`weightsApproved` stays false until the owner and Harjaap confirm them).

import { EXPOSURE_DEFAULTS, exposureProblems, type ExposureLimits } from "./exposure.ts";
import { LEVEL_DEFAULTS, levelProblems, type Level } from "./levels.ts";
import { POLICY_DEFAULTS, policyLimitProblems, type PolicyLimits } from "./policy.ts";
import type { PolicyConfig } from "./check.ts";
import type { WeightBounds } from "./sizing.ts";
import { isPct, isPositive, isPositiveInt, report } from "./validate.ts";

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

/** Placeholder profiles, awaiting H8. */
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

/** The seven answers. Placeholder questions, awaiting H8. */
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
  /** Always false here: the sleeve labels and weights are unconfirmed (H5/H6/H8). */
  weightsApproved: false;
};

export type CompileResult = { ok: true; mandate: Mandate; cashFloorUsd: number } | { ok: false; problems: string[] };

const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
// A NEAR account id: lowercase parts joined by one of - _ . (2 to 64 characters), or a 64-character hex implicit account.
const NEAR_ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
const MAX_CASH_MONTHS = 36;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function list(r: ReturnType<typeof report>, name: string, value: unknown, valid: RegExp, what: string, fold: boolean): string[] {
  if (!Array.isArray(value) || value.length === 0) { r.need(false, `${name} must be a list with at least one entry`); return []; }
  const out: string[] = [], seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !valid.test(v.trim())) { r.need(false, `${name}: "${String(v).slice(0, 40)}" is not a valid ${what}`); continue; }
    const clean = v.trim(), key = fold ? clean.toLowerCase() : clean;
    if (seen.has(key)) { r.need(false, `${name}: "${clean}" is listed twice`); continue; }
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** What is wrong with a mandate as a whole, if anything. Used by the compiler and for any mandate read back. */
export function mandateProblems(m: Mandate): string[] {
  const r = report();
  r.need(m.version === MANDATE_VERSION, `version must be ${MANDATE_VERSION}`);
  r.need(m.profile in PROFILE_DEFAULTS, "unknown profile");
  const w = m.weights;
  r.need(isPct(w.volatilePct) && isPct(w.reservePct) && isPct(w.cashPct) && Math.abs(w.volatilePct + w.reservePct + w.cashPct - 100) < 1e-9, "weights must each be above 0 and add to 100");
  const b = m.bounds;
  r.need(b.volatileMinPct >= 0 && b.volatileMaxPct <= 100 && b.volatileMinPct <= b.volatileMaxPct && w.volatilePct >= b.volatileMinPct && w.volatilePct <= b.volatileMaxPct, "the volatile weight must sit inside its bounds");
  for (const p of [...policyLimitProblems(m.limits.policy), ...exposureProblems(m.limits.exposure), ...levelProblems({ l1OrderCapFactor: m.limits.l1OrderCapFactor, maxOrderPctOfTreasury: m.limits.policy.maxOrderPctOfTreasury })]) r.need(false, p);
  r.need(m.limits.exposure.monthlySpendUsd !== null, "the spend rate must be set");
  r.need(isPositiveInt(m.governance.approvalsRequired) && m.governance.approvers.length >= m.governance.approvalsRequired, "there must be at least as many approvers as approvals required");
  r.need([0, 1, 2, 3, 4].includes(m.governance.startLevel), "unknown start level");
  r.need(m.assets.volatile.length > 0 && m.assets.stablecoins.length > 0 && m.destinations.length > 0, "assets and destinations must not be empty");
  const stable = new Set(m.assets.stablecoins.map(s => s.toLowerCase()));
  r.need(!m.assets.volatile.some(a => stable.has(a.toLowerCase())), "an asset cannot be both volatile and a stablecoin");
  r.need(m.weightsApproved === false, "weights are unconfirmed and cannot be marked approved");
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
  const known = typeof profileName === "string" && Object.prototype.hasOwnProperty.call(PROFILE_DEFAULTS, profileName);
  if (!known) r.need(false, `unknown profile "${String(profileName).slice(0, 40)}"`);
  if (!isRecord(answers)) return { ok: false, problems: [...r.problems, "answers must be an object"] };
  const profile = known ? PROFILE_DEFAULTS[profileName as ProfileName] : undefined;

  const spend = answers.monthlySpendUsd, months = answers.operatingCashMonths, treasury = answers.treasuryValueUsd;
  r.need(isNumber(spend) && isPositive(spend), "monthlySpendUsd must be a number above zero (a zero spend would switch the cash floor off)");
  r.need(isNumber(months) && isPositive(months) && months <= MAX_CASH_MONTHS, `operatingCashMonths must be above 0 and at most ${MAX_CASH_MONTHS}`);
  r.need(isNumber(treasury) && isPositive(treasury), "treasuryValueUsd must be a number above zero");
  const volatile = list(r, "volatileAssets", answers.volatileAssets, SYMBOL, "asset symbol", true);
  const stablecoins = list(r, "stablecoins", answers.stablecoins, SYMBOL, "asset symbol", true);
  const destinations = list(r, "destinations", answers.destinations, NEAR_ACCOUNT, "NEAR account", false);
  const approvers = list(r, "approvers", answers.approvers, NEAR_ACCOUNT, "NEAR account", false);
  const stable = new Set(stablecoins.map(s => s.toLowerCase()));
  for (const a of volatile) r.need(!stable.has(a.toLowerCase()), `${a} cannot be both volatile and a stablecoin`);

  let floor = 0;
  if (profile && isNumber(spend) && isNumber(months) && isNumber(treasury) && spend > 0 && months > 0 && treasury > 0) {
    r.need(months >= profile.minCashMonths, `the ${profileName as string} profile needs at least ${profile.minCashMonths} months of operating cash, not ${months}`);
    floor = spend * months;
    r.need(floor * 100 <= treasury * profile.weights.cashPct, `a cash floor of ${floor} USD is over the ${profile.weights.cashPct}% cash share of a ${treasury} USD treasury: the ${profileName as string} profile can't meet it`);
    r.need(approvers.length >= profile.approvalsRequired, `the ${profileName as string} profile needs ${profile.approvalsRequired} approver(s), not ${approvers.length}`);
  }
  if (r.problems.length > 0 || !profile || !isNumber(spend) || !isNumber(months)) return { ok: false, problems: r.problems };

  const exposure: ExposureLimits = { maxVenueExposurePct: EXPOSURE_DEFAULTS.maxVenueExposurePct, operatingCashMonths: months, monthlySpendUsd: spend };
  const mandate: Mandate = {
    version: MANDATE_VERSION, profile: profileName as ProfileName,
    assets: { volatile, stablecoins }, destinations,
    limits: { policy: { ...profile.limits }, exposure, l1OrderCapFactor: LEVEL_DEFAULTS.l1OrderCapFactor },
    governance: { approvers, approvalsRequired: profile.approvalsRequired, startLevel: profile.startLevel },
    weights: { ...profile.weights }, bounds: { ...profile.bounds }, weightsApproved: false,
  };
  const inconsistent = mandateProblems(mandate);
  if (inconsistent.length > 0) return { ok: false, problems: inconsistent };
  return { ok: true, mandate, cashFloorUsd: floor };
}

/** The policy engine's configuration from a mandate (feeds `checkPolicy`). */
export const policyConfigOf = (m: Mandate): PolicyConfig => ({ limits: m.limits.policy, exposure: m.limits.exposure, l1OrderCapFactor: m.limits.l1OrderCapFactor });

/** The volatile weight bounds from a mandate (feeds the sizing step). */
export const weightBoundsOf = (m: Mandate): WeightBounds => m.bounds;
