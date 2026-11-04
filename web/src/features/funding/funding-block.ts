import { useSyncExternalStore } from "react";

/**
 * Agents whose funding transfer may have gone out (a wallet or Trezu error while sending), with the reason shown. Kept
 * outside any component, so a `Fund` that unmounts (a failed `treasury/get`, the confidential setting) and mounts again
 * still doesn't offer Send. It lasts as long as the page is loaded: no platform read reports whether a funding transfer
 * was sent.
 */
const blocked = new Map<string, string>();
const listeners = new Set<() => void>();

export function blockFunding(agent: string, reason: string) {
  if (blocked.has(agent)) return;
  blocked.set(agent, reason);
  for (const listener of listeners) listener();
}
export const fundingBlock = (agent: string) => blocked.get(agent);
export function subscribeFunding(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useFundingBlock = (agent: string) => useSyncExternalStore(subscribeFunding, () => fundingBlock(agent));
