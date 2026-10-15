import { AgentApi, type StatusResponse } from "@near-intents-agent-api/sdk";
// Applies this instance's settings file before anything reads them: every entry point reaches the API.
import "./env.js";

const apiKey = process.env.NEAR_INTENTS_AGENT_API_KEY;
if (!apiKey) throw new Error("NEAR_INTENTS_AGENT_API_KEY is not set (see .env.example)");

const API_ORIGIN = new URL(process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.demo.agentsonintents.com").origin;
export const api = new AgentApi({
  apiKey,
  baseUrl: API_ORIGIN,
});

const MOVING = new Set<StatusResponse["status"]>(["PROCESSING", "QUEUED"]);

/** Still on its way: a status that says nothing yet about how the operation ends. */
export const isMoving = (status: StatusResponse["status"]) => MOVING.has(status);

/** The provider answered a status read for another operation or agent: evidence something is wrong, not a failed read. */
export class StatusMismatch extends Error {
  constructor() { super("Provider returned another operation or agent; preserve the original outcome and investigate"); }
}

/** Bind every status observation to the requested operation before applying financial effects. */
function checkedStatus<T extends { correlation_id: string; agent_id?: string | null }>(id: string, status: T): T {
  if (status.correlation_id !== id || (process.env.AGENT_ID && status.agent_id && status.agent_id !== process.env.AGENT_ID)) {
    throw new StatusMismatch();
  }
  return status;
}

/**
 * One status read, bound to the operation asked about. With `waitMs` the provider holds the request until
 * the status is final or needs a signature, or the wait ends: one call instead of polling.
 */
export const readStatus = async (id: string, waitMs?: number) =>
  checkedStatus(id, await api.getStatus(id, { ...(waitMs && { waitMs }), signal: AbortSignal.timeout(30_000 + (waitMs ?? 0)) }));

/** Polls until the operation stops moving; UNCERTAIN/NEEDS_REVIEW are returned, never retried. */
export async function waitForStatus(correlationId: string, signal = AbortSignal.timeout(180_000)) {
  while (true) {
    signal.throwIfAborted();
    const status = checkedStatus(correlationId, await api.getStatus(correlationId, { waitMs: 30_000, signal }));
    if (!isMoving(status.status)) return status;
  }
}
