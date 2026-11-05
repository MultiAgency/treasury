// Fakes for the server's outside services: the platform and the chain. Tests run the server in-process against these.
import { parseConsentMessage, parseSetupMessage, type ProposalView } from "@multiagency/sdk";
import { generateKey } from "near-kit";
import type { ConsentRecord, IdentityAnswer, Platform, PreparedAnswer, ProposalAnswer, ReadAnswer, SetupAnswer, StatusAnswer, SweepRun } from "../src/platform.ts";
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
  /**
   * Setups as the platform keeps them: each owner's reserved Treasury agent, named `treasury-<n>`, reserved once and
   * found again by a later setup until it's created (`created`). `setupAnswers` queues answers `setup` gives instead.
   */
  const reservations: Record<string, string> = {};
  const setupAnswers: SetupAnswer[] = [];
  /**
   * DAO setups as the platform keeps them: `signed` once the DAO's vote passes, which reserves its agent on the next
   * read, or `ended` (410 past its deadline, 409 refused after the vote). `daoSetupAnswers` queues answers `file` gives.
   */
  const daoSetups: { id: string; dao: string; organization: string; expiresAt: number; signed: boolean; ended?: 409 | 410; agent?: string; consent?: string }[] = [];
  const daoSetupAnswers: Awaited<ReturnType<Platform["daoSetups"]["file"]>>[] = [];
  /** Reserves the owner's Treasury agent, or finds it again: as `setup` and a DAO setup's read do. */
  const reserve = (owner: string, organization: string, deployment: string, host: string, expiresAt: number, publicKey: string, signer?: "dao") => {
    const agent = reservations[owner] ?? `treasury-${Object.keys(reservations).length + 1}`;
    reservations[owner] = agent;
    owners[agent] = owner;
    if (!unborn.includes(agent)) unborn.push(agent);
    if (signer === "dao" && !daos.includes(agent)) daos.push(agent);
    const consent = { id: `s${consents.length + 1}`.padEnd(64, "0"), deployment, host, organization, owner, agent, agentId: "unborn", scopes: ["owner" as const],
      expiresAt, createdAt: 0, publicKey, revoked: false, revokedAt: null, ...(signer && { signer }) };
    consents.push(consent);
    return { agent, consent };
  };
  /**
   * Creations prepared under a setup consent, by correlation ID: `stage` is what `owner/status` answers, `voting`
   * until a test moves it. `creationAnswers` and `statusAnswers` queue answers given instead; an Error is thrown.
   */
  const creations: { correlationId: string; organization: string; agent: string; signer: "wallet" | "dao"; publicKey?: string; stage: "voting" | "submitted" | "expired" | "failed" }[] = [];
  const creationAnswers: (PreparedAnswer | Error)[] = [];
  const statusAnswers: (StatusAnswer | Error)[] = [];
  const thrown = <A>(queued: A | Error | undefined) => { if (queued instanceof Error) throw queued; return queued; };
  /**
   * The owner reads' answers, by read: `reads[name]` is what the platform answers (a test may replace it), and
   * `readAnswers[name]` queues answers given before it; an Error is thrown, as a broken call would.
   */
  const reads: { [K in ReadName]: ReadValue<K> } = {
    account: { agentId: "id-portfolio", executor: true, wallet: "portfolio.agents.near", grant: null, stagedGrant: null },
    books: [],
    overview: OVERVIEW, activity: [], held: [], unresolved: [], runs: { ticks: [], corrupt: [] }, recording: undefined,
  };
  const readAnswers: { [K in ReadName]?: (ReadAnswer<ReadPath<K>> | Error)[] } = {};
  const read = async <K extends ReadName>(name: K, organization: string, agent: string, ...rest: string[]): Promise<ReadAnswer<ReadPath<K>>> => {
    calls.push([`reads.${name}`, organization, agent, ...rest].join(" "));
    const queued = readAnswers[name]?.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    const value = reads[name];
    return value === undefined ? { ok: false, kind: "refused", status: 404, error: "No such run" } as never : { ok: true, value } as never;
  };
  /**
   * Funding as the platform keeps it: the account each agent's owner linked to fund it (none until linked), and the
   * deposit addresses it gave, each fresh. `fundingAnswers` queues answers a funding call gives instead, by call; an
   * Error is thrown, as a broken call would.
   */
  const treasuries: Record<string, { accountId: string; confidential: boolean }> = {};
  const deposits: { agent: string; asset: string; address: string }[] = [];
  /**
   * Sweeps as the platform's stream gives them: `sweepRuns` queues runs (an Error is thrown, as a broken call would);
   * otherwise a preview finds one public wNEAR balance past 2^53 raw units, and a shield sends it, succeeding.
   */
  const sweepRuns: (SweepRun | Error)[] = [];
  /**
   * Each agent's strategy and schedule, as the platform keeps them: autopilot off, the strategy bound by the held grant
   * unless `unbound` says otherwise. `autopilotAnswers` queues answers an autopilot call gives instead; an Error is thrown.
   */
  const schedules: Record<string, { on: boolean; unbound?: boolean; digest?: string }> = {};
  /** The strategy each agent's owner last saved; the default before any save. */
  const savedStrategies: Record<string, { targetBps: Record<string, number>; minLegUsd: number; maxCostBps: number; autopilot: { everyMin: number; maxUsd: number } }> = {};
  const autopilotAnswers: Partial<Record<"strategy" | "save" | "status" | "enable" | "stop" | "tick", ({ ok: false; kind: string; status?: number; error?: string } | Error)[]>> = {};
  const DIGEST = `sha256:${"a".repeat(64)}`;
  const autopilotCall = <T,>(name: keyof typeof autopilotAnswers, organization: string, agent: string, rest: string[], value: () => T) => {
    calls.push([`autopilot.${name}`, organization, agent, ...rest].join(" "));
    const queued = autopilotAnswers[name]?.shift();
    if (queued instanceof Error) throw queued;
    return (queued ?? { ok: true, value: value() }) as never;
  };
  const schedule = (agent: string) => schedules[agent] ??= { on: false };
  /**
   * Grants as the platform keeps them, by correlation ID: `prepared` until signed (or, for a DAO, voted), `submitted`
   * after. A submitted grant binds the strategy. `grantAnswers` queues answers a grant call gives instead; an Error is thrown.
   */
  const grants: { correlationId: string; agent: string; signer: "wallet" | "dao"; digest: string; stage: "prepared" | "submitted"; expiresAt: string; signedData?: unknown }[] = [];
  const grantAnswers: Partial<Record<"prepare" | "submit", ({ ok: false; kind: string; status?: number; error?: string } | Error)[]>> = {};
  const fundingAnswers: Partial<Record<"treasury" | "deposit" | "link" | "unlink" | "setConfidential", ({ ok: false; kind: string; status?: number; error?: string } | Error)[]>> = {};
  const funding = <T,>(name: keyof typeof fundingAnswers, organization: string, agent: string, rest: string[], value: () => T) => {
    calls.push([`funding.${name}`, organization, agent, ...rest].join(" "));
    const queued = fundingAnswers[name]?.shift();
    if (queued instanceof Error) throw queued;
    return (queued ?? { ok: true, value: value() }) as never;
  };
  /** Proposals as the platform keeps them, under the Organization that made them. */
  const proposals: (ProposalView & { agent: string })[] = [];
  /** Answers the next proposal actions give instead of their own, by action; an Error is thrown, as a broken call would. */
  const proposalAnswers: Partial<Record<"create" | "approve" | "reject" | "execute" | "get", (ProposalAnswer | Error)[]>> = {};
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
    host: "platform.test",
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
      async create(organization, agent, input) {
        calls.push(`proposals.create ${organization} ${agent} ${input.requestId} ${JSON.stringify(input.legs)}`);
        const queued = next("create");
        if (queued) return queued;
        const made = proposals.find(item => item.organization === organization && item.agent === agent && item.requestId === input.requestId);
        if (made) return { ok: true, value: shown(made) };
        const created = { ...proposal({ id: (proposals.length + 1).toString(16).padStart(32, "0"), requestId: input.requestId, organization,
          expiresAt: input.expiresAt, note: input.note ?? null }), agent };
        proposals.push(created);
        return { ok: true, value: shown(created) };
      },
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
    async setup(submission) {
      calls.push("setup");
      const queued = setupAnswers.shift();
      if (queued) return queued;
      const text = parseSetupMessage(submission.message)!;
      const found = reservations[text.owner];
      if (found && !unborn.includes(found)) return { ok: false, kind: "refused", status: 409, error: "This owner's agent for that area is already created." };
      return { ok: true, value: reserve(text.owner, text.organization, text.deployment, text.host, Date.parse(text.expiresAt), submission.publicKey) };
    },
    daoSetups: {
      async file(message) {
        calls.push("daoSetups.file");
        const queued = daoSetupAnswers.shift();
        if (queued) return queued;
        const text = parseSetupMessage(message)!;
        const id = String(daoSetups.length + 1).padStart(64, "e");
        daoSetups.push({ id, dao: text.owner, organization: text.organization, expiresAt: Date.parse(text.expiresAt), signed: false });
        const request = { id, dao: text.owner, organization: text.organization, area: text.area, expiresAt: Date.parse(text.expiresAt),
          votingUntil: Date.parse(text.expiresAt), hash: id, description: `* Signs: NEP-413 hash ${id}` };
        return { ok: true, value: { request, transactions: { proposal: daoTransaction(text.owner, id), proposalAndVote: daoTransaction(text.owner, id, daoNext(text.owner)) } } };
      },
      async state(id) {
        calls.push(`daoSetups.state ${id}`);
        const found = daoSetups.find(setup => setup.id === id);
        if (!found) return { ok: false, kind: "refused", status: 404, error: "No such DAO setup request" };
        if (found.ended) return { ok: false, kind: "refused", status: found.ended, error: "Ended" };
        if (!found.signed) return { ok: true, value: { state: "pending" as const, request: { id, dao: found.dao, organization: found.organization, area: "treasury",
          expiresAt: found.expiresAt, votingUntil: found.expiresAt, hash: id, description: "" } } } as never;
        if (!found.agent) {
          const reserved = reserve(found.dao, found.organization, "treasury", "platform.test", found.expiresAt, "ed25519:dao", "dao");
          Object.assign(found, { agent: reserved.agent, consent: reserved.consent.id });
        }
        return { ok: true, value: { state: "reserved" as const, agent: found.agent!, consent: consents.find(consent => consent.id === found.consent)! } } as never;
      },
    },
    creation: {
      async prepare(organization, agent, input) {
        calls.push(`creation.prepare ${agent} ${input.signer}`);
        const queued = thrown(creationAnswers.shift());
        if (queued) return queued;
        const correlationId = `create-${creations.length + 1}`, expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        creations.push({ correlationId, organization, agent, signer: input.signer, ...(input.signer === "wallet" && { publicKey: input.action.owner.public_key }), stage: "voting" });
        const common = { correlationId, expiresAt, digest: null, preview: { summary: "Create a Treasury agent" } };
        if (input.signer === "wallet") return { ok: true, value: { ...common, confirm: { url: `https://platform.test/confirm/${correlationId}`, expiresAt } } } as PreparedAnswer;
        const dao = owners[agent]!, hash = correlationId.padStart(64, "c");
        return { ok: true, value: { ...common, dao: { owner: dao, transaction: daoTransaction(dao, hash), proposal: daoTransaction(dao, hash), proposalAndVote: daoTransaction(dao, hash, daoNext(dao)) } } } as PreparedAnswer;
      },
      async status(_organization, agent, correlationId) {
        calls.push(`creation.status ${agent} ${correlationId}`);
        const queued = thrown(statusAnswers.shift());
        if (queued) return queued;
        const found = creations.find(item => item.correlationId === correlationId && item.agent === agent);
        if (!found) return { ok: false, kind: "refused", status: 404, error: "No such owner action" } as StatusAnswer;
        return { ok: true, value: { stage: found.stage } } as StatusAnswer;
      },
    },
    reads: {
      account: (organization, agent) => read("account", organization, agent),
      books: (organization, agent) => read("books", organization, agent),
      overview: (organization, agent) => read("overview", organization, agent),
      activity: (organization, agent) => read("activity", organization, agent),
      held: (organization, agent) => read("held", organization, agent),
      unresolved: (organization, agent) => read("unresolved", organization, agent),
      runs: (organization, agent) => read("runs", organization, agent),
      recording: (organization, agent, tickId) => read("recording", organization, agent, tickId),
    },
    grant: {
      async prepare(organization, agent, input) {
        calls.push(`grant.prepare ${organization} ${agent} ${input.signer} ${input.action.expectedStrategyDigest}`);
        const queued = grantAnswers.prepare?.shift();
        if (queued instanceof Error) throw queued;
        if (queued) return queued as PreparedAnswer;
        const correlationId = `grant-${grants.length + 1}`, expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        grants.push({ correlationId, agent, signer: input.signer, digest: input.action.expectedStrategyDigest, stage: "prepared", expiresAt });
        const common = { correlationId, expiresAt, digest: null, preview: { summary: "Issue a treasury grant" } };
        if (input.signer === "wallet") return { ok: true, value: { ...common,
          intent: { standard: "nep413", payload: { message: `grant ${correlationId}`, recipient: "provider.test", nonce: Buffer.alloc(32, 1).toString("base64") } } } } as PreparedAnswer;
        const dao = owners[agent]!, hash = correlationId.padStart(64, "c");
        return { ok: true, value: { ...common, dao: { owner: dao, transaction: daoTransaction(dao, hash), proposal: daoTransaction(dao, hash), proposalAndVote: daoTransaction(dao, hash, daoNext(dao)) } } } as PreparedAnswer;
      },
      async submit(organization, agent, input) {
        calls.push(`grant.submit ${organization} ${agent} ${input.correlationId}`);
        const queued = grantAnswers.submit?.shift();
        if (queued instanceof Error) throw queued;
        if (queued) return queued as never;
        const found = grants.find(item => item.correlationId === input.correlationId && item.agent === agent);
        if (!found) return { ok: false, kind: "refused", status: 404, error: "No such owner action" } as never;
        found.stage = "submitted";
        found.signedData = input.signedData;
        schedule(agent).unbound = false;
        return { ok: true, value: { status: "SUCCESS", failureCode: null } } as never;
      },
      async actions(organization, agent) {
        calls.push(`grant.actions ${organization} ${agent}`);
        return { ok: true, value: grants.filter(item => item.agent === agent).map(item => ({ correlationId: item.correlationId, type: "grant_issue", expiresAt: item.expiresAt,
          signer: item.signer, stage: item.stage, ownerSucceeded: item.stage === "submitted", status: null, failureCode: null, payment: null })) } as never;
      },
      async status(_organization, agent, correlationId) {
        calls.push(`grant.status ${agent} ${correlationId}`);
        const found = grants.find(item => item.correlationId === correlationId && item.agent === agent);
        if (!found) return { ok: false, kind: "refused", status: 404, error: "No such owner action" } as StatusAnswer;
        return { ok: true, value: { stage: found.stage === "submitted" ? "submitted" : found.signer === "dao" ? "voting" : "submitting" } } as StatusAnswer;
      },
    },
    autopilot: {
      strategy: async (organization, agent) => autopilotCall("strategy", organization, agent, [], () => {
        const { on, unbound, digest = DIGEST } = schedule(agent);
        return { strategy: savedStrategies[agent] ?? { targetBps: { "nep141:wrap.near": 10_000 }, minLegUsd: 10, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 100 } },
          digest, grantSuffix: "a".repeat(16), executor: true, on, grantMatches: !unbound, unresolved: 0, grant: null,
          readiness: unbound ? { state: "authorization-required", reasons: ["The owner must issue a matching grant before this strategy can act on its schedule."], canEnable: false }
            : { state: on ? "ready" : "off", reasons: [], canEnable: !on }, observedAt: new Date().toISOString() };
      }),
      save: async (organization, agent, input) => autopilotCall("save", organization, agent, [input.expectedDigest], () => {
        const current = schedule(agent);
        current.on = false;
        current.unbound = true;
        current.digest = `sha256:${String(Object.keys(savedStrategies).length + 1).padStart(64, "b")}`;
        savedStrategies[agent] = input.strategy;
        return { strategy: input.strategy, digest: current.digest, on: false };
      }),
      status: async (organization, agent) => autopilotCall("status", organization, agent, [], () =>
        ({ on: schedule(agent).on, everyMin: 60, maxUsd: 100, lastRun: null, nextRun: null })),
      enable: async (organization, agent, expectedDigest) => autopilotCall("enable", organization, agent, [expectedDigest], () => {
        schedule(agent).on = true;
        return { strategy: { targetBps: {}, minLegUsd: 10, maxCostBps: 50, autopilot: { everyMin: 60, maxUsd: 100 } }, digest: expectedDigest, on: true };
      }),
      stop: async (organization, agent) => autopilotCall("stop", organization, agent, [], () => { schedule(agent).on = false; return { on: false as const }; }),
      tick: async (organization, agent) => autopilotCall("tick", organization, agent, [], () => "Ran: nothing to rebalance."),
    },
    funding: {
      treasury: async (organization, agent) => funding("treasury", organization, agent, [], () => {
        const linked = treasuries[agent];
        return linked ? { accountId: linked.accountId, dao: null, balances: { near: "1000000000000000000000000", usdc: "5000000" }, confidential: linked.confidential, payees: [] } : null;
      }),
      deposit: async (organization, agent, asset) => funding("deposit", organization, agent, [asset], () => {
        const address = `${(deposits.length + 1).toString(16).padStart(64, "0")}`;
        deposits.push({ agent, asset, address });
        return { correlationId: `deposit-${deposits.length}`, address, memo: null, minAmount: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      }),
      link: async (organization, agent, accountId) => funding("link", organization, agent, [accountId], () => { treasuries[agent] = { accountId, confidential: false }; }),
      unlink: async (organization, agent) => funding("unlink", organization, agent, [], () => { delete treasuries[agent]; }),
      setConfidential: async (organization, agent, confidential) => funding("setConfidential", organization, agent, [String(confidential)], () => {
        if (treasuries[agent]) treasuries[agent].confidential = confidential;
      }),
      async sweep(organization, agent, execute) {
        calls.push(`funding.sweep ${organization} ${agent} ${execute}`);
        const queued = sweepRuns.shift();
        if (queued instanceof Error) throw queued;
        if (queued) return queued;
        const plan = { type: "plan" as const, exposed: [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, price: 2.5, public: BIG, confidential: 0n, usd: 308.64 }] };
        return { events: execute ? [plan, { type: "shield" as const, asset: "nep141:wrap.near", status: "SUCCESS", correlationId: "shield-1" }] : [plan], ended: null };
      },
    },
  };
  /** The agent's creation completes: it has an ID from now on. */
  const create = (agent: string) => { unborn.splice(unborn.indexOf(agent), 1); };
  async function decide(verdict: "approve" | "reject", organization: string, agent: string, id: string): Promise<ProposalAnswer> {
    calls.push(`proposals.${verdict} ${organization} ${agent} ${id}`);
    const queued = next(verdict);
    if (queued) return queued;
    const found = find(organization, agent, id);
    if (!found) return notFound;
    found.state = verdict === "approve" ? "approved" : "rejected";
    return { ok: true, value: shown(found) };
  }
  return { platform, calls, consents, consentAnswers, proposals, proposalAnswers, daoRequests, daoAnswers, daoVotes, voteAnswers, treasuries, deposits, fundingAnswers, sweepRuns, schedules, autopilotAnswers, grants, grantAnswers,
    reservations, setupAnswers, daoSetups, daoSetupAnswers, creations, creationAnswers, statusAnswers, create, reads, readAnswers };
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

