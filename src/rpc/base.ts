import { AgentApiError } from "@near-intents-agent-api/sdk";
import { ORPCError, os as base } from "@orpc/server";
import { refusalDetails } from "../provider-display.js";
/**
 * Errors reach the page with their message: this server answers only its own page on loopback, and
 * behind the hosted gateway only signed-in accounts with the required owner's capabilities. An Agent
 * API refusal keeps its code (`policy_change_throttled`, ...) for the page to branch on, and for a
 * throttle, quota or schedule refusal when it can be tried again (`availableAt`).
 */
function toClientError(error: unknown) {
  if (error instanceof ORPCError) return error;
  if (error instanceof AgentApiError)
    return new ORPCError("BAD_REQUEST", { message: error.detail ?? error.title, data: { code: error.code, availableAt: null, ...refusalDetails(error) } });
  return new ORPCError("BAD_REQUEST", { message: error instanceof Error ? error.message : String(error) });
}

export const os = base.use(async ({ next }) => {
  try {
    const result = await next();
    const output: unknown = result.output;
    if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return result;
    // A stream's errors are thrown after next() resolves, so they are converted where they occur.
    const stream = output as AsyncIterable<unknown>;
    async function* converted() {
      try {
        yield* stream;
      } catch (error) {
        throw toClientError(error);
      }
    }
    return { ...result, output: converted() as typeof result.output };
  } catch (error) {
    throw toClientError(error);
  }
});
