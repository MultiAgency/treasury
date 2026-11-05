import { randomBytes } from "node:crypto";
import { parseSetupMessage, setupMessage } from "@multiagency/sdk";
import { organizationOf } from "./consent.ts";
import type { ConsentRecord } from "./platform.ts";

/** The only area this server sets agents up for. */
export const SETUP_AREA = "treasury";
/** How long a wallet owner's setup text is good for: the platform takes at most an hour. */
export const SETUP_MS = 60 * 60_000;
/** How long a DAO's setup text is good for: its vote may take the DAO's whole voting period, at most 7 days. */
export const DAO_SETUP_MS = 7 * 86_400_000;
/** The platform's agent ID for a setup consent: it names no created agent (`UNBORN_AGENT`, its `app-consent.ts`). */
const UNBORN = "unborn";

type Setup = { host: string; deployment: string; owner: string; now?: number };

/**
 * The setup this server asks for, as its canonical text: a Treasury agent for the owner's own Organization (#20,
 * decision 5), on the platform's host, for this deployment. A wallet owner signs it; a DAO votes on it.
 */
export const setupFor = ({ host, deployment, owner, now = Date.now() }: Setup, forMs: number) =>
  setupMessage({ host, deployment, organization: organizationOf(owner), owner, area: SETUP_AREA, expiresAt: new Date(now + forMs).toISOString() });

/** The setup text for the owner's wallet to sign, with a fresh 32-byte nonce, for the platform's host. */
export const setupText = (setup: Setup) => ({ message: setupFor(setup, SETUP_MS), nonce: randomBytes(32).toString("base64"), recipient: setup.host });

/**
 * Whether a signed text is exactly a setup this server would ask the owner for now: the canonical text naming this
 * host, deployment, the owner's own Organization and Treasury, unexpired and good for at most `SETUP_MS`. Anything else
 * is refused before the platform sees it.
 */
export function checkSetup(message: string, { host, deployment, owner, now = Date.now() }: Setup): { ok: true } | { ok: false; code: "not_this_setup" } {
  const text = parseSetupMessage(message);
  const expiresAt = text ? Date.parse(text.expiresAt) : NaN;
  const matches = text !== null && text.host === host && text.deployment === deployment && text.organization === organizationOf(owner)
    && text.owner === owner && text.area === SETUP_AREA && expiresAt > now && expiresAt <= now + SETUP_MS;
  return matches ? { ok: true } : { ok: false, code: "not_this_setup" };
}

/**
 * The owner's live setup consents for `agent`, latest to expire first: unrevoked and unexpired, naming no created
 * agent. One lets this server relay only the agent's creation, with the key that signed it.
 */
export const setupConsents = (consents: readonly ConsentRecord[], owner: string, agent: string, now = Date.now()) =>
  consents.filter(consent => consent.agent === agent && consent.owner === owner && consent.agentId === UNBORN && !consent.revoked && consent.expiresAt > now)
    .sort((a, b) => b.expiresAt - a.expiresAt);

/** The agents an owner's consents name under their Organization, set up or created: what "Your treasuries" lists. */
export const agentsOf = (consents: readonly ConsentRecord[], owner: string) =>
  [...new Set(consents.filter(consent => consent.owner === owner).map(consent => consent.agent))].sort();
