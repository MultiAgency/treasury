/**
 * At most `perMinute` requests per key over any minute. A full clean-up runs at most every 10 seconds, so a flood of
 * requests costs linear time, not quadratic; each key's own window is filtered on every request.
 */
export function createRateLimit({ perMinute, now = Date.now }: { perMinute: number; now?: () => number }) {
  const seen = new Map<string, number[]>();
  let cleanedAt = -Infinity;
  /** Counts a request for `key` and answers whether it's allowed; a refused request isn't counted. */
  return (key: string) => {
    const at = now();
    if (at - cleanedAt >= 10_000) {
      cleanedAt = at;
      for (const [other, times] of seen) {
        const recent = times.filter(time => time > at - 60_000);
        if (recent.length) seen.set(other, recent); else seen.delete(other);
      }
    }
    const times = (seen.get(key) ?? []).filter(time => time > at - 60_000);
    if (times.length >= perMinute) return false;
    seen.set(key, [...times, at]);
    return true;
  };
}
export type RateLimit = ReturnType<typeof createRateLimit>;
