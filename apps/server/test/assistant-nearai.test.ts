import { test } from "node:test";
import assert from "node:assert/strict";
import { Secret } from "../src/config.ts";
import { DEFAULT_ASSISTANT_MODEL, NEAR_AI_URL, nearAiModel, replyOf, type ChatChoice, type ModelRequest } from "../src/assistant/model.ts";

/** A fake `fetch` answering each call with the next of `answers`, recording what was sent. */
function fakeFetch(answers: { status: number; body?: unknown }[]) {
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) });
    const answer = answers[sent.length - 1];
    if (!answer) throw new Error("no more answers");
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const chat = (message: ChatChoice["message"], finish_reason: string, model = DEFAULT_ASSISTANT_MODEL) => ({ status: 200, body: { model, choices: [{ finish_reason, message }] } });

const REQUEST: ModelRequest = {
  system: "the instructions",
  tools: [{ name: "get_overview", description: "the book", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
  messages: [
    { role: "user", content: "What's the book worth?" },
    { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "call_1", name: "get_overview", input: {} }, { type: "tool_use", id: "call_2", name: "get_strategy", input: { limit: 2 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"usd\":1}" }, { type: "tool_result", tool_use_id: "call_2", content: "spent", is_error: true }] },
  ],
};

test("a request reaches NEAR AI Cloud in OpenAI's chat format, with the key only in its header", async () => {
  const { fetch, sent } = fakeFetch([chat({ content: "It's worth $1 [S1]." }, "stop")]);
  const reply = await nearAiModel({ apiKey: new Secret("sk-test"), fetch }).respond(REQUEST);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, NEAR_AI_URL);
  assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.ok(!JSON.stringify(sent[0]!.body).includes("sk-test"), "the key isn't in the body");
  assert.equal(sent[0]!.body.model, "Qwen/Qwen3.8-27B");
  assert.deepEqual(sent[0]!.body.tools, [{ type: "function", function: { name: "get_overview", description: "the book", parameters: REQUEST.tools[0]!.input_schema } }]);
  assert.deepEqual(sent[0]!.body.messages, [
    { role: "system", content: "the instructions" },
    { role: "user", content: "What's the book worth?" },
    { role: "assistant", content: "Reading it.", tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_overview", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "get_strategy", arguments: "{\"limit\":2}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"usd\":1}" },
    { role: "tool", tool_call_id: "call_2", content: "Error: spent" },
  ]);
  assert.deepEqual(reply, { content: [{ type: "text", text: "It's worth $1 [S1]." }], stop_reason: "end_turn", model: DEFAULT_ASSISTANT_MODEL });
});

test("an answer is read back by why it stopped; a tool input that isn't JSON stays text for its tool to refuse", () => {
  const calls = { content: null, tool_calls: [{ id: "c1", function: { name: "get_overview", arguments: "{}" } }, { id: "c2", function: { name: "get_runs", arguments: "{not json" } }] };
  assert.deepEqual(replyOf(chat(calls, "tool_calls").body, "m"), { content: [
    { type: "tool_use", id: "c1", name: "get_overview", input: {} }, { type: "tool_use", id: "c2", name: "get_runs", input: "{not json" }], stop_reason: "tool_use", model: DEFAULT_ASSISTANT_MODEL });
  assert.equal(replyOf(chat(calls, "stop").body, "m").stop_reason, "tool_use", "tool calls whatever the finish reason says");
  assert.equal(replyOf(chat({ content: "cut" }, "length").body, "m").stop_reason, "max_tokens");
  assert.equal(replyOf(chat({ content: "" }, "content_filter").body, "m").stop_reason, "refusal");
  assert.equal(replyOf({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] }, "fallback").model, "fallback");
  assert.throws(() => replyOf({ choices: [] }, "m"), /no choice/);
});

test("a rate limit or server error is tried twice more; anything else, or a third failure, throws without the key", async () => {
  const retried = fakeFetch([{ status: 429 }, { status: 503 }, chat({ content: "ok" }, "stop")]);
  assert.equal((await nearAiModel({ apiKey: new Secret("sk-test"), fetch: retried.fetch, retryMs: 0 }).respond(REQUEST)).content[0]?.type, "text");
  assert.equal(retried.sent.length, 3);

  const exhausted = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(nearAiModel({ apiKey: new Secret("sk-test"), fetch: exhausted.fetch, retryMs: 0 }).respond(REQUEST), (error: Error) => error.message === "NEAR AI Cloud answered 500");
  assert.equal(exhausted.sent.length, 3);

  const refused = fakeFetch([{ status: 401 }]);
  await assert.rejects(nearAiModel({ apiKey: new Secret("sk-test"), fetch: refused.fetch, retryMs: 0 }).respond(REQUEST),
    (error: Error) => error.message === "NEAR AI Cloud answered 401" && !error.message.includes("sk-test"));
  assert.equal(refused.sent.length, 1, "a refusal isn't retried");
});
