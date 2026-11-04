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
    consent: queryOptions({ queryKey: [...key, "consent"], queryFn: async () => answered(await agent.consent()).consent, retry: false }),
    proposals: queryOptions({ queryKey: [...key, "proposals"], queryFn: async () => answered(await agent.proposals()).proposals, retry: false,
      refetchInterval: 30_000 }),
    proposal: (id: string) => queryOptions({ queryKey: [...key, "proposals", id], queryFn: async () => answered(await agent.proposal(id)).proposal,
      retry: false, refetchInterval: query => query.state.data && MOVING.has(query.state.data.state) ? 5_000 : false }),
  };
}

/** After a session ends anywhere, every read is answered `not_signed_in`: the identity is read again, so the page signs in. */
export function onSessionEnded(client: QueryClient, error: unknown, failed: readonly unknown[]) {
  if (failed[2] !== "identity" && failureOf(error)?.kind === "not_signed_in")
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === failed[0] && query.queryKey[1] === failed[1] && query.queryKey[2] === "identity" });
}
