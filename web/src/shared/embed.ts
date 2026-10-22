/**
 * Set once by the embed entry (embed.tsx) before the app loads, because the agent's base address
 * is read when the app's modules first run. Standalone, nothing sets it and the page address decides.
 */
export type EmbedHost = { agent: string; account: string };

let host: EmbedHost | null = null;

export const embedHost = () => host;
export const isEmbedded = () => host !== null;

export function setEmbedHost(next: EmbedHost) {
  if (host && host.agent !== next.agent) throw new Error(`Treasury is already loaded for agent "${host.agent}" in this page. Reload the page to switch agents.`);
  host = next;
}
