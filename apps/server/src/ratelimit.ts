/**
 * At most `limit` requests per key over any `windowMs` (a minute by default). A full clean-up runs at most every 10
 * seconds, so a flood of requests costs linear time, not quadratic; each key's own window is filtered on every request.
 */
export function createRateLimit({ limit, windowMs = 60_000, now = Date.now }: { limit: number; windowMs?: number; now?: () => number }) {
  const seen = new Map<string, number[]>();
  let cleanedAt = -Infinity;
  /** Counts a request for `key` and answers whether it's allowed; a refused request isn't counted. */
  return (key: string) => {
    const at = now();
    if (at - cleanedAt >= 10_000) {
      cleanedAt = at;
      for (const [other, times] of seen) {
        const recent = times.filter(time => time > at - windowMs);
        if (recent.length) seen.set(other, recent); else seen.delete(other);
      }
    }
    const times = (seen.get(key) ?? []).filter(time => time > at - windowMs);
    if (times.length >= limit) return false;
    seen.set(key, [...times, at]);
    return true;
  };
}
export type RateLimit = ReturnType<typeof createRateLimit>;
