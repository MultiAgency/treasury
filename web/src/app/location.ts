/** The agent whose pages these are: `/a/<name>/…` behind the gateway, or null at the host's root. */
export const AGENT = location.pathname.match(/^\/a\/([a-z0-9-]+)(?:\/|$)/)?.[1] ?? null;
/** Where this agent's pages live, for the router. */
export const BASE = AGENT ? `/a/${AGENT}` : "";
