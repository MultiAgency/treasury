import type { Secret } from "../config.ts";
import type { AssistantContext } from "../contract.ts";

/** A JSON Schema for a tool's input, as the model is given it. */
export type InputSchema = { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
export type ToolDefinition = { name: string; description: string; input_schema: InputSchema };

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
/** A turn of the conversation: the owner's words or the tools' results, or the model's text and tool calls. */
export type Message =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: string | (TextBlock | ToolUseBlock)[] };
/** Why an answer stopped: finished, asking for tools, cut off at its token limit, or refused by the provider. */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

/** One request to the model: the frozen instructions, the tools and the conversation so far, the newest turn last. */
export type ModelRequest = { system: string; tools: ToolDefinition[]; messages: Message[]; context?: AssistantContext };
/** What the assistant reads of an answer: its content, why it stopped, and the model that wrote it. */
export type ModelReply = { content: (TextBlock | ToolUseBlock)[]; stop_reason: StopReason; model: string };

/**
 * The assistant's model, behind one interface (#219): NEAR AI Cloud in production (`nearAiModel`), a scripted stand-in
 * in tests. It is given only what one question needs (the tools' results for that question) and holds no key or
 * credential of the treasury's: the API key is the model provider's, and it never reaches the browser.
 */
export type AssistantModel = { name: string; respond(request: ModelRequest): Promise<ModelReply> };

/**
 * The model the assistant uses unless `TREASURY_ASSISTANT_MODEL` names another: one of NEAR AI Cloud's private TEE
 * models, which run in NEAR's enclaves (Intel TDX and NVIDIA confidential computing), where neither NEAR nor anyone else
 * sees the prompts or outputs; the one NEAR's docs use for client-managed tool calls.
 */
export const DEFAULT_ASSISTANT_MODEL = "Qwen/Qwen3.8-27B";
export const NEAR_AI_URL = "https://cloud-api.near.ai/v1/chat/completions";

/** The model's turns in OpenAI's chat format, which NEAR AI Cloud takes: one `tool` message for each tool result. */
function chatMessages(system: string, messages: readonly Message[]) {
  const chat: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") { chat.push({ role: message.role, content: message.content }); continue; }
    if (message.role === "user") {
      for (const result of message.content) chat.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.is_error ? `Error: ${result.content}` : result.content });
      continue;
    }
    const text = message.content.filter((block): block is TextBlock => block.type === "text").map(block => block.text).join("\n\n");
    const calls = message.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
    chat.push({ role: "assistant", content: text || null,
      ...(calls.length > 0 && { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }) });
  }
  return chat;
}

export type ChatChoice = {
  finish_reason: string | null;
  message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
};
const STOP: Record<string, StopReason> = { tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** An answer in OpenAI's chat format, read back as the assistant's: a tool input that isn't JSON stays a string, which its tool refuses. */
export function replyOf(body: { model?: string; choices?: ChatChoice[] }, fallbackModel: string): ModelReply {
  const choice = body.choices?.[0];
  if (!choice) throw new Error("the model answered no choice");
  const content: (TextBlock | ToolUseBlock)[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = call.function.arguments;
    try { input = JSON.parse(call.function.arguments); } catch { /* left as text: the tool's own check refuses it */ }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const stop = STOP[choice.finish_reason ?? ""] ?? (content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn");
  return { content, stop_reason: stop, model: body.model ?? fallbackModel };
}

const RETRIED = new Set([429, 500, 502, 503, 504]);

/**
 * NEAR AI Cloud's OpenAI-compatible chat completions. A rate limit or a server error is tried twice more, a second and
 * then two apart; anything else throws, and the assistant answers `unavailable`. The key is sent only to NEAR AI Cloud.
 */
export function nearAiModel({ apiKey, model = DEFAULT_ASSISTANT_MODEL, timeoutMs = 120_000, fetch: send = fetch, retryMs = 1_000 }: {
  apiKey: Secret; model?: string; timeoutMs?: number; fetch?: typeof fetch; retryMs?: number;
}): AssistantModel {
  return {
    name: model,
    async respond({ system, tools, messages }) {
      const body = JSON.stringify({
        model, max_tokens: 16_000, messages: chatMessages(system, messages),
        tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      });
      for (let attempt = 0; ; attempt++) {
        const response = await send(NEAR_AI_URL, {
          method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.reveal()}` },
        });
        if (response.ok) return replyOf(await response.json() as { model?: string; choices?: ChatChoice[] }, model);
        if (!RETRIED.has(response.status) || attempt === 2) throw new Error(`NEAR AI Cloud answered ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, retryMs * (attempt + 1)));
      }
    },
  };
}
