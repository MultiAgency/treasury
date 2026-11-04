// Fakes for the server's outside services: the platform and the chain. Tests run the server in-process against these.
import { parseConsentMessage, type ProposalView } from "@multiagency/sdk";
import { generateKey } from "near-kit";
import type { ConsentRecord, IdentityAnswer, Platform, ProposalAnswer } from "../src/platform.ts";
import type { Challenge } from "../src/signin.ts";

export const HOST = "treasury.test";
export const ORIGIN = `https://${HOST}`;

/**
 * A platform that knows a fixed set of agents and their owners, and records every call it's asked. `failing` makes
 * the platform answer a failure for an agent instead, `foreign` names agents another deployment's identity covers, and
 * `stale` gives an agent's previous owner, as a reused answer from before a transfer would: a read that isn't fresh
 * answers it as cached, and `recreated` gives an agent's earlier ID the same way. `unborn` names agents not created yet. Consents are kept as the platform keeps them, under the
 * Organization the signed text names; `consentAnswers` queues answers that `consents.submit` gives before storing.
 */
export function fakePlatform(owners: Record<string, string>, { failing = {}, foreign = [], stale = {}, unborn = [], recreated = {}, daoOwned = [] }: {
  failing?: Record<string, IdentityAnswer>; foreign?: string[]; stale?: Record<string, string>; unborn?: string[]; recreated?: Record<string, string>;
  /** Agents whose owner is a DAO: their identity answers `signer: "dao"`. */
  daoOwned?: string[];
} = {}) {
  const calls: string[] = [];
  const consents: ConsentRecord[] = [];
  const consentAnswers: Awaited<ReturnType<Platform["consents"]["submit"]>>[] = [];
  /** Proposals as the platform keeps them, under the Organization that made them. */
  const proposals: (ProposalView & { agent: string })[] = [];
  /** Answers the next proposal actions give instead of their own, by action; an Error is thrown, as a broken call would. */
  const proposalAnswers: Partial<Record<"approve" | "reject" | "execute" | "get", (ProposalAnswer | Error)[]>> = {};
  const next = (action: keyof typeof proposalAnswers) => {
    const queued = proposalAnswers[action]?.shift();
    if (queued instanceof Error) throw queued;
    return queued;
  };
  const find = (organization: string, agent: string, id: string) => proposals.find(item => item.organization === organization && item.agent === agent && item.id === id);
  const notFound: ProposalAnswer = { ok: false, kind: "refused", status: 404, code: "not_found", error: "No such proposal" };
  /** As the platform shows a proposal: one still waiting reads `expired` once its validity ends. */
  const shown = ({ agent: _agent, ...view }: ProposalView & { agent: string }): ProposalView =>
    (view.state === "proposed" || view.state === "approved") && Date.now() >= Date.parse(view.expiresAt) ? { ...view, state: "expired" } : view;
  const answer = (agent: string, owner: string | undefined): IdentityAnswer => failing[agent] ?? (owner
    ? { ok: true, value: { agent, owner, agentId: unborn.includes(agent) ? null : `id-${agent}`, created: !unborn.includes(agent), host: "platform.test",
      deployment: foreign.includes(agent) ? "elsewhere" : "treasury", ...(daoOwned.includes(agent) && { signer: "dao" as const }) } }
    : { ok: false, kind: "refused", status: 404, error: "No such agent" });
  /**
   * DAO requests as the platform keeps them: filed by `dao.*.file`, `pending` until a test marks the DAO's vote passed
   * (`daoPassed`), after which a `state` read stores the consent or relays the verdict, as the platform does. `daoAnswers`
   * queues answers the next calls give instead; an Error is thrown.
   */
  const daoFiled: ({ id: string; kind: "consent"; message: string } | { id: string; kind: "vote"; input: { organization: string; agent: string; proposal: string; verdict: "approve" | "reject" } })[] = [];
  const daoPassed = new Set<string>();
  const daoAnswers: Partial<Record<"consentFile" | "consentState" | "voteFile" | "voteState", unknown[]>> = {};
  const daoNext = (call: keyof typeof daoAnswers) => {
    const queued = daoAnswers[call]?.shift();
    if (queued instanceof Error) throw queued;
    return queued as never;
  };
  const transaction = (method: string) => ({ receiverId: "dao.sputnik-dao.near", actions: [{ type: "FunctionCall" as const, params: { methodName: method, args: {}, gas: "1", deposit: "1" } }] });
  const filedRequest = (id: string, fields: Record<string, unknown>) => ({ id, dao: "dao.sputnik-dao.near", votingUntil: Date.now() + 7 * 86_400_000,
    hash: `hash-${id}`, description: `Treasury app request. Check: https://platform.test/confirm/dao/hash-${id}`, ...fields });
  const platform: Platform = {
    async identity(agent, { fresh = false } = {}) {
      if (!fresh && stale[agent]) return { answer: answer(agent, stale[agent]), cached: true };
      if (!fresh && recreated[agent]) {
        const current = answer(agent, owners[agent]);
        return { answer: current.ok ? { ok: true, value: { ...current.value, agentId: recreated[agent] } } : current, cached: true };
      }
      calls.push(`identity ${agent}${fresh ? " (fresh)" : ""}`);
      return { answer: answer(agent, owners[agent]), cached: false };
    },
    proposals: {
      async list(organization, agent) {
        calls.push(`proposals.list ${organization} ${agent}`);
        return { ok: true, value: { proposals: proposals.filter(item => item.organization === organization && item.agent === agent).map(shown) } };
      },
      async get(organization, agent, id) {
        calls.push(`proposals.get ${organization} ${agent} ${id}`);
        const queued = next("get");
        if (queued) return queued;
        const found = find(organization, agent, id);
        return found ? { ok: true, value: shown(found) } : notFound;
      },
      async approve(organization, agent, input) { return decide("approve", organization, agent, input.id); },
      async reject(organization, agent, input) { return decide("reject", organization, agent, input.id); },
      async execute(organization, agent, id) {
        calls.push(`proposals.execute ${organization} ${agent} ${id}`);
        const queued = next("execute");
        if (queued) return queued;
        const found = find(organization, agent, id);
        if (!found) return notFound;
        if (found.state === "approved") found.state = "executed";
        return { ok: true, value: shown(found) };
      },
    },
    dao: {
      consents: {
        async file(message) {
          calls.push("dao.consents.file");
          const queued = daoNext("consentFile");
          if (queued) return queued;
          const text = parseConsentMessage(message)!;
          const id = `consent-request-${daoFiled.length + 1}`;
          daoFiled.push({ id, kind: "consent", message });
          return { ok: true, value: { request: filedRequest(id, { organization: text.organization, agent: text.agent, agentId: text.agentId, scopes: text.scopes,
            expiresAt: Date.parse(text.expiresAt) }) as never, transactions: { proposal: transaction("add_proposal"), proposalAndVote: transaction("add_proposal+act_proposal") } } };
        },
        async state(id) {
          calls.push(`dao.consents.state ${id}`);
          const queued = daoNext("consentState");
          if (queued) return queued;
          const filed = daoFiled.find(request => request.id === id);
          if (!filed || filed.kind !== "consent") return { ok: false, kind: "refused", status: 404, error: "No such request" };
          if (!daoPassed.has(id)) return { ok: true, value: { state: "pending", request: filedRequest(id, {}) as never } };
          const existing = consents.find(consent => consent.id === `dao-${id}`);
          if (existing) return { ok: true, value: { state: "signed", consent: existing } };
          const { type: _type, version: _version, expiresAt, ...rest } = parseConsentMessage(filed.message)!;
          const consent = { ...rest, id: `dao-${id}`, expiresAt: Date.parse(expiresAt), createdAt: 0, publicKey: "ed25519:dao", revoked: false, revokedAt: null, signer: "dao" as const };
          consents.push(consent);
          return { ok: true, value: { state: "signed", consent } };
        },
      },
      votes: {
        async file(input) {
          calls.push(`dao.votes.file ${input.organization} ${input.agent} ${input.proposal} ${input.verdict}`);
          const queued = daoNext("voteFile");
          if (queued) return queued;
          const id = `vote-request-${daoFiled.length + 1}`;
          daoFiled.push({ id, kind: "vote", input });
          return { ok: true, value: { request: filedRequest(id, { organization: input.organization, agent: input.agent, agentId: `id-${input.agent}`,
            proposal: input.proposal, verdict: input.verdict }) as never, transactions: { proposal: transaction("add_proposal"), proposalAndVote: null } } };
        },
        async state(id) {
          calls.push(`dao.votes.state ${id}`);
          const queued = daoNext("voteState");
          if (queued) return queued;
          const filed = daoFiled.find(request => request.id === id);
          if (!filed || filed.kind !== "vote") return { ok: false, kind: "refused", status: 404, error: "No such request" };
          const request = filedRequest(id, { ...filed.input, agentId: `id-${filed.input.agent}` }) as never;
          if (!daoPassed.has(id)) return { ok: true, value: { state: "pending", request } };
          const found = find(filed.input.organization, filed.input.agent, filed.input.proposal);
          if (found && found.state === "proposed") found.state = filed.input.verdict === "approve" ? "approved" : "rejected";
          return { ok: true, value: { state: "relayed", request, proposalState: found?.state ?? "unknown" } };
        },
      },
    },
    consents: {
      async list(organization) {
        calls.push(`consents.list ${organization}`);
        return { ok: true, value: { consents: consents.filter(consent => consent.organization === organization) } };
      },
      async submit(submission) {
        calls.push(`consents.submit ${submission.nonce}`);
        const queued = consentAnswers.shift();
        if (queued) return queued;
        const text = parseConsentMessage(submission.message)!;
        const { type: _type, version: _version, expiresAt, ...rest } = text;
        const consent = { ...rest, id: `c${consents.length + 1}`.padEnd(64, "0"), expiresAt: Date.parse(expiresAt), createdAt: 0,
          publicKey: submission.publicKey, revoked: false, revokedAt: null };
        consents.push(consent);
        return { ok: true, value: { consent } };
      },
      async revoke(id) {
        calls.push(`consents.revoke ${id}`);
        const consent = consents.find(consent => consent.id === id);
        if (!consent) return { ok: false, kind: "refused", status: 404, error: "No such consent" };
        Object.assign(consent, { revoked: true, revokedAt: 1 });
        return { ok: true, value: { revoked: true } };
      },
    },
  };
  async function decide(verdict: "approve" | "reject", organization: string, agent: string, id: string): Promise<ProposalAnswer> {
    calls.push(`proposals.${verdict} ${organization} ${agent} ${id}`);
    const queued = next(verdict);
    if (queued) return queued;
    const found = find(organization, agent, id);
    if (!found) return notFound;
    found.state = verdict === "approve" ? "approved" : "rejected";
    return { ok: true, value: shown(found) };
  }
  return { platform, calls, consents, consentAnswers, proposals, proposalAnswers, daoFiled, daoPassed, daoAnswers };
}

