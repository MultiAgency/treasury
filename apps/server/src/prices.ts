// The oracle's three price sources, read live (H5, ADR 3): each asset's public, keyless USD tickers, from the registry's
// `priceSources`. The answers are untrusted data, parsed by the core (`parseTicker`); a source that is down, slow, too
// large, redirected or answers anything but its market's ticker gives no quote, and the oracle, short of three, freezes.
//
// A read is bounded: a timeout, a response size, HTTPS to the venue's own host with no redirect followed, and a short
// cache that also shares one read between readers at once, so a source is read at most once a window however many
// agents and sleeves ask. A failed read isn't cached. No credential is sent, and none exists to leak (#20). What each
// tick read is in its decision record (the reading's quotes), so the audit log replays it without these calls.

import { feedUrl, parseTicker, type AssetEntry, type PriceQuote, type PriceSource } from "../../../packages/core/src/index.ts";

const MAX_BODY_BYTES = 100_000;

export type PriceFeeds = {
  /** The asset's quotes from every source that answered usably, in the registry's order; none when it has no id. */
  quotes(entry: AssetEntry): Promise<PriceQuote[]>;
};

type Read = { price: number; observedAt: number } | null;

export function createPriceFeeds({ fetch: send = fetch, now = Date.now, timeoutMs = 5_000, cacheMs = 30_000 }: {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
  /** How long one answer stands: inside it, every reader shares the last good read of a source. */
  cacheMs?: number;
} = {}): PriceFeeds {
  const kept = new Map<string, { at: number; read: NonNullable<Read> }>();
  const flight = new Map<string, Promise<Read>>();

  async function fetchOne(source: PriceSource & { feed: NonNullable<PriceSource["feed"]> }, url: string): Promise<Read> {
    try {
      const response = await send(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!response.ok) return null;
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { await response.body?.cancel(); return null; }
      if (!response.body) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return parseTicker(source.feed, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), now());
    } catch {
      return null;
    }
  }

  function read(source: PriceSource): Promise<Read> {
    const feed = source.feed;
    if (!feed) return Promise.resolve(null);
    const url = feedUrl(feed);
    const last = kept.get(url);
    if (last && now() - last.at < cacheMs) return Promise.resolve(last.read);
    const pending = flight.get(url);
    if (pending) return pending;
    const started = now();
    const next = fetchOne({ ...source, feed }, url).then(result => {
      if (result) kept.set(url, { at: started, read: result });
      return result;
    }).finally(() => flight.delete(url));
    flight.set(url, next);
    return next;
  }

  return {
    async quotes(entry) {
      const id = entry.id;
      if (id === null) return [];
      const reads = await Promise.all(entry.priceSources.map(read));
      return entry.priceSources.flatMap((source, i) => reads[i] ? [{ source: source.name, asset: id, ...reads[i]! }] : []);
    },
  };
}
