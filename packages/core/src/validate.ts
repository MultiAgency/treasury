// Shared checks for every engine's limits and configuration. A limit that is NaN, infinite, negative or out of range
// must never switch a rule off, so each engine entry point validates its configuration with these primitives and fails
// closed (freeze, hold, reject) when it is not usable. Startup code can use `assertValid` to refuse to run at all.

export const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export const isPositive = (n: unknown): n is number => isNum(n) && n > 0;
export const isNonNegative = (n: unknown): n is number => isNum(n) && n >= 0;
export const isPositiveInt = (n: unknown): n is number => isNum(n) && Number.isInteger(n) && n >= 1;
/** A percent above zero and at most 100. */
export const isPct = (n: unknown): n is number => isNum(n) && n > 0 && n <= 100;

/** Collects the problems found in one configuration. `need(ok, message)` records `message` when `ok` is false. */
export function report(): { problems: string[]; need: (ok: boolean, message: string) => void } {
  const problems: string[] = [];
  return { problems, need: (ok, message) => { if (!ok) problems.push(message); } };
}

/**
 * Runs a configuration check that reads nested fields. A missing object makes such a read throw a TypeError; that is a
 * problem with the configuration like any other, so it is reported, never thrown at the engine that asked.
 */
export function guarded(check: () => string[]): string[] {
  try { return check(); } catch (error) {
    if (error instanceof TypeError) return [`the configuration is missing a field (${error.message})`];
    throw error;
  }
}

export class InvalidConfigError extends Error {
  readonly problems: string[];
  constructor(name: string, problems: string[]) {
    super(`Invalid ${name} configuration: ${problems.join("; ")}`);
    this.name = "InvalidConfigError";
    this.problems = problems;
  }
}

/** Throws if there are problems. For startup: refuse to run on a configuration an engine would only fail closed on. */
export function assertValid(name: string, problems: readonly string[]): void {
  if (problems.length > 0) throw new InvalidConfigError(name, [...problems]);
}
