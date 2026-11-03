import { ownerClient, type OwnerClient, type OwnerFailure, type OwnerInputs, type OwnerOutput, type OwnerProcedure, type OwnerResult } from "@multiagency/sdk";
import { token, type Config, type Granted, type Role } from "./config.ts";

/**
 * What each machine credential scope reaches on `/machine/v1` (the platform's `src/gateway/machine-auth.ts` at 1a7fe98).
 * Scopes don't imply one another: preparing doesn't permit executing, and executing doesn't permit reading.
 */
export const SCOPES = {
  read: ["instance", "overview", "policyHistory", "strategy/get", "autopilot/get", "activity", "unresolved", "autopilot/evidence", "autopilot/log", "ledger", "ledgerCsv"],
  prepare: ["rebalance", "externalPlan"],
  "execute-plan": ["executePlan"],
  sweep: ["sweep"],
} as const satisfies Record<string, readonly OwnerProcedure[]>;
export type Scope = keyof typeof SCOPES;

type Reach<S extends Scope> = (typeof SCOPES)[S][number];
type Streamed = Parameters<OwnerClient["stream"]>[0];
type Args<P extends OwnerProcedure> = undefined extends OwnerInputs[P] ? [input?: OwnerInputs[P]] : [input: OwnerInputs[P]];

/** Type-only: which scopes a client was issued with. Generic methods alone don't stop one client standing in for another's. */
declare const granted: unique symbol;

/**
 * `ownerClient` narrowed to the procedures a credential's scopes reach, so a call outside them doesn't compile. A client
 * is usable where a subset of its scopes is expected, never where another scope is.
 */
export type Machine<S extends Scope> = {
  readonly [granted]?: { readonly [K in S]: true };
  call<P extends Exclude<Reach<S>, Streamed>>(path: P, ...input: Args<P>): Promise<OwnerResult<OwnerOutput<P>>>;
  stream<P extends Extract<Reach<S>, Streamed>>(path: P, input: OwnerInputs[P]): AsyncGenerator<OwnerOutput<P>, OwnerFailure | undefined>;
};

/** The agent's machine route under the role's bearer credential, reaching only the scopes that role is issued with. */
export function machine<R extends Role>({ origin, agent }: Config, role: R, env: NodeJS.ProcessEnv = process.env): Machine<Granted<R>> {
  const bearer = token(role, env);
  return ownerClient({ base: `${origin}/machine/v1/a/${agent}` as `https://${string}`, fetch: (input, init) => fetch(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${bearer}` }, credentials: "omit", redirect: "error" }) });
}
