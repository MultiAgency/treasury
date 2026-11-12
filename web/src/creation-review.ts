import type { Creation, Identity } from "./server-api.ts";

/** The provider recipient may differ from the host: bind the hosting origin separately from the exact signing payload. */
export function creationMatches(creation: Creation, identity: Identity): boolean {
  const binding = creation.review;
  return Boolean(creation.intent && binding && identity.signer === "wallet" && identity.agentId === null && identity.account === identity.owner
    && binding.owner === identity.owner && binding.agent === identity.agent && binding.host === identity.host);
}

/** Compare all reviewed bytes and bindings; a changed version is shown before another explicit signing attempt. */
export function sameCreation(a: Creation, b: Creation): boolean {
  return a.correlationId === b.correlationId && a.expiresAt === b.expiresAt
    && JSON.stringify(a.intent) === JSON.stringify(b.intent) && JSON.stringify(a.review) === JSON.stringify(b.review);
}
