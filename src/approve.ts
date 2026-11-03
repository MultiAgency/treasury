import type { OwnerOutput } from "@multiagency/sdk";
import type { Machine } from "./machine.ts";
import { follow, settle, type Leg, type Outcome, type Sent } from "./outcome.ts";

/**
 * The owner's approval, each under its own credential. The executor claims a saved plan at most once; a sweep is a
 * fresh action per call. Neither is ever sent again after an unknown or partial outcome.
 */
export async function execute(approve: Machine<"execute-plan">, planId: string, onEvent: (event: OwnerOutput<"executePlan">) => void): Promise<Outcome> {
  const legs: Leg[] = [], sent: Sent = { procedure: "executePlan", identity: { planId } };
  let rejected: string[] | null = null;
  const ended = await follow(approve.stream("executePlan", { planId }), event => {
    if (event.type === "rejected") rejected = event.problems;
    else legs.push({ index: event.index, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode, ...(event.shield && { shield: event.shield }) });
    onEvent(event);
  }, sent);
  return settle(ended, legs, rejected, sent);
}

/** Previews (`execute: false`) or shields the agent's managed public balances. */
export async function sweep(sweeper: Machine<"sweep">, execute: boolean, onEvent: (event: OwnerOutput<"sweep">) => void): Promise<Outcome> {
  const legs: Leg[] = [], sent: Sent = { procedure: "sweep", identity: { execute } };
  const ended = await follow(sweeper.stream("sweep", { execute }), event => {
    if (event.type === "shield") legs.push({ asset: event.asset, status: event.status, correlationId: event.correlationId, failureCode: event.failureCode });
    onEvent(event);
  }, sent);
  // A preview takes no money lock and returns after its plan event, before any dispatch (the platform's
  // `src/treasury.ts:157`, `:172` at 1a7fe98): a lost preview is a lost read.
  if (!execute && !ended.ok && ended.kind === "unknown") return { ok: false, kind: "unavailable" };
  return settle(ended, legs, null, sent);
}