/** The owner reads by name, and the platform procedure each one is. */
const READ_PATHS = { account: "account", books: "reconcileBooks", overview: "overview", activity: "activity", held: "held", unresolved: "unresolved", runs: "autopilot/evidence", recording: "autopilot/log" } as const;
type ReadName = keyof typeof READ_PATHS;
type ReadPath<K extends ReadName> = (typeof READ_PATHS)[K];
type ReadValue<K extends ReadName> = Extract<ReadAnswer<ReadPath<K>>, { ok: true }>["value"] | (K extends "recording" ? undefined : never);

/** A wNEAR balance past 2^53 raw units: a float would lose it, so it must reach the page exactly. */
export const BIG = 123_456_789_012_345_678_901_234_567n;
/** The portfolio's overview as the SDK answers it: amounts as `bigint`. */
export const OVERVIEW: Extract<ReadAnswer<"overview">, { ok: true }>["value"] = {
  agentId: "id-portfolio",
  book: [{ asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, public: 0n, confidential: BIG, price: 2.5, priceUpdatedAt: "2026-11-05T00:00:00.000Z",
    priceExpiresAt: "2026-11-05T00:05:00.000Z", usd: 308.64 }],
  unmanaged: [{ asset: "nep141:usdt.tether-token.near", symbol: "USDT", decimals: 6, amount: 5_000_000n, price: null, priceUpdatedAt: null, priceExpiresAt: null, usd: null }],
  target: { "nep141:wrap.near": 5000 }, rebalance: { minLegUsd: 10, maxCostBps: 50 },
  policy: { wallet_id: "wallet-portfolio", revision: 3, status: "APPLIED", provider_policy_synced: true,
    cooldowns: { policy_change_available_at: null, unfreeze_available_at: null }, policy: null,
    usage: { budget: Object.fromEntries(["daily", "weekly", "monthly"].map(window => [window, { limit_usd: null, spent_usd: "0.000000", remaining_usd: null, resets_at: null }])) as never,
      timelock: { delay_ms: 0, scheduled_count: 0 } } },
  digest: null, notInForce: null, agreed: [], grants: [],
};
