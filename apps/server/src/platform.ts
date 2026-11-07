import { appClient, type AppBase, type AppInputs, type OwnerFailure, type OwnerOutput, type OwnerResult, type ProposalView } from "@multiagency/sdk";
import type { Credential } from "./credential.ts";

type App = ReturnType<typeof appClient>;
export type IdentityAnswer = Awaited<ReturnType<App["identity"]>>;
type Call = ReturnType<App["agent"]>["call"];
/** A failure of a call to an agent's procedures, as the SDK reports it. */
type CallFailure = Extract<Awaited<ReturnType<Call>>, { ok: false }>;
export type ProposalAnswer = { ok: true; value: ProposalView } | CallFailure;
export type ProposalListAnswer = { ok: true; value: { proposals: ProposalView[] } } | CallFailure;
type Signed = { message: string; nonce: string; publicKey: string; signature: string };
/** A consent as the platform lists and stores it. */
export type ConsentRecord = Extract<Awaited<ReturnType<App["consents"]["list"]>>, { ok: true }>["value"]["consents"][number];
/** A DAO consent request as the platform answers its filing: the request, and the transactions a member may file. */
export type DaoConsentFiled = Extract<Awaited<ReturnType<App["daoConsents"]["file"]>>, { ok: true }>["value"];
/** A wallet owner's setup as the platform answers it: the reserved agent, and the setup consent that may relay its creation. */
export type SetupAnswer = Awaited<ReturnType<App["setup"]>>;
/** An owner action prepared for the owner to sign (on the platform's confirm page) or for the DAO's vote. */
export type PreparedAnswer = OwnerResult<OwnerOutput<"owner/prepare">>;
/** Where an owner action stands: submitted, still voting, expired or failed. */
export type StatusAnswer = OwnerResult<OwnerOutput<"owner/status">>;
/** An owner read as the SDK answers it: its parsed output, `bigint` amounts included, or the failure's kind. */
export type ReadAnswer<P extends "account" | "reconcileBooks" | "overview" | "activity" | "held" | "unresolved" | "autopilot/evidence" | "autopilot/log" | "ledgerCsv" | "owner/actions"> = OwnerResult<OwnerOutput<P>>;
/**
 * A sweep as it ran: every event the stream gave, and how it ended (`null` when it ended normally). A stream lost after
 * any event ends `unknown`, as the SDK reports it: a shield may have gone out.
 */
export type SweepRun = { events: OwnerOutput<"sweep">[]; ended: OwnerFailure | null };
/** A read or action of the agent's strategy and autopilot, as the SDK answers it. */
export type AutopilotAnswer<P extends "strategy/get" | "strategy/save" | "autopilot/get" | "autopilot/enable" | "autopilot/stop" | "autopilot/tick"> = OwnerResult<OwnerOutput<P>>;
/** A call that funds the agent, or changes its funding account, as the SDK answers it. */
export type FundingAnswer<P extends "treasury/get" | "deposit" | "treasury/link" | "treasury/unlink" | "treasury/setConfidential"> = OwnerResult<OwnerOutput<P>>;
/** The assets a deposit address takes: USDC, or wNEAR, which NEAR is wrapped into to fund it. */
export type DepositAsset = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" | "nep141:wrap.near";
/** An identity answer, and whether it was reused rather than read from the platform for this request. */
export type IdentityRead = { answer: IdentityAnswer; cached: boolean };

/**
 * What `watch` may ask the platform: an agent's three reads it decides from, its own proposals' create, read and list,
 * and the identity and consents that tell it why it was refused. Nothing that approves, executes, withdraws, consents,
 * changes a strategy or autopilot, or plans: those are out of its reach by type (`test/watch-platform.test.ts`).
 */
export type WatchPlatform = {
  overview(organization: string, agent: string): Promise<OwnerResult<OwnerOutput<"overview">>>;
  unresolved(organization: string, agent: string): Promise<OwnerResult<OwnerOutput<"unresolved">>>;
  autopilot(organization: string, agent: string): Promise<OwnerResult<OwnerOutput<"autopilot/get">>>;
  list(organization: string, agent: string): Promise<ProposalListAnswer>;
  get(organization: string, agent: string, id: string): Promise<ProposalAnswer>;
  create(organization: string, agent: string, input: AppInputs["proposals/create"]): Promise<ProposalAnswer>;
  identity: Platform["identity"];
  consents(organization: string): ReturnType<App["consents"]["list"]>;
};

