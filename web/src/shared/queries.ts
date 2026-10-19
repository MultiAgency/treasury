import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { activityQueriesFor } from "../features/activity/queries";
import { portfolioQueriesFor } from "../features/portfolio/queries";
import { ownerQueriesFor } from "../features/owner/queries";
import { BASE, client, type clientFor } from "./client";

let viewer: string | null = null;

/**
 * One agent's cache identity: this host, the agent's base ("" or "/a/<name>") and the signed-in
 * account. A changed viewer gets new keys, so another account's records are never read from cache.
 */
export const scopeOf = (base: string) => `${location.host}|${base}|${viewer ?? ""}`;
/** The agent scope recorded in a cache key, or undefined for gateway reads. */
export function scopeOfKey(key: readonly unknown[]) {
  const parts = typeof key[0] === "string" ? key[0].split("|") : [];
  return parts.length === 3 ? { host: parts[0]!, base: parts[1]!, account: parts[2]! } : undefined;
}

export type QueryUtils = ReturnType<typeof utilsFor>;
export const utilsFor = (api: ReturnType<typeof clientFor>, base: string) => createTanstackQueryUtils(api, { prefix: scopeOf(base) });
const rescoped = new Set<() => void>();
/** Modules with their own document-level reads rebuild them when the account changes. */
export function onScope(rebuild: () => void) { rescoped.add(rebuild); }

/** Reads for the agent at `base`. Reads may retry; sends never go through query options. */
export function queriesFor(api: ReturnType<typeof clientFor>, base: string) {
  const orpc = utilsFor(api, base);
  return {
    orpc,
    ...ownerQueriesFor(orpc),
    ...portfolioQueriesFor(orpc),
    ...activityQueriesFor(orpc),
    policyHistory: orpc.policyHistory.queryOptions(),
    setup: orpc.setup.queryOptions({ retry: false }),
    held: orpc.held.queryOptions({ refetchInterval: 15_000 }),
    overview: orpc.overview.queryOptions({ refetchInterval: 30_000 }),
    treasury: orpc.treasury.get.queryOptions(),
  };
}

/** This document's agent reads, rebuilt when the signed-in account changes (a live binding). */
export let queries = queriesFor(client, BASE);
export function scopeQueries(account: string | null) {
  if (account === viewer) return false;
  viewer = account;
  queries = queriesFor(client, BASE);
  for (const rebuild of rescoped) rebuild();
  return true;
}
export const APPROVAL_WINDOW_MS = 24 * 60 * 60_000;
