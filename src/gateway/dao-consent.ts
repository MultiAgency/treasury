import { createHash } from "node:crypto";
import { z } from "zod";
import { daoProposal } from "../chain.js";
import { MachineScope } from "./machine-auth.js";

/**
 * What counts as a DAO's consent to a machine credential: a Sputnik proposal of kind `Vote`, which
 * executes nothing, that has been approved by the DAO's own voting and whose description commits to
 * exactly one credential: the agent (name and provider id), the host, the label, the scopes and the
 * longest lifetime. Member permissions alone never authorize a credential; this proposal does.
 *
 * It is read from the chain, never from the request, when the credential is issued and again on every
 * call. One approval backs one credential (see MachineCredentials.consume). Revoking the credential
 * ends it the same way as for a wallet owner.
 */

export const CONSENT_PREFIX = "treasury-machine-credential/v1";
/** An approval is only good for issuing within this long of being filed, whatever `issueBy` says. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const Terms = z.strictObject({
  agent: z.string().regex(/^[a-z0-9-]{1,32}$/),
  agentId: z.string().min(1),
  host: z.string().min(1),
  label: z.string().trim().min(1).max(80),
  scopes: MachineScope.array().min(1).max(4).refine(values => new Set(values).size === values.length),
  /** The longest lifetime a credential issued on this approval may have. */
  ttlSeconds: z.number().int().min(60).max(86_400),
  /** The approval can no longer be used to issue after this time (ISO 8601). */
  issueBy: z.iso.datetime(),
});
export type ConsentTerms = z.infer<typeof Terms>;
/** What the credential asks for; the approval must cover all of it. */
export type ConsentRequest = Omit<ConsentTerms, "issueBy">;

/** The proposal description a DAO files to consent to `terms`. */
export const consentDescription = (terms: ConsentTerms) =>
  `${CONSENT_PREFIX}\n${JSON.stringify({ ...terms, host: terms.host.toLowerCase(), scopes: [...terms.scopes].sort() })}`;

export type ConsentProposal = { id: number; description: string; status: string; kind: unknown; submission_time: string };
export type ReadProposal = (dao: string, id: number) => Promise<ConsentProposal | null>;

/** The approval does not cover this credential. The message says why, in words the requester can act on. */
export class ConsentRefused extends Error {}

export const consentDigest = (description: string) => createHash("sha256").update(description).digest("hex");

const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(scope => b.includes(scope));

/**
 * Whether `proposal` is a DAO's approved consent to `request` at `now`; returns the digest that pins its
 * description. Throws ConsentRefused otherwise.
 */
export function checkConsent(proposal: ConsentProposal | null, proposalId: number, request: ConsentRequest, now: number): { digest: string; terms: ConsentTerms } {
  if (!proposal || proposal.id !== proposalId) throw new ConsentRefused("The DAO has no such proposal.");
  // A Vote proposal executes nothing; any other kind would have the DAO do something as well.
  if (proposal.kind !== "Vote") throw new ConsentRefused("DAO consent must be a Vote proposal, which executes nothing.");
  if (proposal.status !== "Approved") throw new ConsentRefused(`The DAO's proposal is ${proposal.status}, not Approved.`);
  let filed: number;
  try { filed = Number(BigInt(proposal.submission_time) / 1_000_000n); } catch { throw new ConsentRefused("The proposal's submission time is unreadable."); }
  if (now - filed > MAX_AGE_MS) throw new ConsentRefused("The DAO's approval is more than 30 days old. File a new proposal.");

  const [prefix, json, ...extra] = proposal.description.split("\n");
  let parsed: z.ZodSafeParseResult<ConsentTerms> | undefined;
  if (prefix === CONSENT_PREFIX && json !== undefined && !extra.length) {
    try { parsed = Terms.safeParse(JSON.parse(json)); } catch { /* not JSON */ }
  }
  if (!parsed?.success) throw new ConsentRefused(`The proposal's description is not a machine-credential consent. It must be "${CONSENT_PREFIX}" and a line of JSON terms.`);
  const terms = parsed.data;

  if (terms.agent !== request.agent || terms.agentId !== request.agentId) throw new ConsentRefused("The approval is for a different treasury agent.");
  if (terms.host.toLowerCase() !== request.host.toLowerCase()) throw new ConsentRefused("The approval is for a different host.");
  if (terms.label !== request.label) throw new ConsentRefused("The approval names a different label.");
  if (!sameScopes(terms.scopes, request.scopes)) throw new ConsentRefused("The approval names different scopes.");
  if (request.ttlSeconds > terms.ttlSeconds) throw new ConsentRefused(`The approval allows at most ${terms.ttlSeconds} seconds.`);
  if (now > Date.parse(terms.issueBy)) throw new ConsentRefused("The approval can no longer be used to issue a credential. File a new proposal.");
  return { digest: consentDigest(proposal.description), terms };
}

/** Read the proposal from the chain and check it. A chain that cannot answer is a refusal, not an approval. */
export async function verifyConsent(dao: string, proposalId: number, request: ConsentRequest, now = Date.now(), read: ReadProposal = daoProposal) {
  let proposal: ConsentProposal | null;
  try { proposal = await read(dao, proposalId); } catch { throw new ConsentRefused("The DAO's proposal could not be read from the chain. Try again."); }
  return checkConsent(proposal, proposalId, request, now);
}
