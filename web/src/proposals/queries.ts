import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { proposalsApi, type Failure, type Result } from "./proposals-api";
import { failureText } from "./words";

export const api = proposalsApi();

/** A failed read, decided by `failure.kind`; the message is only for people. */
export class ServerError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failureText(failure, "read"));
    this.failure = failure;
  }
}
const answered = <T,>(result: Result<T>): T => {
  if (!result.ok) throw new ServerError(result);
  return result.value;
};
export const failureOf = (error: unknown) => error instanceof ServerError ? error.failure : undefined;

/** Proposals that may still change on their own are read again every few seconds. */
const MOVING = new Set(["executing", "unknown"]);

/** One agent's reads, keyed by its name. Reads are never retried here: each failure shows with its own "Check again". */
export function agentReads(name: string) {
  const agent = api.agent(name);
  const key = ["agent", name] as const;
  return {
    name,
    agent,
    identity: queryOptions({ queryKey: [...key, "identity"], queryFn: async () => answered(await agent.identity()), retry: false }),
    /** The live consent, and for a DAO its consent request while one waits for the vote, read again every half minute. */
    consent: queryOptions({ queryKey: [...key, "consent"], queryFn: async () => answered(await agent.consent()), retry: false,
      refetchInterval: query => query.state.data?.request ? 30_000 : false }),
    /**
     * The owner reads (#61), read when the page shows them and not again on their own: each is a call from the
     * deployment's shared 1,200 an hour, so "Check again" reads them anew.
     */
    overview: queryOptions({ queryKey: [...key, "overview"], queryFn: async () => answered(await agent.overview()), retry: false }),
    activity: queryOptions({ queryKey: [...key, "activity"], queryFn: async () => answered(await agent.activity()), retry: false }),
    held: queryOptions({ queryKey: [...key, "held"], queryFn: async () => answered(await agent.held()), retry: false }),
    unresolved: queryOptions({ queryKey: [...key, "unresolved"], queryFn: async () => answered(await agent.unresolved()), retry: false }),
    runs: queryOptions({ queryKey: [...key, "runs"], queryFn: async () => answered(await agent.runs()), retry: false }),
    ownerActions: queryOptions({ queryKey: [...key, "owner-actions"], queryFn: async () => answered(await agent.ownerActions()), retry: false }),
    /**
     * The owner action still awaiting its outcome (`owner/pending`, #133): read when the page shows it, and not within
     * half a minute of the last read, so the frame costs the platform at most two reads a minute on any page.
     */
    ownerPending: queryOptions({ queryKey: [...key, "owner-pending"], queryFn: async () => answered(await agent.ownerPending()), retry: false, staleTime: 30_000 }),
    /** The same `owner/actions` read the Activity page makes, glanced at by the frame for an action whose outcome is unknown. */
    ownerActionsGlance: queryOptions({ queryKey: [...key, "owner-actions"], queryFn: async () => answered(await agent.ownerActions()), retry: false, staleTime: 30_000 }),
    /** One recorded run of the autopilot, by its tick ID (#136). */
    recording: (tick: string) => queryOptions({ queryKey: [...key, "runs", tick], queryFn: async () => answered(await agent.recording(tick)), retry: false }),
    /** One operation's status by its `correlationId`, asked for by a click on its row. */
    operation: (correlationId: string) => queryOptions({ queryKey: [...key, "operations", correlationId], queryFn: async () => answered(await agent.operation(correlationId)), retry: false }),
    strategy: queryOptions({ queryKey: [...key, "strategy"], queryFn: async () => answered(await agent.strategy()), retry: false }),
    autopilot: queryOptions({ queryKey: [...key, "autopilot"], queryFn: async () => answered(await agent.autopilot()), retry: false }),
    books: queryOptions({ queryKey: [...key, "books"], queryFn: async () => answered(await agent.books()), retry: false }),
    /** The funding account and the agent's own account, read as the owner reads above. */
    treasury: queryOptions({ queryKey: [...key, "treasury"], queryFn: async () => answered(await agent.treasury()).treasury, retry: false }),
    account: queryOptions({ queryKey: [...key, "account"], queryFn: async () => answered(await agent.account()), retry: false }),
    proposals: queryOptions({ queryKey: [...key, "proposals"], queryFn: async () => answered(await agent.proposals()).proposals, retry: false,
      refetchInterval: 30_000 }),
    /**
     * The agent's open DAO requests (#130): its consent and its verdicts on proposals. Answered from the server's own store,
     * so it costs the platform nothing; not read again within half a minute, and read every half minute while it lists something
     * (a vote settles on its own). Read again as soon as a consent or a verdict is filed.
     */
    daoRequests: queryOptions({ queryKey: [...key, "dao-requests"], queryFn: async () => answered(await agent.daoRequests()).requests, retry: false, staleTime: 30_000,
      refetchInterval: query => query.state.data?.length ? 30_000 : false }),
    /** One proposal, and for a DAO the DAO's vote on it while one waits: read again while either may change on its own. */
    proposal: (id: string) => queryOptions({ queryKey: [...key, "proposals", id], queryFn: async () => answered(await agent.proposal(id)),
      retry: false, refetchInterval: query => !query.state.data ? false : MOVING.has(query.state.data.proposal.state) ? 5_000 : query.state.data.vote ? 30_000 : false }),
  };
}

/**
 * Reads the portfolio anew: shown, it's read again now; not shown, it's read when it next is. A read is repeated only
 * once it's a minute old (`main.tsx`), so after a swap or a shield the portfolio would otherwise show the book from
 * before it for up to that long.
 */
export function refreshPortfolio(client: QueryClient, reads: ReturnType<typeof agentReads>) {
  for (const read of [reads.overview, reads.activity, reads.held, reads.unresolved, reads.runs, reads.books, reads.proposals, reads.strategy, reads.autopilot, reads.daoRequests])
    void client.invalidateQueries({ queryKey: read.queryKey });
}

/** The setup reads: the signed-in account's own treasuries, and a DAO's setup, read again every half minute while it waits for the vote. */
export const setupReads = {
  mine: queryOptions({ queryKey: ["setup"], queryFn: async () => answered(await api.setups()), retry: false }),
  dao: (dao: string) => queryOptions({ queryKey: ["setup", "dao", dao], queryFn: async () => answered(await api.daoSetup(dao)), retry: false,
    refetchInterval: query => query.state.data?.request ? 30_000 : false }),
};

/** After a session ends anywhere, every read is answered `not_signed_in`: the identity is read again, so the page signs in. */
export function onSessionEnded(client: QueryClient, error: unknown, failed: readonly unknown[]) {
  if (failed[2] !== "identity" && failureOf(error)?.kind === "not_signed_in")
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === failed[0] && query.queryKey[1] === failed[1] && query.queryKey[2] === "identity" });
}