/** A wallet for `accountId` with a fresh key, which signs a challenge as a wallet would (NEP-413). */
export function wallet(accountId: string) {
  const key = generateKey();
  return {
    accountId,
    publicKey: key.publicKey.toString(),
    sign(challenge: Challenge, overrides: Partial<{ message: string; recipient: string }> = {}) {
      const signed = key.signNep413Message!(accountId, {
        message: overrides.message ?? challenge.message,
        recipient: overrides.recipient ?? challenge.recipient,
        nonce: new Uint8Array(Buffer.from(challenge.nonce, "base64")),
      });
      return { accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce };
    },
  };
}

const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** A proposal as the platform shows it: one USDC to wNEAR swap, open for an hour. */
export function proposal(change: Partial<ProposalView> = {}): ProposalView {
  return {
    id: "a".repeat(32), requestId: "r1", agentId: "id-portfolio", deployment: "treasury", organization: "owner--near", source: "external",
    legs: [{ from: USDC, to: "nep141:wrap.near", amount: "5000000", minAmountOut: "1000000000000000000000000" }],
    quoted: [{ amountOut: "1100000000000000000000000", costBps: 12, usdIn: 5 }],
    policyRevision: 3, policyDigest: `sha256:${"b".repeat(64)}`, strategyDigest: `sha256:${"c".repeat(64)}`,
    createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), note: null,
    sha256: "d".repeat(64), state: "proposed", reason: null, approvedAt: null, planId: null, operations: [], ...change,
  };
}
