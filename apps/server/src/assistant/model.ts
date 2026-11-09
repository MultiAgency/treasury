import Anthropic from "@anthropic-ai/sdk";
import type { Secret } from "../config.ts";

/** One request to the model: the frozen instructions, the tools and the conversation so far, the newest turn last. */
export type ModelRequest = { system: string; tools: Anthropic.Beta.BetaTool[]; messages: Anthropic.Beta.BetaMessageParam[] };
/** What the assistant reads of an answer: its content, why it stopped, and the model that wrote it. */
export type ModelReply = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason" | "model">;

/**
 * The assistant's model, behind one interface (#219): Claude in production (`claudeModel`), a scripted stand-in in tests.
 * It is given only what one question needs (the tools' results for that question) and holds no key or credential of
 * the treasury's: the API key is the model provider's, and it never reaches the browser.
 */
export type AssistantModel = { name: string; respond(request: ModelRequest): Promise<ModelReply> };

/** The model the assistant uses unless `TREASURY_ASSISTANT_MODEL` names another. */
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-5-5";

/**
 * Claude through the Messages API. The instructions and the tools never change between questions, so they are cached
 * (the last tool and the system prompt carry the breakpoints); everything after them is the question's own. Effort is
 * `medium`: answers read records and do arithmetic over them, not long reasoning. A refused request is re-run by the
 * API on the fallback its refusal category calls for (`fallbacks: "default"`); one still refused is reported as such.
 */
export function claudeModel({ apiKey, model = DEFAULT_ASSISTANT_MODEL, timeoutMs = 120_000 }: { apiKey: Secret; model?: string; timeoutMs?: number }): AssistantModel {
  const client = new Anthropic({ apiKey: apiKey.reveal(), timeout: timeoutMs, maxRetries: 2 });
  return {
    name: model,
    async respond({ system, tools, messages }) {
      const cached = tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool);
      const reply = await client.beta.messages.create({
        model,
        max_tokens: 16_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: cached,
        messages,
      });
      return { content: reply.content, stop_reason: reply.stop_reason, model: reply.model };
    },
  };
}