/** What the server asks the platform. Every call goes through here; tests replace it with a fake. */
export type Platform = {
  /** The platform's host: what an owner signs a setup for, before any agent names it. */
  host: string;
  /**
   * The agent's owner and identity, as a consent must name them. Needs only the credential, no consent. A successful
   * answer is reused for up to a minute unless `fresh` is asked for. A failure is never reused, a 404 included: an agent
   * set up a moment later must be reachable at once, and the per-account request limit bounds repeated lookups.
   */
  identity(agent: string, options?: { fresh?: boolean }): Promise<IdentityRead>;
  /**
   * An agent's Treasury proposals under an Organization's consent: read, the owner's signed verdict relayed, and
   * execution asked for once. Only these procedures; the server can't reach any other of the agent's.
   */
  proposals: {
    /** Proposes a swap plan for the owner to approve: sent again only unchanged, under the same `requestId`. */
    create(organization: string, agent: string, input: AppInputs["proposals/create"]): Promise<ProposalAnswer>;
    list(organization: string, agent: string): Promise<ProposalListAnswer>;
    get(organization: string, agent: string, id: string): Promise<ProposalAnswer>;
    approve(organization: string, agent: string, input: { id: string; signed: Signed }): Promise<ProposalAnswer>;
    reject(organization: string, agent: string, input: { id: string; signed: Signed }): Promise<ProposalAnswer>;
    execute(organization: string, agent: string, id: string): Promise<ProposalAnswer>;
  };
  /** This deployment's consents: an Organization's, the owner's signed consent stored, or one revoked. */
  consents: {
    list(organization: string): ReturnType<App["consents"]["list"]>;
    submit(submission: Parameters<App["consents"]["submit"]>[0]): ReturnType<App["consents"]["submit"]>;
    revoke(id: string): ReturnType<App["consents"]["revoke"]>;
  };
  /**
   * A DAO's consent, signed by its own vote: the canonical consent text filed for the DAO to vote on, and the request
   * read by its ID. Reading it after the vote passed is what stores the consent.
   */
  daoConsents: {
    file(message: string): ReturnType<App["daoConsents"]["file"]>;
    state(id: string): ReturnType<App["daoConsents"]["state"]>;
  };
  /**
   * A DAO's vote on one of this app's Treasury proposals: filed from the platform's own text of the proposal, and the
   * request read by its ID. Reading it after the vote passed is what relays it to the proposal.
   */
  daoVotes: {
    file(input: { organization: string; agent: string; proposal: string; verdict: "approve" | "reject" }): ReturnType<App["daoVotes"]["file"]>;
    state(id: string): ReturnType<App["daoVotes"]["state"]>;
  };
  /** A wallet owner's signed setup text: reserves the Organization's Treasury agent and stores its setup consent. */
  setup(submission: Parameters<App["setup"]>[0]): Promise<SetupAnswer>;
  /**
   * A DAO's setup, signed by its own vote: the canonical setup text filed for the DAO to vote on, and the request read
   * by its ID. Reading it after the vote passed is what reserves the agent.
   */
  daoSetups: {
    file(message: string): ReturnType<App["daoSetups"]["file"]>;
    state(id: string): ReturnType<App["daoSetups"]["state"]>;
  };
  /**
   * An agent's creation, under its setup consent: prepared for the owner (a wallet owner signs it on the platform's
   * confirm page; a DAO votes on it), and followed by its correlation ID. No other owner action.
   */
  creation: {
    prepare(organization: string, agent: string, input: { action: { type: "agent_create"; role: "treasury"; owner: { type: "near"; account_id: string; public_key: string } }; signer: "wallet" }
      | { action: { type: "agent_create"; role: "treasury" }; signer: "dao" }): Promise<PreparedAnswer>;
    status(organization: string, agent: string, correlationId: string): Promise<StatusAnswer>;
  };
  /**
   * The agent's owner reads under an Organization's consent: its account (its wallet and the grants its executor
   * holds), its holdings and policy, its activity, payouts held for approval, operations whose outcome isn't proven,
   * and the autopilot's recorded runs and one run's recording.
   * Reads only: nothing here sends anything.
   */
  reads: {
    account(organization: string, agent: string): Promise<ReadAnswer<"account">>;
    /** Per asset, the provider's balances against the chain and against recorded executions. */
    books(organization: string, agent: string): Promise<ReadAnswer<"reconcileBooks">>;
    overview(organization: string, agent: string): Promise<ReadAnswer<"overview">>;
    activity(organization: string, agent: string): Promise<ReadAnswer<"activity">>;
    held(organization: string, agent: string): Promise<ReadAnswer<"held">>;
    unresolved(organization: string, agent: string): Promise<ReadAnswer<"unresolved">>;
    runs(organization: string, agent: string): Promise<ReadAnswer<"autopilot/evidence">>;
    recording(organization: string, agent: string, tickId: string): Promise<ReadAnswer<"autopilot/log">>;
    /** The agent's ledger as CSV text (`ledgerCsv`, under `read`): every operation it recorded, for the owner to keep. */
    ledgerCsv(organization: string, agent: string): Promise<ReadAnswer<"ledgerCsv">>;
    /** The owner's actions for the agent and where each stands (`owner/actions`, an app read): the platform's record, across devices. */
    ownerActions(organization: string, agent: string): Promise<ReadAnswer<"owner/actions">>;
  };
  /**
   * Funding the agent under an Organization's consent (its `treasury` scope): the account linked to fund it, a one-time
   * deposit address, and a wallet owner's link to that account. A DAO's consent is refused the link and its setting:
   * a DAO agent's funding account is the DAO, fixed at setup.
   */
  funding: {
    treasury(organization: string, agent: string): Promise<FundingAnswer<"treasury/get">>;
    deposit(organization: string, agent: string, asset: DepositAsset): Promise<FundingAnswer<"deposit">>;
    link(organization: string, agent: string, accountId: string): Promise<FundingAnswer<"treasury/link">>;
    unlink(organization: string, agent: string): Promise<FundingAnswer<"treasury/unlink">>;
    setConfidential(organization: string, agent: string, confidential: boolean): Promise<FundingAnswer<"treasury/setConfidential">>;
    /**
     * Shields the managed public balances (`execute`), or previews which are public: one stream, read to its end, never
     * sent again. A throw before any event is the caller's lost answer.
     */
    sweep(organization: string, agent: string, execute: boolean): Promise<SweepRun>;
  };
  /**
   * A grant binding the saved strategy (`grant_issue`, label `treasury`, for the strategy's digest): prepared for a wallet
   * owner to sign (under `owner`) or for a DAO's vote (under `treasury`), and its owner actions read. Its signature is
   * submitted and its status followed with the other owner actions (`owner.submit`, `owner.status`).
   */
  grant: {
    prepare(organization: string, agent: string, input: { action: { type: "grant_issue"; label: "treasury"; expectedStrategyDigest: string }; signer: "wallet" | "dao" }): Promise<PreparedAnswer>;
    actions(organization: string, agent: string): Promise<OwnerResult<OwnerOutput<"owner/actions">>>;
  };
  /**
   * An owner action other than a grant (#133), prepared the same way: for a wallet owner to sign (under `owner`), or for
   * a DAO's vote. Today a freeze or unfreeze; the same call takes a grant's revocation and a policy edit when they come
   * (#142, #134). Submitting a wallet owner's signature and following the action are `submit` and `status`, the platform's
   * `owner/submit` and `owner/status` whatever the action.
   */
  owner: {
    prepare(organization: string, agent: string, input: { action: { type: "agent_freeze" } | { type: "agent_unfreeze" }; signer: "wallet" | "dao" }): Promise<PreparedAnswer>;
    submit(organization: string, agent: string, input: { correlationId: string; signedData: Record<string, unknown> }): Promise<OwnerResult<OwnerOutput<"owner/submit">>>;
    status(organization: string, agent: string, correlationId: string): Promise<StatusAnswer>;
  };
  /**
   * The agent's saved strategy and autopilot, under an Organization's consent (`treasury`): the strategy with whether
   * the held grant binds it, the schedule's state, and the schedule turned on (for the strategy digest the owner saw),
   * off, or run once now within its ceiling.
   */
  autopilot: {
    strategy(organization: string, agent: string): Promise<AutopilotAnswer<"strategy/get">>;
    status(organization: string, agent: string): Promise<AutopilotAnswer<"autopilot/get">>;
    /** Saves a strategy over the one the owner saw (`expectedDigest`): autopilot turns off, and the grant no longer binds it. */
    save(organization: string, agent: string, input: AppInputs["strategy/save"]): Promise<AutopilotAnswer<"strategy/save">>;
    enable(organization: string, agent: string, expectedDigest: string): Promise<AutopilotAnswer<"autopilot/enable">>;
    stop(organization: string, agent: string): Promise<AutopilotAnswer<"autopilot/stop">>;
    tick(organization: string, agent: string): Promise<AutopilotAnswer<"autopilot/tick">>;
  };
};


