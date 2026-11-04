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
 * answers it as cached, and `recreated` gives an agent's earlier ID the same way. `unborn` names agents not created yet, and `daos` agents whose owner is a DAO (`signer: "dao"`). Consents are kept as the platform keeps them, under the
 * Organization the signed text names; `consentAnswers` queues answers that `consents.submit` gives before storing.
 */
export function fakePlatform(owners: Record<string, string>, { failing = {}, foreign = [], stale = {}, unborn = [], recreated = {}, daos = [], daoNext = () => 0 }: {
  failing?: Record<string, IdentityAnswer>; foreign?: string[]; stale?: Record<string, string>; unborn?: string[]; recreated?: Record<string, string>; daos?: string[];
  /** The DAO's next proposal number, as the platform reads it when it files: what its file-and-vote transaction votes on. */
  daoNext?: (dao: string) => number;
} = {}) {
  const calls: string[] = [];
  const consents: ConsentRecord[] = [];
  const consentAnswers: Awaited<ReturnType<Platform["consents"]["submit"]>>[] = [];
  /**
   * DAO consent requests as the platform keeps them, each with a fresh hash, and whether the DAO's vote has passed
   * (`signed`), ended it (`ended`: 410 after its voting deadline, 409 after a stop) or not yet. `daoAnswers` queues answers
   * that `daoConsents.file` gives instead of filing.
   */
  const daoRequests: { id: string; message: string; signed: boolean; ended?: 409 | 410; consent?: string }[] = [];
  const daoAnswers: Awaited<ReturnType<Platform["daoConsents"]["file"]>>[] = [];
  /**
   * DAO vote requests as the platform keeps them: `passed` once the DAO's vote passes, relayed on the next read to the
   * proposal (approved or rejected), or `ended` (410 past its deadline, 409 for a relay refused for now). `voteAnswers`
   * queues answers that `daoVotes.file` gives instead of filing.
   */
  const daoVotes: { id: string; organization: string; agent: string; proposal: string; verdict: "approve" | "reject"; passed: boolean; relayed?: string; ended?: 409 | 410 }[] = [];
  const voteAnswers: Awaited<ReturnType<Platform["daoVotes"]["file"]>>[] = [];
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
      deployment: foreign.includes(agent) ? "elsewhere" : "treasury", ...(daos.includes(agent) && { signer: "dao" as const }) } }
    : { ok: false, kind: "refused", status: 404, error: "No such agent" });
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
    daoConsents: {
      async file(message) {
        calls.push("daoConsents.file");
        const queued = daoAnswers.shift();
        if (queued) return queued;
        const text = parseConsentMessage(message)!;
        const id = String(daoRequests.length + 1).padStart(64, "d");
        daoRequests.push({ id, message, signed: false });
        const request = { id, dao: text.owner, organization: text.organization, agent: text.agent, agentId: text.agentId, scopes: text.scopes,
          expiresAt: Date.parse(text.expiresAt), votingUntil: Date.now() + 7 * 86_400_000, hash: id, description: `* Signs: NEP-413 hash ${id}` };
        return { ok: true, value: { request, transactions: { proposal: daoTransaction(text.owner, id), proposalAndVote: daoTransaction(text.owner, id, daoNext(text.owner)) } } };
      },
      async state(id) {
        calls.push(`daoConsents.state ${id}`);
        const found = daoRequests.find(request => request.id === id);
        if (!found) return { ok: false, kind: "refused", status: 404, error: "No such DAO consent request" };
        if (found.ended) return { ok: false, kind: "refused", status: found.ended, error: "Ended" };
        const text = parseConsentMessage(found.message)!;
        const request = { id, dao: text.owner, organization: text.organization, agent: text.agent, agentId: text.agentId, scopes: text.scopes,
          expiresAt: Date.parse(text.expiresAt), votingUntil: Date.now() + 7 * 86_400_000, hash: id, description: `* Signs: NEP-413 hash ${id}` };
        if (!found.signed) return { ok: true, value: { state: "pending" as const, request } };
        if (!found.consent) {
          const { type: _type, version: _version, expiresAt, ...rest } = text;
          const consent = { ...rest, id: `c${consents.length + 1}`.padEnd(64, "0"), expiresAt: Date.parse(expiresAt), createdAt: 0,
            publicKey: "ed25519:dao", revoked: false, revokedAt: null, signer: "dao" as const };
          consents.push(consent);
          found.consent = consent.id;
        }
        return { ok: true, value: { state: "signed" as const, consent: consents.find(consent => consent.id === found.consent)! } };
      },
    },
    daoVotes: {
      async file({ organization, agent, proposal: id, verdict }) {
        calls.push(`daoVotes.file ${id} ${verdict}`);
        const queued = voteAnswers.shift();
        if (queued) return queued;
        const found = find(organization, agent, id);
        if (!found) return { ok: false, kind: "refused", status: 409, error: "The agent didn't answer this proposal for this app. Nothing was filed." };
        if (found.state !== "proposed") return { ok: false, kind: "refused", status: 409, error: `This proposal is ${found.state}. Nothing was filed.` };
        const request = { id: String(daoRequests.length + daoVotes.length + 1).padStart(64, "f"), dao: owners[agent]!, organization, agent, agentId: `id-${agent}`,
          proposal: id, verdict, votingUntil: Date.parse(found.expiresAt), hash: "", description: `* Proposal Action: ${verdict === "approve" ? "Approve" : "Reject"} Treasury proposal ${id}` };
        request.hash = request.id;
        daoVotes.push({ id: request.id, organization, agent, proposal: id, verdict, passed: false });
        return { ok: true, value: { request, transactions: { proposal: daoTransaction(owners[agent]!, request.id), proposalAndVote: daoTransaction(owners[agent]!, request.id, daoNext(owners[agent]!)) } } };
      },
      async state(id) {
        calls.push(`daoVotes.state ${id}`);
        const vote = daoVotes.find(item => item.id === id);
        if (!vote) return { ok: false, kind: "refused", status: 404, error: "No such DAO vote request" };
        const request = { id, dao: owners[vote.agent]!, organization: vote.organization, agent: vote.agent, agentId: `id-${vote.agent}`, proposal: vote.proposal,
          verdict: vote.verdict, votingUntil: 0, hash: id, description: "" };
        if (vote.relayed) return { ok: true, value: { state: "relayed" as const, request, proposalState: vote.relayed } };
        if (vote.ended) return { ok: false, kind: "refused", status: vote.ended, error: "Ended" };
        if (!vote.passed) return { ok: true, value: { state: "pending" as const, request } };
        const found = find(vote.organization, vote.agent, vote.proposal);
        if (found && found.state === "proposed") found.state = vote.verdict === "approve" ? "approved" : "rejected";
        vote.relayed = found ? found.state : "unknown";
        return { ok: true, value: { state: "relayed" as const, request, proposalState: vote.relayed } };
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
  return { platform, calls, consents, consentAnswers, proposals, proposalAnswers, daoRequests, daoAnswers, daoVotes, voteAnswers };
}

/**
 * A member's transaction for a DAO request, shaped as the platform builds it (`dao-owner.ts`): an `add_proposal` whose
 * kind is a `FunctionCall` to `v1.signer` signing `hash`, and with `voteOn` a vote on that proposal number too.
 */
export function daoTransaction(dao: string, hash: string, voteOn?: number) {
  const kind = daoKind(hash);
  return { receiverId: dao, actions: [
    { type: "FunctionCall" as const, params: { methodName: "add_proposal", args: { proposal: { description: `* Signs: NEP-413 hash ${hash}`, kind } }, gas: "100000000000000", deposit: "0" } },
    ...(voteOn === undefined ? [] : [{ type: "FunctionCall" as const, params: { methodName: "act_proposal", args: { id: voteOn, action: "VoteApprove", proposal: kind }, gas: "75000000000000", deposit: "0" } }]),
  ] };
}

/** The kind of the DAO proposal that signs `hash`: what the server matches the DAO's proposals against. */
export const daoKind = (hash: string) => ({ FunctionCall: { receiver_id: "v1.signer", actions: [{ method_name: "sign",
  args: Buffer.from(JSON.stringify({ request: { path: "agent-owner", payload_v2: { Eddsa: hash }, domain_id: 1 } })).toString("base64"), deposit: "1", gas: "50000000000000" }] } });

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
