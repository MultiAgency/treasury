import { randomBytes } from "node:crypto";
import { consentMessage, parseConsentMessage } from "@multiagency/sdk";
import type { Identity } from "./contract.ts";
import type { ConsentRecord } from "./platform.ts";

/** What this server asks an owner to consent to: reads and Treasury proposals the owner approves one by one. Never `treasury-execute`. */
export const CONSENT_SCOPES = ["read", "treasury"] as const;
/**
 * A wallet owner's consent also carries `owner` by default (#135): the app may prepare owner actions (a strategy grant)
 * and relay the owner's own signature over each, which alone makes one take effect. A DAO's consent never carries it: the
 * platform files a DAO's owner actions for its vote under `treasury`. `CONSENT_SCOPES` stays accepted, since live
 * consents without `owner` exist.
 */
export const OWNER_CONSENT_SCOPES = ["read", "treasury", "owner"] as const;
/** Whether a consent carries `owner`. */
export const withOwner = (scopes: readonly string[]) => scopes.includes("owner");
/** How long a consent this server asks for lasts. The platform allows up to 366 days. */
export const CONSENT_DAYS = 90;
const DAY = 86_400_000;

type Expected = { identity: Identity; deployment: string; now?: number };

/**
 * The Organization a consent names: the owner's account with each `.` written as `--` (#20, decision 5). The platform
 * accepts only `[A-Za-z0-9_-]{1,128}`, and NEAR accounts never contain doubled separators, so this can't collide and
 * turns back into the account exactly. A 64-character account is at most 95 characters here.
 */
export const organizationOf = (account: string) => account.replaceAll(".", "--");

/**
 * The consent this server asks for, as its canonical text: the owner's Organization, the agent's current identity
 * (so an agent created anew needs a new one), `CONSENT_SCOPES` (or `OWNER_CONSENT_SCOPES` when the owner opts in), for
 * `CONSENT_DAYS`. A wallet owner signs it; a DAO votes on it.
 */
export const consentFor = ({ identity, deployment, owner = false, now = Date.now() }: { identity: Identity & { agentId: string }; deployment: string; owner?: boolean; now?: number }) =>
  consentMessage({
    host: identity.host, deployment, organization: organizationOf(identity.owner), owner: identity.owner, agent: identity.agent,
    agentId: identity.agentId, scopes: [...(owner ? OWNER_CONSENT_SCOPES : CONSENT_SCOPES)], expiresAt: new Date(now + CONSENT_DAYS * DAY).toISOString(),
  });

/**
 * The consent text for the owner's wallet to sign, with a fresh 32-byte nonce, and the recipient to sign it for: the
 * platform's host, never this server's.
 */
export function consentText(expected: { identity: Identity & { agentId: string }; deployment: string; owner?: boolean; now?: number }) {
  return { message: consentFor(expected), nonce: randomBytes(32).toString("base64"), recipient: expected.identity.host };
}

/**
 * Whether a signed text is exactly a consent this server would ask for now: the canonical text naming this host,
 * deployment, Organization, owner, agent and identity, with `read` and `treasury` only, or with `owner` as well,
 * unexpired and no longer than `CONSENT_DAYS`. Anything else is refused before the platform sees it, so the server never
 * relays a wider consent than it asks for.
 */
export function checkConsent(message: string, { identity, deployment, now = Date.now() }: Expected): { ok: true } | { ok: false; code: "not_this_consent" } {
  const text = parseConsentMessage(message);
  const expiresAt = text ? Date.parse(text.expiresAt) : NaN;
  const matches = text !== null && text.host === identity.host && text.deployment === deployment
    && text.organization === organizationOf(identity.owner) && text.owner === identity.owner && text.agent === identity.agent
    && text.agentId === identity.agentId && [CONSENT_SCOPES, OWNER_CONSENT_SCOPES].some(scopes => text.scopes.join() === [...scopes].sort().join())
    && expiresAt > now && expiresAt <= now + CONSENT_DAYS * DAY;
  return matches ? { ok: true } : { ok: false, code: "not_this_consent" };
}

/**
 * The agent's live consents for this owner, the latest to expire first: for the agent's current ID (not a setup
 * consent, which names no created agent, nor one for an earlier agent of the same name), covering `read` and
 * `treasury`, unrevoked and unexpired. Only these let the platform's calls through, so only these count as connected.
 */
export function liveConsents(consents: readonly ConsentRecord[], identity: Identity, now = Date.now()) {
  return consents.filter(consent => consent.agent === identity.agent && consent.owner === identity.owner && consent.agentId === identity.agentId
    && CONSENT_SCOPES.every(scope => consent.scopes.includes(scope)) && !consent.revoked && consent.expiresAt > now)
    .sort((a, b) => b.expiresAt - a.expiresAt);
}