/**
 * The platform through `appClient`, under the deployment's credential as it stands now: the credential module checks
 * its file on every call and reads it again when it has changed. Each call has a timeout: a fetch that's aborted is a
 * lost answer, which the SDK reports by kind (`unavailable` for a read). Only the SDK's own headers are sent:
 * `/apps/v1` refuses any request carrying an `Origin` or `Cookie` header, so nothing from a browser request is forwarded.
 *
 * A successful identity is reused for `cacheMs` (a minute), per agent, and reads that miss together share one
 * call. Only the newest read started for an agent may change what's kept, so an older read that answers late can't
 * overwrite a newer one. The platform allows each credential 1,200 calls
 * an hour (`hourlyLimit(1_200)` in its `app-routes.ts`), about 20 a minute for the whole deployment, owners' pages,
 * `watch` and proposals together, so reading it on every request would spend that on ownership checks alone.
 */
export function createPlatform({ origin, credential, timeoutMs, executeTimeoutMs = timeoutMs, cacheMs = 60_000, now = Date.now, fetch: send = fetch }: {
  origin: string; credential: Credential; timeoutMs: number;
  /** For `proposals/execute` only: the platform answers once the plan's swaps have run, which takes longer than any other call. */
  executeTimeoutMs?: number;
  cacheMs?: number; now?: () => number; fetch?: typeof fetch;
}): Platform & { watch: WatchPlatform } {
  const timed = (ms: number): typeof fetch => (input, init) =>
    send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
  type Clients = { secret: Awaited<ReturnType<Credential["get"]>>; client: ReturnType<typeof appClient>; executing: ReturnType<typeof appClient> };
  let current: Clients | undefined;
  const clients = async (): Promise<Clients> => {
    const secret = await credential.get();
    if (current?.secret !== secret) {
      const of = (ms: number) => appClient({ base: origin as AppBase, credential: secret.reveal(), fetch: timed(ms) });
      current = { secret, client: of(timeoutMs), executing: of(executeTimeoutMs) };
    }
    return current;
  };
  const client = async () => (await clients()).client;
  const kept = new Map<string, { answer: IdentityAnswer; until: number }>();
  const reading = new Map<string, Promise<IdentityAnswer>>();
  const newest = new Map<string, number>();
  let started = 0;
  const read = (agent: string) => {
    const generation = ++started;
    newest.set(agent, generation);
    const pending = (async () => {
      const answer = await (await client()).identity(agent);
      if (newest.get(agent) === generation) {
        if (answer.ok) kept.set(agent, { answer, until: now() + cacheMs });
        else kept.delete(agent);
      }
      return answer;
    })().finally(() => { if (reading.get(agent) === pending) reading.delete(agent); });
    reading.set(agent, pending);
    return pending;
  };
  const identity: Platform["identity"] = async (agent, { fresh = false } = {}) => {
    if (!fresh) {
      const reuse = kept.get(agent);
      if (reuse && reuse.until > now()) return { answer: reuse.answer, cached: true };
    }
    return { answer: await ((!fresh && reading.get(agent)) || read(agent)), cached: false };
  };
  const proposals: Platform["proposals"] = {
    create: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/create", input) as Promise<ProposalAnswer>,
    list: async (organization, agent) => (await client()).agent(organization, agent).call("proposals/list") as Promise<ProposalListAnswer>,
    get: async (organization, agent, id) => (await client()).agent(organization, agent).call("proposals/get", { id }) as Promise<ProposalAnswer>,
    approve: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/approve", input) as Promise<ProposalAnswer>,
    reject: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/reject", input) as Promise<ProposalAnswer>,
    execute: async (organization, agent, id) => (await clients()).executing.agent(organization, agent).call("proposals/execute", { id }) as Promise<ProposalAnswer>,
  };
  const consents: Platform["consents"] = {
    list: async organization => (await client()).consents.list(organization),
    submit: async submission => (await client()).consents.submit(submission),
    revoke: async id => (await client()).consents.revoke(id),
  };
  const daoConsents: Platform["daoConsents"] = {
    file: async message => (await client()).daoConsents.file(message),
    state: async id => (await client()).daoConsents.state(id),
  };
  const daoVotes: Platform["daoVotes"] = {
    file: async input => (await client()).daoVotes.file(input),
    state: async id => (await client()).daoVotes.state(id),
  };
  return {
    host: new URL(origin).host,
    identity,
    proposals,
    consents,
    daoConsents,
    daoVotes,
    setup: async submission => (await client()).setup(submission),
    daoSetups: {
      file: async message => (await client()).daoSetups.file(message),
      state: async id => (await client()).daoSetups.state(id),
    },
    creation: {
      prepare: async (organization, agent, input) => (await client()).agent(organization, agent).call("owner/prepare", input),
      status: async (organization, agent, correlationId) => (await client()).agent(organization, agent).call("owner/status", { correlationId }),
    },
    reads: {
      account: async (organization, agent) => (await client()).agent(organization, agent).call("account"),
      books: async (organization, agent) => (await client()).agent(organization, agent).call("reconcileBooks"),
      overview: async (organization, agent) => (await client()).agent(organization, agent).call("overview"),
      activity: async (organization, agent) => (await client()).agent(organization, agent).call("activity"),
      held: async (organization, agent) => (await client()).agent(organization, agent).call("held"),
      unresolved: async (organization, agent) => (await client()).agent(organization, agent).call("unresolved"),
      runs: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/evidence", {}),
      recording: async (organization, agent, tickId) => (await client()).agent(organization, agent).call("autopilot/log", { tickId }),
      ledgerCsv: async (organization, agent) => (await client()).agent(organization, agent).call("ledgerCsv"),
      ownerActions: async (organization, agent) => (await client()).agent(organization, agent).call("owner/actions"),
    },
    owner: {
      prepare: async (organization, agent, input) => (await client()).agent(organization, agent).call("owner/prepare", input),
      submit: async (organization, agent, input) => (await client()).agent(organization, agent).call("owner/submit", input),
      status: async (organization, agent, correlationId) => (await client()).agent(organization, agent).call("owner/status", { correlationId }),
    },
    funding: {
      treasury: async (organization, agent) => (await client()).agent(organization, agent).call("treasury/get"),
      deposit: async (organization, agent, asset) => (await client()).agent(organization, agent).call("deposit", { asset }),
      link: async (organization, agent, accountId) => (await client()).agent(organization, agent).call("treasury/link", { accountId }),
      unlink: async (organization, agent) => (await client()).agent(organization, agent).call("treasury/unlink"),
      setConfidential: async (organization, agent, confidential) => (await client()).agent(organization, agent).call("treasury/setConfidential", { confidential }),
      async sweep(organization, agent, execute) {
        const events: OwnerOutput<"sweep">[] = [];
        const stream = (await client()).agent(organization, agent).stream("sweep", { execute });
        try {
          for (let next = await stream.next(); ; next = await stream.next()) {
            if (next.done) return { events, ended: next.value ?? null };
            events.push(next.value);
          }
        } catch (error) {
          if (!events.length) throw error;
          void stream.return(undefined).catch(() => {});
          return { events, ended: { ok: false, kind: "unknown", procedure: "sweep", identity: { execute } } };
        }
      },
    },
    grant: {
      prepare: async (organization, agent, input) => (await client()).agent(organization, agent).call("owner/prepare", input),
      actions: async (organization, agent) => (await client()).agent(organization, agent).call("owner/actions"),
    },
    autopilot: {
      strategy: async (organization, agent) => (await client()).agent(organization, agent).call("strategy/get"),
      status: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/get"),
      save: async (organization, agent, input) => (await client()).agent(organization, agent).call("strategy/save", input),
      enable: async (organization, agent, expectedDigest) => (await client()).agent(organization, agent).call("autopilot/enable", { expectedDigest }),
      stop: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/stop"),
      tick: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/tick"),
    },
    watch: {
      overview: async (organization, agent) => (await client()).agent(organization, agent).call("overview"),
      unresolved: async (organization, agent) => (await client()).agent(organization, agent).call("unresolved"),
      autopilot: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/get"),
      list: proposals.list,
      get: proposals.get,
      create: proposals.create,
      identity,
      consents: consents.list,
    },
  };
}
