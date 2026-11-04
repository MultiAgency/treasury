import { appClient, type AppBase, type AppInputs, type OwnerOutput, type OwnerResult, type ProposalView } from "@multiagency/sdk";
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
   * A DAO owner's signatures, each the DAO's own vote: its consent filed from the canonical text, and its vote on one of
   * this app's proposals. `file` answers the proposal a member files; `state` reads it until it's final, and reading it
   * after the vote passed is what stores the consent or relays the vote. Filing again files a new request.
   */
  dao: {
    consents: { file(message: string): ReturnType<App["daoConsents"]["file"]>; state(id: string): ReturnType<App["daoConsents"]["state"]> };
    votes: { file(input: Parameters<App["daoVotes"]["file"]>[0]): ReturnType<App["daoVotes"]["file"]>; state(id: string): ReturnType<App["daoVotes"]["state"]> };
  };
};
/** A DAO consent request's state, as the platform answers it. */
export type DaoConsentStateAnswer = Awaited<ReturnType<App["daoConsents"]["state"]>>;
export type DaoVoteStateAnswer = Awaited<ReturnType<App["daoVotes"]["state"]>>;


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
export function createPlatform({ origin, credential, timeoutMs, cacheMs = 60_000, now = Date.now, fetch: send = fetch }: {
  origin: string; credential: Credential; timeoutMs: number; cacheMs?: number; now?: () => number; fetch?: typeof fetch;
}): Platform & { watch: WatchPlatform } {
  const timed: typeof fetch = (input, init) =>
    send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  let current: { secret: Awaited<ReturnType<Credential["get"]>>; client: ReturnType<typeof appClient> } | undefined;
  const client = async () => {
    const secret = await credential.get();
    if (current?.secret !== secret) current = { secret, client: appClient({ base: origin as AppBase, credential: secret.reveal(), fetch: timed }) };
    return current.client;
  };
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
    list: async (organization, agent) => (await client()).agent(organization, agent).call("proposals/list") as Promise<ProposalListAnswer>,
    get: async (organization, agent, id) => (await client()).agent(organization, agent).call("proposals/get", { id }) as Promise<ProposalAnswer>,
    approve: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/approve", input) as Promise<ProposalAnswer>,
    reject: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/reject", input) as Promise<ProposalAnswer>,
    execute: async (organization, agent, id) => (await client()).agent(organization, agent).call("proposals/execute", { id }) as Promise<ProposalAnswer>,
  };
  const consents: Platform["consents"] = {
    list: async organization => (await client()).consents.list(organization),
    submit: async submission => (await client()).consents.submit(submission),
    revoke: async id => (await client()).consents.revoke(id),
  };
  const dao: Platform["dao"] = {
    consents: { file: async message => (await client()).daoConsents.file(message), state: async id => (await client()).daoConsents.state(id) },
    votes: { file: async input => (await client()).daoVotes.file(input), state: async id => (await client()).daoVotes.state(id) },
  };
  return {
    identity,
    proposals,
    consents,
    dao,
    watch: {
      overview: async (organization, agent) => (await client()).agent(organization, agent).call("overview"),
      unresolved: async (organization, agent) => (await client()).agent(organization, agent).call("unresolved"),
      autopilot: async (organization, agent) => (await client()).agent(organization, agent).call("autopilot/get"),
      list: proposals.list,
      get: proposals.get,
      create: async (organization, agent, input) => (await client()).agent(organization, agent).call("proposals/create", input) as Promise<ProposalAnswer>,
      identity,
      consents: consents.list,
    },
  };
}
